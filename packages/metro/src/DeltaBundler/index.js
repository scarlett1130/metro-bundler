/**
 * Copyright (c) 2015-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 * @format
 */

'use strict';

const DeltaCalculator = require('./DeltaCalculator');
const DeltaTransformer = require('./DeltaTransformer');

import type Bundler from '../Bundler';
import type {BundleOptions} from '../shared/types.flow';
import type {
  DeltaResult,
  Graph as CalculatorGraph,
  Options,
} from './DeltaCalculator';

export type MainOptions = {|
  getPolyfills: ({platform: ?string}) => $ReadOnlyArray<string>,
  polyfillModuleNames: $ReadOnlyArray<string>,
|};

export type Delta = DeltaResult;
export type Graph = CalculatorGraph;

/**
 * `DeltaBundler` uses the `DeltaTransformer` to build bundle deltas. This
 * module handles all the transformer instances so it can support multiple
 * concurrent clients requesting their own deltas. This is done through the
 * `clientId` param (which maps a client to a specific delta transformer).
 */
class DeltaBundler {
  _bundler: Bundler;
  _options: MainOptions;
  _deltaTransformers: Map<string, DeltaTransformer> = new Map();
  _currentId: number = 0;
  _deltaCalculators: Map<Graph, DeltaCalculator> = new Map();

  constructor(bundler: Bundler, options: MainOptions) {
    this._bundler = bundler;
    this._options = options;
  }

  end() {
    this._deltaTransformers.forEach(DeltaTransformer => DeltaTransformer.end());
    this._deltaTransformers = new Map();

    this._deltaCalculators.forEach(deltaCalculator => deltaCalculator.end());
    this._deltaCalculators = new Map();
  }

  endTransformer(clientId: string) {
    const deltaTransformer = this._deltaTransformers.get(clientId);

    if (deltaTransformer) {
      deltaTransformer.end();

      this._deltaTransformers.delete(clientId);
    }
  }

  async getDeltaTransformer(
    clientId: string,
    options: BundleOptions,
  ): Promise<DeltaTransformer> {
    let deltaTransformer = this._deltaTransformers.get(clientId);

    if (!deltaTransformer) {
      deltaTransformer = await DeltaTransformer.create(
        this._bundler,
        this._options,
        options,
      );

      this._deltaTransformers.set(clientId, deltaTransformer);
    }

    return deltaTransformer;
  }

  async buildGraph(options: Options): Promise<Graph> {
    const depGraph = await this._bundler.getDependencyGraph();

    const deltaCalculator = new DeltaCalculator(
      this._bundler,
      depGraph,
      options,
    );

    await deltaCalculator.getDelta({reset: true});
    const graph = deltaCalculator.getGraph();

    this._deltaCalculators.set(graph, deltaCalculator);

    return graph;
  }

  async getDelta(graph: Graph, {reset}: {reset: boolean}): Promise<Delta> {
    const deltaCalculator = this._deltaCalculators.get(graph);

    if (!deltaCalculator) {
      throw new Error('Graph not found');
    }

    return await deltaCalculator.getDelta({reset});
  }

  listen(graph: Graph, callback: () => mixed) {
    const deltaCalculator = this._deltaCalculators.get(graph);

    if (!deltaCalculator) {
      throw new Error('Graph not found');
    }

    deltaCalculator.on('change', callback);
  }

  endGraph(graph: Graph) {
    const deltaCalculator = this._deltaCalculators.get(graph);

    if (!deltaCalculator) {
      throw new Error('Graph not found');
    }

    deltaCalculator.end();

    this._deltaCalculators.delete(graph);
  }
}

module.exports = DeltaBundler;

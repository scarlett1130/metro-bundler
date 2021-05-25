/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 * @format
 */

'use strict';

const generate = require('../worker/generate');
const mergeSourceMaps = require('../worker/mergeSourceMaps');
const nullthrows = require('nullthrows');
const reverseDependencyMapReferences = require('./reverse-dependency-map-references');

const {addParamsToDefineCall} = require('metro-transform-plugins');
const virtualModule = require('../module').virtual;

// flowlint-next-line untyped-import:off
const {passthroughSyntaxPlugins} = require('metro-react-native-babel-preset');
const {parseSync, transformFromAstSync} = require('@babel/core');
const HermesParser = require('hermes-parser');

import type {Dependency, IdsForPathFn, Module} from '../types.flow';
import type {BasicSourceMap} from 'metro-source-map';

// Transformed modules have the form
//   __d(function(require, module, global, exports, dependencyMap) {
//       /* code */
//   });
//
// This function adds the numeric module ID, and an array with dependencies of
// the dependencies of the module before the closing parenthesis.
function addModuleIdsToModuleWrapper(
  module: Module,
  idForPath: ({path: string, ...}) => number,
): string {
  const {dependencies, file} = module;
  const {code} = file;

  // calling `idForPath` on the module itself first gives us a lower module id
  // for the file itself than for its dependencies. That reflects their order
  // in the bundle.
  const fileId = idForPath(file);

  const paramsToAdd = [fileId];

  if (dependencies.length) {
    paramsToAdd.push(dependencies.map(idForPath));
  }

  return addParamsToDefineCall(code, ...paramsToAdd);
}

exports.addModuleIdsToModuleWrapper = addModuleIdsToModuleWrapper;

type InlineModuleIdsOptions = $ReadOnly<{
  dependencyMapReservedName: ?string,
  globalPrefix: string,
  ignoreMissingDependencyMapReference?: boolean,
  hermesParser?: boolean,
}>;

// TS detection conditions copied from metro-react-native-babel-preset
function isTypeScriptSource(fileName) {
  return !!fileName && fileName.endsWith('.ts');
}

function isTSXSource(fileName) {
  return !!fileName && fileName.endsWith('.tsx');
}

function inlineModuleIds(
  module: Module,
  idForPath: ({path: string, ...}) => number,
  {
    dependencyMapReservedName,
    globalPrefix,
    ignoreMissingDependencyMapReference = false,
    hermesParser = false,
  }: InlineModuleIdsOptions,
): {
  moduleCode: string,
  moduleMap: ?BasicSourceMap,
  fileId: number,
} {
  const {dependencies, file} = module;
  const {code, map, path} = file;

  // calling `idForPath` on the module itself first gives us a lower module id
  // for the file itself than for its dependencies. That reflects their order
  // in the bundle.
  const fileId = idForPath(file);
  const dependencyIds = dependencies.map(idForPath);

  if (!dependencyIds.length) {
    // Nothing to inline in this module.
    return {fileId, moduleCode: code, moduleMap: map};
  }

  if (dependencyMapReservedName != null) {
    /**
     * Fast path for inlining module IDs as a cheap string operation, requiring
     * neither parsing nor any adjustment to the source map.
     *
     * Assumptions:
     * 1. `dependencyMapReservedName` is a globally reserved string; there are
     *    no false positives.
     * 2. The longest module ID in the bundle does not exceed a length of
     *    `dependencyMapReservedName.length + 3`. (We assert this below.)
     * 3. False negatives (failing to inline occasionally if an assumption
     *    isn't met) are rare to nonexistent, but safe if they do occur.
     *
     * Syntax definitions:
     * 1. A dependency map reference is a member expression which, if parsed,
     *    would have the form:
     *      MemberExpression
     *      ├──object: Identifier (name = dependencyMapReservedName)
     *      ├──property: NumericLiteral (value = some integer)
     *      └──computed: true
     * 2. The concrete form of a dependency map reference may contain embedded
     *    tabs or spaces, but no newlines (which would complicate source maps),
     *    parens (which would complicate detection) or comments (likewise).
     * 3. The numeric literal in a dependency map reference is a base-10
     *    integer printed as a simple sequence of digits.
     */
    if (!code.includes(dependencyMapReservedName)) {
      if (ignoreMissingDependencyMapReference) {
        return {fileId, moduleCode: code, moduleMap: map};
      }

      // If we're here, the module was probably generated by some code that
      // doesn't make the dependency map name externally configurable, or a
      // mock that needs to be updated.
      throw new Error(
        `Module has dependencies but does not use the preconfigured dependency map name '${dependencyMapReservedName}': ${file.path}\n` +
          'This is an internal error in Metro.',
      );
    }
    const WS = '[\t ]*';
    const depMapReferenceRegex = new RegExp(
      escapeRegex(dependencyMapReservedName) + `${WS}\\[${WS}([0-9]+)${WS}\\]`,
      'g',
    );
    const inlinedCode = code.replace(
      depMapReferenceRegex,
      (match, depIndex) => {
        const idStr = dependencyIds[Number.parseInt(depIndex, 10)].toString();
        if (idStr.length > match.length) {
          // Stop the build rather than silently emit an incorrect source map.
          throw new Error(
            `Module ID doesn't fit in available space; add ${idStr.length -
              match.length} more characters to 'dependencyMapReservedName'.`,
          );
        }
        return idStr.padEnd(match.length);
      },
    );
    return {
      fileId,
      moduleCode: inlinedCode,
      moduleMap: map,
    };
  }

  const babelConfig = {
    ast: true,
    babelrc: false,
    browserslistConfigFile: false,
    code: false,
    configFile: false,
    plugins: [
      ...passthroughSyntaxPlugins,
      [reverseDependencyMapReferences, {dependencyIds, globalPrefix}],
    ],
  };

  const sourceAst =
    isTypeScriptSource(path) || isTSXSource(path) || !hermesParser
      ? parseSync(code, babelConfig)
      : HermesParser.parse(code, {
          babel: true,
          sourceType: babelConfig.sourceType,
        });

  const ast = nullthrows(
    transformFromAstSync(sourceAst, code, babelConfig).ast,
  );

  const {code: generatedCode, map: generatedMap} = generate(ast, path, '');

  return {
    fileId,
    moduleCode: generatedCode,
    moduleMap: map && generatedMap && mergeSourceMaps(path, map, generatedMap),
  };
}

function inlineModuleIdsAndAddParamsToDefineCall(
  module: Module,
  idForPath: ({path: string, ...}) => number,
  options: InlineModuleIdsOptions,
): {
  moduleCode: string,
  moduleMap: ?BasicSourceMap,
} {
  const {fileId, moduleCode, moduleMap} = inlineModuleIds(
    module,
    idForPath,
    options,
  );

  return {moduleCode: addParamsToDefineCall(moduleCode, fileId), moduleMap};
}

exports.inlineModuleIds = inlineModuleIds;
exports.inlineModuleIdsAndAddParamsToDefineCall = inlineModuleIdsAndAddParamsToDefineCall;

function escapeRegex(str: string): string {
  // From http://stackoverflow.com/questions/14076210/
  return str.replace(/([.?*+^$[\]\\(){}|-])/g, '\\$1');
}

type IdForPathFn = ({path: string, ...}) => number;

/**
 * 1. Adds the module ids to a file if the file is a module. If it's not (e.g.
 *    a script) it just keeps it as-is.
 * 2. Packs the function map into the file's source map, if one exists.
 */
function getModuleCodeAndMap(
  module: Module,
  idForPath: IdForPathFn,
  options: $ReadOnly<{
    enableIDInlining: boolean,
    dependencyMapReservedName: ?string,
    globalPrefix: string,
  }>,
): {|
  moduleCode: string,
  moduleMap: ?BasicSourceMap,
|} {
  const {file} = module;
  let moduleCode, moduleMap;

  if (file.type !== 'module') {
    moduleCode = file.code;
    moduleMap = file.map;
  } else if (!options.enableIDInlining) {
    moduleCode = addModuleIdsToModuleWrapper(module, idForPath);
    moduleMap = file.map;
  } else {
    ({moduleCode, moduleMap} = inlineModuleIdsAndAddParamsToDefineCall(
      module,
      idForPath,
      {
        dependencyMapReservedName: options.dependencyMapReservedName,
        globalPrefix: options.globalPrefix,
      },
    ));
  }
  if (moduleMap && moduleMap.sources) {
    const x_facebook_sources = [];
    if (moduleMap.sources.length >= 1) {
      x_facebook_sources.push([module.file.functionMap]);
    }
    moduleMap = {...moduleMap, x_facebook_sources};
  }
  // $FlowFixMe[incompatible-return]
  return {moduleCode, moduleMap};
}

exports.getModuleCodeAndMap = getModuleCodeAndMap;

// Concatenates many iterables, by calling them sequentially.
exports.concat = function* concat<T>(
  ...iterables: Array<Iterable<T>>
): Iterable<T> {
  for (const it of iterables) {
    yield* it;
  }
};

// Creates an idempotent function that returns numeric IDs for objects based
// on their `path` property.
exports.createIdForPathFn = (): (({path: string, ...}) => number) => {
  const seen = new Map();
  let next = 0;
  return ({path}) => {
    let id = seen.get(path);
    if (id == null) {
      id = next++;
      seen.set(path, id);
    }
    return id;
  };
};

// creates a series of virtual modules with require calls to the passed-in
// modules.
exports.requireCallsTo = function*(
  modules: Iterable<Module>,
  idForPath: IdForPathFn,
  getRunModuleStatement: (id: number | string) => string,
): Iterable<Module> {
  for (const module of modules) {
    const id = idForPath(module.file);
    yield virtualModule(
      getRunModuleStatement(id),
      `/<generated>/require-${id}.js`,
    );
  }
};

// Divides the modules into two types: the ones that are loaded at startup, and
// the ones loaded deferredly (lazy loaded).
exports.partition = (
  modules: Iterable<Module>,
  preloadedModules: Set<string>,
): Array<Array<Module>> => {
  const startup = [];
  const deferred = [];
  for (const module of modules) {
    (preloadedModules.has(module.file.path) ? startup : deferred).push(module);
  }

  return [startup, deferred];
};

// Transforms a new Module object into an old one, so that it can be passed
// around code.
// NOTE: Used only for RAM bundle serialization.
function toModuleTransport(
  module: Module,
  idsForPath: IdsForPathFn,
  {
    dependencyMapReservedName,
    globalPrefix,
  }: {dependencyMapReservedName: ?string, globalPrefix: string},
): {
  code: string,
  dependencies: Array<Dependency>,
  id: number,
  map: ?BasicSourceMap,
  name: string,
  sourcePath: string,
  ...
} {
  const {dependencies, file} = module;
  const {moduleCode, moduleMap} = getModuleCodeAndMap(
    module,
    (x: {path: string, ...}) => idsForPath(x).moduleId,
    {
      dependencyMapReservedName,
      enableIDInlining: true,
      globalPrefix,
    },
  );

  return {
    code: moduleCode,
    dependencies,
    // ID is required but we provide an invalid one for "script"s.
    id: file.type === 'module' ? nullthrows(idsForPath(file).localId) : -1,
    map: moduleMap,
    name: file.path,
    sourcePath: file.path,
  };
}
exports.toModuleTransport = toModuleTransport;

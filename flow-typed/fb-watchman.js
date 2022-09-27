/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 * @format
 * @oncall react_native
 */

declare module 'fb-watchman' {
  declare type WatchmanWatchResponse = $ReadOnly<{
    watch: string,
    relative_path: string,
    ...
  }>;

  declare type SavedStateInfo = $ReadOnly<{
    'manifold-path': ?string,
    'manifold-bucket': ?string,
    error: ?string,
  }>;

  declare type WatchmanFile = $ReadOnly<{
    name: string,
    exists: boolean,
    mtime_ms?: number | $ReadOnly<{toNumber: () => number}>,
    size?: number,
    'content.sha1hex'?: string,
  }>;

  declare type WatchmanQueryResponse = $ReadOnly<{
    'saved-state-info'?: SavedStateInfo,
    files: $ReadOnlyArray<WatchmanFile>,
    clock: {
      scm: {'mergebase-with': string, mergebase: string},
      clock: string,
    },
    is_fresh_instance: boolean,
    version: string,
    warning?: string,
  }>;

  declare type WatchmanDirnameExpression = ['dirname' | 'idirname', string];

  declare type WatchmanMatchExpression =
    | ['match' | 'imatch', string]
    | ['match' | 'imatch', string, 'basename' | 'wholename']
    | [
        'match' | 'imatch',
        string,
        'basename' | 'wholename',
        $ReadOnly<{includedotfiles?: boolean, noescape?: boolean}>,
      ];

  declare type WatchmanNotExpression = ['not', WatchmanExpression];

  declare type WatchmanSuffixExpression = [
    'suffix',
    string | $ReadOnlyArray<string>,
  ];

  declare type WatchmanTypeExpression = ['type', 'f'];

  // Would be ['allof' | 'anyof', ...WatchmanExpression] if Flow supported
  // variadic tuples
  declare type WatchmanVariadicExpression = Array<
    'allof' | 'anyof' | WatchmanExpression,
  >;

  declare type WatchmanExpression =
    | WatchmanDirnameExpression
    | WatchmanMatchExpression
    | WatchmanNotExpression
    | WatchmanSuffixExpression
    | WatchmanTypeExpression
    | WatchmanVariadicExpression;

  declare type WatchmanQuerySince =
    | string
    | $ReadOnly<{
        scm: $ReadOnly<{
          'mergebase-with': string,
          'saved-state'?: {
            storage: string,
            config: {project: string, ...},
          },
        }>,
      }>;

  declare type WatchmanQuery = {
    expression: WatchmanExpression,
    fields: $ReadOnlyArray<string>,
    glob?: $ReadOnlyArray<string>,
    glob_includedotfiles?: boolean,
    path?: $ReadOnlyArray<string>,
    // A repo-root-relative path to a subdirectory within which
    // the query will be constrained.  Returned file names in
    // WatchmanFile will be relative to this location.
    relative_root?: string,
    since?: WatchmanQuerySince,
    suffix?: string | $ReadOnlyArray<string>,
  };

  declare class Client {
    capabilityCheck(
      config: $ReadOnly<{
        optional?: $ReadOnlyArray<string>,
        required?: $ReadOnlyArray<string>,
      }>,
      callback: (
        error: ?Error,
        response: ?{
          version: string,
          capabilities: $ReadOnly<{[string]: boolean}>,
        },
      ) => void,
    ): void;
    command(
      config: ['watch-project', string],
      callback: (error: ?Error, response: WatchmanWatchResponse) => void,
    ): void;
    command(
      config: ['query', string, WatchmanQuery],
      callback: (error: ?Error, response: WatchmanQueryResponse) => void,
    ): void;
    command(
      config: ['find', string, string],
      callback: (error: ?Error, response: WatchmanQueryResponse) => void,
    ): void;
    end(): void;
  }

  declare module.exports: {Client: Class<Client>};
}

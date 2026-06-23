// Type declarations for bts-raw-read-config.mjs (the SSoT is plain .mjs so
// eslint.config.mjs can import it at config-load time without a TS loader; these
// declarations give the .ts consumers — the self-test and drift test — full
// type safety).

import type { Linter } from 'eslint';

export const privateMindstoneSourceGlobs: readonly string[];

export const BTS_RAW_READ_FILES: readonly string[];

export const BTS_RAW_READ_IGNORES: readonly string[];

export const BTS_RAW_READ_SEVERITY: 'error';

export const BTS_RAW_READ_PARSER_NAME: '@typescript-eslint/parser';

export const BTS_RAW_READ_PARSER_OPTIONS: Linter.ParserOptions;

export function btsRawReadLanguageOptions(
  parser: Linter.Parser,
): Linter.LanguageOptions;

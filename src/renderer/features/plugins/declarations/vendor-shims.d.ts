/**
 * Type declaration shims for third-party modules used by the plugin compiler
 * and test fixtures that don't ship their own TypeScript declarations.
 */

declare module 'sucrase/dist/parser/index' {
  export function parse(
    input: string,
    isJSXEnabled: boolean,
    isTypeScriptEnabled: boolean,
    isFlowEnabled: boolean,
  ): { tokens: Array<{ type: unknown; start: number; end: number; [key: string]: unknown }> };
}

declare module 'sucrase/dist/parser/tokenizer/types' {
  export const TokenType: Record<string, unknown>;
}

declare module 'lodash' {
  export function sortBy<T>(collection: T[], ...iteratees: unknown[]): T[];
  const _: unknown;
  export default _;
}

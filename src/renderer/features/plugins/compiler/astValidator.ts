import { parse } from 'sucrase/dist/parser/index';
import { TokenType } from 'sucrase/dist/parser/tokenizer/types';
import { ALLOWED_PLUGIN_REQUIRE_MODULES } from './importRewriter';
import type { PluginCompileError } from './types';

type ParsedToken = ReturnType<typeof parse>['tokens'][number];

const ALLOWED_REQUIRE_SET = new Set<string>(ALLOWED_PLUGIN_REQUIRE_MODULES);

interface SourceLocation {
  line: number;
  column: number;
}

interface ErrorWithLocation {
  message?: string;
  loc?: {
    line?: number;
    column?: number;
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'Unknown validation error.';
}

function getLineAndColumnFromOffset(source: string, offset: number): SourceLocation {
  let line = 1;
  let lastLineBreakIndex = -1;

  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10) {
      line += 1;
      lastLineBreakIndex = i;
    }
  }

  return {
    line,
    column: offset - lastLineBreakIndex,
  };
}

function getSnippetForLine(source: string, line?: number): string | undefined {
  if (line === undefined || line < 1) {
    return undefined;
  }

  const lines = source.split(/\r?\n/);
  return lines[line - 1];
}

function createValidationError(
  message: string,
  fullSource: string,
  location?: SourceLocation,
): PluginCompileError {
  const snippet = getSnippetForLine(fullSource, location?.line);

  return {
    type: 'validation',
    message,
    line: location?.line,
    column: location?.column,
    snippet,
    fullSource,
  };
}

function isTokenType(token: ParsedToken | undefined, type: typeof TokenType[keyof typeof TokenType]): token is ParsedToken {
  return token !== undefined && token.type === type;
}

function isNameToken(code: string, token: ParsedToken | undefined, expectedName: string): boolean {
  if (!isTokenType(token, TokenType.name)) {
    return false;
  }

  return code.slice(token.start, token.end) === expectedName;
}

function isAssignmentToken(token: ParsedToken | undefined): boolean {
  return isTokenType(token, TokenType.eq) || isTokenType(token, TokenType.assign);
}

function getStringLiteralValue(code: string, token: ParsedToken | undefined): string | undefined {
  if (!isTokenType(token, TokenType.string)) {
    return undefined;
  }

  const rawLiteral = code.slice(token.start, token.end);
  if (rawLiteral.length < 2) {
    return undefined;
  }

  return rawLiteral.slice(1, -1);
}

function hasDefaultExport(code: string, tokens: ParsedToken[]): boolean {
  for (let i = 0; i < tokens.length; i += 1) {
    if (
      isNameToken(code, tokens[i], 'exports') &&
      isTokenType(tokens[i + 1], TokenType.dot) &&
      isNameToken(code, tokens[i + 2], 'default') &&
      isAssignmentToken(tokens[i + 3])
    ) {
      return true;
    }

    if (
      isNameToken(code, tokens[i], 'module') &&
      isTokenType(tokens[i + 1], TokenType.dot) &&
      isNameToken(code, tokens[i + 2], 'exports') &&
      isAssignmentToken(tokens[i + 3])
    ) {
      return true;
    }

    if (
      isNameToken(code, tokens[i], 'module') &&
      isTokenType(tokens[i + 1], TokenType.dot) &&
      isNameToken(code, tokens[i + 2], 'exports') &&
      isTokenType(tokens[i + 3], TokenType.dot) &&
      isNameToken(code, tokens[i + 4], 'default') &&
      isAssignmentToken(tokens[i + 5])
    ) {
      return true;
    }
  }

  return false;
}

function validateRequireCalls(
  code: string,
  tokens: ParsedToken[],
  fullSource: string,
): PluginCompileError[] {
  const errors: PluginCompileError[] = [];
  const allowedModules = ALLOWED_PLUGIN_REQUIRE_MODULES.join(', ');

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!isNameToken(code, token, 'require')) {
      continue;
    }

    const previousToken = tokens[i - 1];
    if (isTokenType(previousToken, TokenType.dot) || isTokenType(previousToken, TokenType.questionDot)) {
      continue;
    }

    if (!isTokenType(tokens[i + 1], TokenType.parenL)) {
      continue;
    }

    const moduleToken = tokens[i + 2];
    const location = getLineAndColumnFromOffset(code, token.start);

    if (!isTokenType(moduleToken, TokenType.string)) {
      errors.push(
        createValidationError(
          'require() must use a static string literal module specifier.',
          fullSource,
          location,
        ),
      );
      continue;
    }

    const moduleName = getStringLiteralValue(code, moduleToken);
    if (moduleName === undefined) {
      errors.push(
        createValidationError(
          'require() must use a valid string literal module specifier.',
          fullSource,
          location,
        ),
      );
      continue;
    }

    if (!ALLOWED_REQUIRE_SET.has(moduleName)) {
      errors.push(
        createValidationError(
          `Disallowed require() module "${moduleName}". Allowed modules: ${allowedModules}.`,
          fullSource,
          location,
        ),
      );
    }
  }

  return errors;
}

/**
 * Global identifiers that plugins are not allowed to reference directly.
 * These are blocked as standalone identifiers (not preceded by a dot).
 *
 * Layer 1: API surface lockdown — prevents access to host globals.
 * Layer 3: Static network restrictions — prevents network API usage.
 *
 * Note: This is defense-in-depth for accidental misuse and honest attempts.
 * Known bypasses accepted for team-sharing trust level:
 * - `Function('return this')()`, `(0, eval)('this')`, constructor chaining
 * - Bracket notation: `window['api']`, `document['cookie']`, etc.
 * - Optional chaining: `document?.cookie`
 * These require iframe sandboxing (Stage 14) to fully prevent.
 */
const FORBIDDEN_GLOBAL_IDENTIFIERS: Record<string, string> = {
  // Layer 1: API surface lockdown
  globalThis: 'globalThis is not allowed in plugins.',
  window: 'window is not allowed in plugins.',
  self: 'self is not allowed in plugins.',
  localStorage: 'localStorage is not allowed in plugins.',
  sessionStorage: 'sessionStorage is not allowed in plugins.',
  indexedDB: 'indexedDB is not allowed in plugins.',
  // Layer 3: Static network restrictions
  fetch: 'fetch() is not allowed in plugins.',
  XMLHttpRequest: 'XMLHttpRequest is not allowed in plugins.',
  WebSocket: 'WebSocket is not allowed in plugins.',
  EventSource: 'EventSource is not allowed in plugins.',
};

function validateForbiddenPatterns(
  code: string,
  tokens: ParsedToken[],
  fullSource: string,
): PluginCompileError[] {
  const errors: PluginCompileError[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];

    if (
      isNameToken(code, token, 'eval') &&
      isTokenType(tokens[i + 1], TokenType.parenL) &&
      !isTokenType(tokens[i - 1], TokenType.dot) &&
      !isTokenType(tokens[i - 1], TokenType.questionDot)
    ) {
      const location = getLineAndColumnFromOffset(code, token.start);
      errors.push(createValidationError('eval() is not allowed in plugins.', fullSource, location));
    }

    if (
      isNameToken(code, token, 'document') &&
      isTokenType(tokens[i + 1], TokenType.dot) &&
      (isNameToken(code, tokens[i + 2], 'write') || isNameToken(code, tokens[i + 2], 'writeln')) &&
      isTokenType(tokens[i + 3], TokenType.parenL)
    ) {
      const methodName = code.slice(tokens[i + 2].start, tokens[i + 2].end);
      const location = getLineAndColumnFromOffset(code, token.start);
      errors.push(createValidationError(`document.${methodName}() is not allowed in plugins.`, fullSource, location));
    }

    // Block document.cookie access
    if (
      isNameToken(code, token, 'document') &&
      isTokenType(tokens[i + 1], TokenType.dot) &&
      isNameToken(code, tokens[i + 2], 'cookie') &&
      !isTokenType(tokens[i - 1], TokenType.dot) &&
      !isTokenType(tokens[i - 1], TokenType.questionDot)
    ) {
      const location = getLineAndColumnFromOffset(code, token.start);
      errors.push(createValidationError('document.cookie is not allowed in plugins.', fullSource, location));
    }

    // Block navigator.sendBeacon (network exfiltration)
    if (
      isNameToken(code, token, 'navigator') &&
      isTokenType(tokens[i + 1], TokenType.dot) &&
      isNameToken(code, tokens[i + 2], 'sendBeacon') &&
      !isTokenType(tokens[i - 1], TokenType.dot) &&
      !isTokenType(tokens[i - 1], TokenType.questionDot)
    ) {
      const location = getLineAndColumnFromOffset(code, token.start);
      errors.push(createValidationError('navigator.sendBeacon() is not allowed in plugins.', fullSource, location));
    }

    // Block Function constructor (equivalent to eval)
    if (
      isNameToken(code, token, 'Function') &&
      isTokenType(tokens[i + 1], TokenType.parenL) &&
      !isTokenType(tokens[i - 1], TokenType.dot) &&
      !isTokenType(tokens[i - 1], TokenType.questionDot)
    ) {
      const location = getLineAndColumnFromOffset(code, token.start);
      errors.push(createValidationError('new Function() / Function() is not allowed in plugins.', fullSource, location));
    }

    // Block setTimeout/setInterval with string argument (implicit eval)
    if (
      (isNameToken(code, token, 'setTimeout') || isNameToken(code, token, 'setInterval')) &&
      isTokenType(tokens[i + 1], TokenType.parenL) &&
      isTokenType(tokens[i + 2], TokenType.string)
    ) {
      const location = getLineAndColumnFromOffset(code, token.start);
      errors.push(createValidationError(`${code.slice(token.start, token.end)}() with string argument is not allowed (use a function instead).`, fullSource, location));
    }

    // Block dynamic import() — network exfiltration vector (e.g. import('https://evil.com'))
    // Sucrase uses TokenType._import for the import keyword, not TokenType.name.
    if (
      isTokenType(token, TokenType._import) &&
      isTokenType(tokens[i + 1], TokenType.parenL)
    ) {
      const location = getLineAndColumnFromOffset(code, token.start);
      errors.push(createValidationError('Dynamic import() is not allowed in plugins.', fullSource, location));
    }

    if (isTokenType(token, TokenType.dot) || isTokenType(token, TokenType.questionDot)) {
      if (
        isNameToken(code, tokens[i + 1], 'innerHTML') ||
        isNameToken(code, tokens[i + 1], 'outerHTML') ||
        isNameToken(code, tokens[i + 1], 'insertAdjacentHTML')
      ) {
        const propName = code.slice(tokens[i + 1].start, tokens[i + 1].end);
        const location = getLineAndColumnFromOffset(code, tokens[i + 1].start);
        errors.push(createValidationError(`${propName} is not allowed in plugins.`, fullSource, location));
      }
    }

    if (
      isTokenType(token, TokenType.bracketL) &&
      isTokenType(tokens[i + 2], TokenType.bracketR) &&
      i > 0 && (isTokenType(tokens[i - 1], TokenType.name) || isTokenType(tokens[i - 1], TokenType.parenR))
    ) {
      const literalValue = getStringLiteralValue(code, tokens[i + 1]);
      if (literalValue === 'innerHTML' || literalValue === 'outerHTML' || literalValue === 'insertAdjacentHTML') {
        const location = getLineAndColumnFromOffset(code, tokens[i + 1].start);
        errors.push(createValidationError(`${literalValue} is not allowed in plugins.`, fullSource, location));
      }
    }

    // Block forbidden global identifiers (Layers 1 & 3)
    if (isTokenType(token, TokenType.name)) {
      const tokenText = code.slice(token.start, token.end);
      const forbiddenMessage = FORBIDDEN_GLOBAL_IDENTIFIERS[tokenText];
      if (
        forbiddenMessage &&
        !isTokenType(tokens[i - 1], TokenType.dot) &&
        !isTokenType(tokens[i - 1], TokenType.questionDot)
      ) {
        const location = getLineAndColumnFromOffset(code, token.start);
        errors.push(createValidationError(forbiddenMessage, fullSource, location));
      }
    }
  }

  return errors;
}

export function validatePluginAst(code: string, fullSource: string): PluginCompileError[] {
  let tokens: ParsedToken[];

  try {
    tokens = parse(code, false, false, false).tokens;
  } catch (error) {
    const typedError = error as ErrorWithLocation;
    const location =
      typedError.loc?.line !== undefined && typedError.loc?.column !== undefined
        ? {
            line: typedError.loc.line,
            column: typedError.loc.column,
          }
        : undefined;

    return [
      createValidationError(
        `Failed to parse compiled plugin output: ${getErrorMessage(error)}`,
        fullSource,
        location,
      ),
    ];
  }

  const errors: PluginCompileError[] = [];

  if (!hasDefaultExport(code, tokens)) {
    errors.push(
      createValidationError(
        'Plugin must provide a default export via exports.default or module.exports.',
        fullSource,
        { line: 1, column: 1 },
      ),
    );
  }

  errors.push(...validateRequireCalls(code, tokens, fullSource));
  errors.push(...validateForbiddenPatterns(code, tokens, fullSource));

  return errors;
}

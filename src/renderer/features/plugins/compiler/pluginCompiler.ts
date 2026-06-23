import { transform, type Transform } from 'sucrase';
import { rewritePluginRequires, autoImportBarePluginHooks } from './importRewriter';
import { validatePluginAst } from './astValidator';
import type { PluginCompileError, PluginCompileResult, PluginCompileWarning } from './types';

const SUCRASE_TRANSFORMS: Transform[] = ['typescript', 'jsx', 'imports'];

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
  return 'Unknown compilation error.';
}

function getSnippetForLine(source: string, line?: number): string | undefined {
  if (line === undefined || line < 1) {
    return undefined;
  }

  const lines = source.split(/\r?\n/);
  return lines[line - 1];
}

function createCompileError(error: unknown, fullSource: string): PluginCompileError {
  const typedError = error as ErrorWithLocation;
  const line = typedError.loc?.line;
  const column = typedError.loc?.column;

  return {
    type: 'compile',
    message: getErrorMessage(error),
    line,
    column,
    snippet: getSnippetForLine(fullSource, line),
    fullSource,
  };
}

/**
 * Heuristic warning for `.map()` callbacks that use the iteration variable
 * directly as a React key (e.g. `key={item}` instead of `key={item.id}`).
 *
 * Runs on the **original TSX source** (not compiled output) because Sucrase's
 * automatic JSX runtime extracts `key` into a separate argument, making it
 * invisible in the compiled props object.
 */
function detectSuspiciousKeys(tsxSource: string): PluginCompileWarning[] {
  const warnings: PluginCompileWarning[] = [];

  // Match .map( with arrow or function callback capturing the first param name
  const mapCallbacks = tsxSource.matchAll(
    /\.map\(\s*(?:function\s*\(|(?:\()?\s*)(\w+)/g
  );

  for (const match of mapCallbacks) {
    const iterVar = match[1];
    if (!iterVar || iterVar === '_' || iterVar.length < 2) continue;

    // Look for key={iterVar} in JSX (not key={iterVar.something})
    const keyPattern = new RegExp(`key=\\{\\s*${iterVar}\\s*\\}`, 'g');
    if (keyPattern.test(tsxSource)) {
      warnings.push({
        type: 'suspicious-key',
        message:
          `[pluginCompiler] Suspicious React key detected: "${iterVar}" is used directly as a key in a .map() callback. ` +
          `If "${iterVar}" is an object, this will produce [object Object] keys. ` +
          `Use a unique string property like key={${iterVar}.id} instead.`,
      });
    }
  }

  return warnings;
}

export function compilePluginSource(source: string): PluginCompileResult {
  let compiledCode: string;

  try {
    compiledCode = transform(source, {
      transforms: SUCRASE_TRANSFORMS,
      jsxRuntime: 'automatic',
      production: true,
    }).code;
  } catch (error) {
    return {
      ok: false,
      errors: [createCompileError(error, source)],
    };
  }

  const rewrittenCode = rewritePluginRequires(compiledCode);
  const autoImportedCode = autoImportBarePluginHooks(rewrittenCode);
  const validationErrors = validatePluginAst(autoImportedCode, source);

  if (validationErrors.length > 0) {
    return {
      ok: false,
      errors: validationErrors,
    };
  }

  const warnings = detectSuspiciousKeys(source);

  return {
    ok: true,
    code: autoImportedCode,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

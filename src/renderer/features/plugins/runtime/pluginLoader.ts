/**
 * Plugin Loader
 *
 * Compiles a TSX source string and extracts the default export React component.
 * Uses `new Function()` with a CJS module envelope since the compiler outputs CJS.
 *
 * @see docs/plans/260322_plugin_extension_system.md
 */

import type { ComponentType } from 'react';
import type { PluginCompileError } from '../compiler/types';

export interface PluginLoadSuccess {
  ok: true;
  component: ComponentType;
  revision: number;
}

export interface PluginLoadFailure {
  ok: false;
  errors: PluginCompileError[];
}

export type PluginLoadResult = PluginLoadSuccess | PluginLoadFailure;

let globalRevision = 0;

export async function loadPlugin(source: string, pluginId?: string): Promise<PluginLoadResult> {
  // Lazy-load the compiler so Sucrase isn't pulled in at module init time.
  // This avoids issues with Vite dev server and deep CJS imports.
  const { compilePluginSource } = await import('../compiler/pluginCompiler');
  const compiled = compilePluginSource(source);
  if (!compiled.ok) return compiled;

  try {
    // Wrap compiled CJS in a module envelope.
    // __REBEL_MODULES__ is passed as a frozen parameter so plugin code
    // resolves modules via the function argument rather than globalThis.

    const factory = new Function(
      'exports', 'module', '__REBEL_MODULES__',
      `${compiled.code}\n//# sourceURL=rebel-plugin${pluginId ? `-${pluginId}` : ''}.js`
    );
    const moduleExports: Record<string, unknown> = {};
    const moduleObj = { exports: moduleExports };
    const moduleRegistry = Object.freeze({ ...globalThis.__REBEL_MODULES__ });
    factory(moduleExports, moduleObj, moduleRegistry);

    const component = (moduleObj.exports as Record<string, unknown>).default ?? moduleObj.exports;

    if (typeof component !== 'function') {
      return {
        ok: false,
        errors: [{
          type: 'runtime' as const,
          message: `Plugin default export is not a function/component (got ${typeof component})`,
          fullSource: source,
        }],
      };
    }

    globalRevision++;
    return { ok: true, component: component as ComponentType, revision: globalRevision };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      errors: [{
        type: 'runtime' as const,
        message: `Runtime error loading plugin: ${message}`,
        fullSource: source,
      }],
    };
  }
}

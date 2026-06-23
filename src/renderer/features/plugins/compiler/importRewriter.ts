export const ALLOWED_PLUGIN_REQUIRE_MODULES = [
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  '@rebel/plugin-api',
  '@rebel/plugin-ui',
] as const;

/**
 * Known plugin API hook names that may be referenced by AI-generated plugins
 * without a proper `import` statement. Keep in sync with pluginApiFactory.ts
 * and pluginSecurityReview.ts PLUGIN_HOOK_NAMES.
 */
export const KNOWN_PLUGIN_HOOKS = [
  'usePluginStorage',
  'usePluginStorageWithVersion',
  'useMemorySearch',
  'useSources',
  'useSourceDocument',
  'useTopics',
  'useEntities',
  'useTopicContent',
  'useSkillFile',
  'useAi',
  'useMeetings',
  'useGoals',
  'useClipboard',
  'useRebelEvent',
  'usePreTurnHook',
  'usePostTurnHook',
  'useExternalFetch',
  'usePluginRoute',
  'useActiveSession',
  'useConversation',
  'useConversations',
  'useRebel',
] as const;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ALLOWED_MODULE_PATTERN = ALLOWED_PLUGIN_REQUIRE_MODULES.map(escapeRegExp).join('|');

const ALLOWED_REQUIRE_CALL_PATTERN = new RegExp(
  `require\\(\\s*(["'])(${ALLOWED_MODULE_PATTERN})\\1\\s*\\)`,
  'g',
);

export function rewritePluginRequires(code: string): string {
  return code.replace(
    ALLOWED_REQUIRE_CALL_PATTERN,
    (_match, _quote: string, moduleName: string) =>
      `__REBEL_MODULES__[${JSON.stringify(moduleName)}]`,
  );
}

/**
 * Auto-import safety net for AI-generated plugins.
 *
 * Detects bare references to known plugin API hooks (e.g. `useMemorySearch(`)
 * that were NOT imported via `import { ... } from '@rebel/plugin-api'`.
 * Rewrites those bare calls to `__autoPluginApi.hookName(` and injects a
 * single `var __autoPluginApi` declaration.
 *
 * This prevents `ReferenceError: hookName is not defined` crashes when
 * AI-generated plugin code omits the import statement.
 *
 * Must run AFTER `rewritePluginRequires()` so the
 * `__REBEL_MODULES__["@rebel/plugin-api"]` presence check is valid.
 *
 * @see https://mindstone.sentry.io/issues/7438473638 — REBEL-4Z5
 * @see https://mindstone.sentry.io/issues/7436314487 — REBEL-4GF
 */
export function autoImportBarePluginHooks(code: string): string {
  // If the compiled code already has a plugin API import (via require rewriting),
  // all hook references are property accesses (_pluginApi.hookName). Skip.
  if (code.includes('__REBEL_MODULES__["@rebel/plugin-api"]')) return code;

  // Detect bare hook calls: hookName( not preceded by . (property access)
  const bareHooks = KNOWN_PLUGIN_HOOKS.filter(hook => {
    const pattern = new RegExp(`(?<!\\.)\\b${hook}\\s*\\(`);
    return pattern.test(code);
  });

  if (bareHooks.length === 0) return code;

  // Rewrite bare hook calls → __autoPluginApi.hookName(
  let result = code;
  for (const hook of bareHooks) {
    result = result.replace(
      new RegExp(`(?<!\\.)\\b(${hook})(\\s*\\()`, 'g'),
      '__autoPluginApi.$1$2',
    );
  }

  // Insert var declaration after "use strict" directive (if present) to
  // preserve directive semantics. Sucrase always emits the directive.
  const preamble = 'var __autoPluginApi = __REBEL_MODULES__["@rebel/plugin-api"] || {};\n';
  const strictMatch = result.match(/^(['"])use strict\1;?/);
  if (strictMatch) {
    const pos = strictMatch[0].length;
    result = result.slice(0, pos) + preamble + result.slice(pos);
  } else {
    result = preamble + result;
  }

  return result;
}

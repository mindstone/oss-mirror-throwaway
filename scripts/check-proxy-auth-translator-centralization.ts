#!/usr/bin/env npx tsx
/**
 * Local-Model-Proxy auth + structured-output centralization CI check
 * (Stage 13 — docs/plans/260526_hotspot-refactor-roadmap/PLAN.md).
 *
 * Stage 13 consolidated TWO cross-handler invariants into single named helpers:
 *
 *   1. UPSTREAM AUTH — every passthrough/forwarding handler strips inbound
 *      client auth (`x-api-key` / `authorization`) and injects the
 *      upstream-correct credential. The ONLY sanctioned home is
 *      `src/main/services/localModelProxy/upstreamAuth.ts`
 *      (`injectUpstreamAuth` / `stripClientAuthHeaders`). PM 260430: the
 *      Anthropic passthrough was once the asymmetric outlier that forwarded the
 *      SDK sentinel `x-api-key: proxy-handles-auth` to api.anthropic.com → 401s.
 *
 *   2. STRUCTURED OUTPUT — every Anthropic→OpenAI translator branch turns
 *      inbound `output_format` into OpenAI `response_format.json_schema`. The
 *      ONLY sanctioned home is
 *      `src/main/services/localModelProxy/outputFormatTranslator.ts`
 *      (`applyAnthropicOutputFormat` /
 *      `translateAnthropicOutputFormatToOpenAIResponseFormat`). Investigation
 *      260509 / PM 260427: a branch silently dropped the translation and turned
 *      BTS structured output into prose.
 *
 * This script statically asserts that the RAW forms of each operation live ONLY
 * in the central modules — so a future handler / translator branch cannot
 * quietly re-introduce an inline asymmetric path. Comments and string literals
 * are stripped first so a prose mention (e.g. in a doc comment) does not satisfy
 * or trip the check.
 *
 * It is the proxy-side analogue of `check-bts-transport-symmetry.ts`.
 *
 * SCOPE / WHAT THIS DOES NOT CATCH: this is a *re-implementation* tripwire, not
 * a *coverage* guarantee. It proves the RAW auth/translation forms live ONLY in
 * the central modules — so a handler cannot inline an asymmetric path. It does
 * NOT prove that every branch actually CALLS the central helper: a branch that
 * silently DROPS `injectUpstreamAuth(...)` / `applyAnthropicOutputFormat(...)`
 * (the literal PM 260430 / 260509 shape) passes this check. That branch-level
 * coverage is guaranteed by the behavioural suites instead —
 * `localModelProxyServer.crossHandlerAuth.test.ts`, `.outputFormat.test.ts`,
 * `.codexSubscription.test.ts`, and the Stage-11 `localModelProxyServer.invariants.test.ts`.
 * Treat the two together as the full guard; do not over-trust this script alone.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const proxyDir = resolve(repoRoot, 'src/main/services');
const proxyServerFile = resolve(proxyDir, 'localModelProxyServer.ts');
const upstreamAuthFile = resolve(proxyDir, 'localModelProxy/upstreamAuth.ts');
const translatorFile = resolve(proxyDir, 'localModelProxy/outputFormatTranslator.ts');

/**
 * Strip `//` line comments and block comments so a marker regex can only match
 * real code, not a doc comment. String literals are deliberately KEPT intact:
 * the forbidden patterns reference HEADER-NAME string keys
 * (`headers['authorization']`) and a `` `Bearer `` template prefix, so blanking
 * string contents would erase exactly what we need to detect. The patterns are
 * code operators (`delete x[...]`, `x[...] = ...`, `function name(`), which do
 * not occur verbatim inside ordinary string contents in this file.
 */
function stripComments(source: string): string {
  return source
    // block comments
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // line comments (the `[^:]` guard avoids eating `://` inside a URL literal)
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

interface Violation {
  pattern: string;
  description: string;
  count: number;
}

/**
 * A forbidden raw pattern in `localModelProxyServer.ts`. Each must now be routed
 * through the corresponding central helper instead.
 */
const FORBIDDEN_IN_PROXY_SERVER: Array<{ regex: RegExp; description: string }> = [
  {
    // Raw strip of the client auth headers — must go through stripClientAuthHeaders / injectUpstreamAuth.
    regex: /\bdelete\s+\w+\s*\[\s*['"]?(?:x-api-key|authorization)['"]?\s*\]/gi,
    description:
      "raw `delete headers['x-api-key'|'authorization']` — route client-auth stripping through " +
      'injectUpstreamAuth() / stripClientAuthHeaders() in localModelProxy/upstreamAuth.ts (PM 260430 auth symmetry).',
  },
  {
    // Raw injection of an upstream Bearer credential — must go through injectUpstreamAuth.
    regex: /\b\w+\s*\[\s*['"]?[Aa]uthorization['"]?\s*\]\s*=\s*`Bearer/g,
    description:
      'raw `headers[\'Authorization\'] = `Bearer ...`` upstream-auth injection — route through ' +
      'injectUpstreamAuth({ kind: ... }) in localModelProxy/upstreamAuth.ts (auth symmetry, PM 260430).',
  },
  {
    // Raw injection of the Anthropic upstream x-api-key — must go through
    // injectUpstreamAuth. `=(?![=])` excludes the `===` comparison form so a
    // `headers['x-api-key'] === SENTINEL` read is not mistaken for an inject.
    regex: /\b\w+\s*\[\s*['"]?x-api-key['"]?\s*\]\s*=(?![=>])/gi,
    description:
      "raw `headers['x-api-key'] = ...` upstream-auth injection — route through " +
      'injectUpstreamAuth({ kind: \'anthropic-x-api-key\' }) in localModelProxy/upstreamAuth.ts (PM 260430).',
  },
  {
    // Raw OpenAI response_format json_schema construction — must go through the translator.
    regex: /\bresponse_format\s*=\s*translateAnthropicOutputFormatToOpenAIResponseFormat\s*\(/g,
    description:
      'raw `response_format = translateAnthropicOutputFormatToOpenAIResponseFormat(...)` — route through ' +
      'applyAnthropicOutputFormat(target, output_format) in localModelProxy/outputFormatTranslator.ts ' +
      '(investigation 260509 / PM 260427 structured-output drop).',
  },
  {
    // The translator function itself must not be (re)defined in the server file.
    regex: /\bfunction\s+translateAnthropicOutputFormatToOpenAIResponseFormat\s*\(/g,
    description:
      'the structured-output translator is defined in localModelProxyServer.ts — it must live ONLY in ' +
      'localModelProxy/outputFormatTranslator.ts (single home).',
  },
];

/**
 * Positive assertions: the central helpers must EXIST and be wired (so the check
 * fails loudly if a refactor deletes/renames them rather than vacuously passing
 * because the forbidden patterns are simply absent).
 */
const REQUIRED_CENTRAL_MARKERS: Array<{ file: string; label: string; regexes: RegExp[] }> = [
  {
    file: upstreamAuthFile,
    label: 'upstreamAuth.ts',
    regexes: [
      /export\s+function\s+injectUpstreamAuth\s*\(/,
      /export\s+function\s+stripClientAuthHeaders\s*\(/,
    ],
  },
  {
    file: translatorFile,
    label: 'outputFormatTranslator.ts',
    regexes: [
      /export\s+function\s+applyAnthropicOutputFormat\s*\(/,
      /export\s+function\s+translateAnthropicOutputFormatToOpenAIResponseFormat\s*\(/,
    ],
  },
];

/** The proxy server must IMPORT both central helpers (so it can't hand-roll them). */
const REQUIRED_PROXY_IMPORTS: RegExp[] = [
  /import\s*\{[^}]*\binjectUpstreamAuth\b[^}]*\}\s*from\s*['"]\.\/localModelProxy\/upstreamAuth['"]/,
  /import\s*\{[^}]*\bapplyAnthropicOutputFormat\b[^}]*\}\s*from\s*['"]\.\/localModelProxy\/outputFormatTranslator['"]/,
];

function main(): void {
  const errors: string[] = [];

  let proxySourceRaw: string;
  try {
    proxySourceRaw = readFileSync(proxyServerFile, 'utf8');
  } catch (err) {
    console.error(
      `Proxy auth/translator centralization check FAILED:\n  - cannot read ${proxyServerFile}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  const proxyCode = stripComments(proxySourceRaw);

  // 1. No forbidden raw patterns in the proxy server (outside the central modules).
  const violations: Violation[] = [];
  for (const { regex, description } of FORBIDDEN_IN_PROXY_SERVER) {
    const matches = proxyCode.match(regex);
    if (matches && matches.length > 0) {
      violations.push({ pattern: regex.source, description, count: matches.length });
    }
  }
  for (const v of violations) {
    errors.push(`[localModelProxyServer.ts] ${v.count}× ${v.description}`);
  }

  // 2. The proxy server imports both central helpers.
  for (const re of REQUIRED_PROXY_IMPORTS) {
    if (!re.test(proxySourceRaw)) {
      errors.push(
        `[localModelProxyServer.ts] missing required import matching \`${re.source}\` — ` +
          'the central helper is not wired in (refactor may have dropped it).',
      );
    }
  }

  // 3. The central helpers exist (fail loudly if renamed/removed).
  for (const { file, label, regexes } of REQUIRED_CENTRAL_MARKERS) {
    let src: string;
    try {
      src = readFileSync(file, 'utf8');
    } catch (err) {
      errors.push(`[${label}] central module missing or unreadable: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const re of regexes) {
      if (!re.test(src)) {
        errors.push(
          `[${label}] missing required export matching \`${re.source}\` — ` +
            'the single-home helper was renamed/removed; update the centralization contract.',
        );
      }
    }
  }

  if (errors.length > 0) {
    console.error('Proxy auth/translator centralization check FAILED:\n');
    for (const e of errors) console.error(`  - ${e}`);
    console.error(
      `\n${errors.length} centralization violation(s). ` +
        'Auth injection must route through localModelProxy/upstreamAuth.ts and structured-output ' +
        'translation through localModelProxy/outputFormatTranslator.ts.',
    );
    process.exit(1);
  }

  console.log(
    'Proxy auth/translator centralization check passed — no raw upstream-auth strip/inject or ' +
      'structured-output translation in localModelProxyServer.ts; both central helpers exist and are imported.',
  );
}

main();

#!/usr/bin/env npx tsx
/**
 * CI guard: every provider-proxy client construction in clientFactory.ts must make an
 * EXPLICIT, reviewed decision about SDK-level `maxRetries` — never silently inherit it.
 *
 * Why (the stacked dual-retry anti-pattern — PM 260619 Rec 3,
 * docs-private/postmortems/260619_offline_turn_stacked_retry_storm_and_watchdog_hang_postmortem.md):
 * The offline-hang incident's tight retry storm came from a provider proxy whose Anthropic SDK
 * client SILENTLY INHERITED the SDK default `maxRetries` (≈2) while our own `runWithRetry`
 * (MAX_RETRIES=3) ALSO retried the same request — two stacked retry layers over one call. Only the
 * Codex proxy was given `maxRetries: 0`; OpenRouter never was, so an offline-masked-as-500 churned
 * ~9 fast attempts/turn. `AnthropicClient` only forwards `maxRetries` when the factory passes it
 * (clients/anthropicClient.ts ~1133: `...(config.maxRetries !== undefined ? { maxRetries } : {})`),
 * so OMITTING it == opting INTO the SDK default == stacking. A future provider proxy added without
 * thinking about this re-introduces the storm.
 *
 * What this asserts (raw-text scan of clientFactory.ts):
 *   Every provider-proxy DISCRIMINATOR boolean — declared by the file's own convention as
 *   `const is<Name>Proxy = proxyConfig.defaultHeaders?....` (the in-code comment at the
 *   PRECEDENCE-1 block literally instructs new-provider authors to add an `isNewProxy`) — must
 *   EITHER:
 *     (a) participate in a `maxRetries: 0` decision (its name appears in the same construction's
 *         `maxRetries: 0` ternary/expression — delegating retries to runWithRetry), OR
 *     (b) carry a documented exemption: an entry in RETRY_STACKING_EXEMPT below (keyed by the
 *         discriminator name, with a non-empty reason) — for a proxy that INTENTIONALLY keeps the
 *         SDK retry while the combined-attempt budget is measured.
 *
 * The goal is by-construction: adding a NEW `is<Name>Proxy` discriminator FAILS this gate unless the
 * author makes (and documents) the maxRetries decision — so the dual-retry stack cannot be silently
 * re-created. It is NOT "must be 0" — OpenRouter intentionally keeps the SDK default pending the
 * deferred retry-amplification measurement (PM 260619 Rec 2); the exemption keeps that decision
 * explicit and reviewed.
 *
 * SCOPE / WHAT THIS DOES NOT CATCH: this is a decision-tripwire, not a runtime-attempt-count proof.
 * It guarantees the maxRetries decision is MADE per proxy discriminator; the actual bounded
 * worst-case attempt count across SDK × runWithRetry is asserted by the whole-turn offline
 * regression test (PM 260619 Rec 1 / Stage 2). Treat the two together as the full guard.
 *
 * RECOGNIZED DECISION FORMS (the condition that DIRECTLY applies `{ maxRetries: 0 }`): the spread
 * conditional `...(isX ? { maxRetries: 0 } : {})` (today's shape), a multi-condition guard
 * `((isX || isY) ? { maxRetries: 0 } : {})`, and a hoisted-const `const r = isX ? { maxRetries: 0 }
 * : {}`. Only `is<Name>Proxy` tokens in THAT condition count as deciding — a discriminator named in an
 * unrelated sibling spread in the same constructor does NOT (GPT-5.5 F1). Forms the extractor does NOT
 * recognise (e.g. a bare `if (isX) { … maxRetries: 0 }` block, or `maxRetries: SOME_CONST` via an
 * indirection variable) fail CONSERVATIVELY — the discriminator reads as "undecided" and the gate
 * fails LOUDLY telling the author to use the canonical spread form or add an exemption. That is a
 * deliberate, self-explaining false-positive (a visible nudge to the reviewable shape), never a silent
 * miss — the safe direction for a tripwire. Deliberately not a full TS AST parse (PM 260619 Rec 4
 * explicitly warned a heavy AST guard is over-engineering for this narrow, stable seam).
 *
 * KNOWN RESIDUAL (accepted): a proxy added off the `is<Name>Proxy` convention (e.g. a local named
 * `vendorXActive`) is not discovered as a discriminator, so a NON-conventional proxy COEXISTING with a
 * decided conventional one could slip. This is narrow and backstopped by the surrounding code: the
 * in-code comment at the PRECEDENCE-1 block mandates the `is<Name>Proxy` naming, and a proxy added
 * off-convention also breaks the auth-symmetry path (`proxyHandlesAuth` / check-proxy-auth-translator-
 * centralization). Closing it fully would need AST parsing of every `proxyConfig.defaultHeaders` read
 * regardless of name — cost not warranted (PM 260619 Rec 4).
 *
 * Modeled on scripts/check-capability-resolution-dispatch-seam.ts (pure exported checker + guarded
 * CLI side-effect) and scripts/check-proxy-auth-translator-centralization.ts (raw/comment-stripped
 * scan of a single chokepoint file).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIENT_FACTORY = path.join('src', 'core', 'rebelCore', 'clientFactory.ts');

/**
 * Provider-proxy discriminators that INTENTIONALLY keep the SDK-default `maxRetries` (i.e. do NOT
 * set `maxRetries: 0`), with the documented reason. An entry here is a reviewed, explicit decision
 * to let the SDK retry layer stack over runWithRetry for that proxy.
 *
 * Adding an entry must be a deliberate, reviewed act — that is the whole point: it forces the
 * maxRetries decision to be surfaced in code review for every proxy.
 */
export const RETRY_STACKING_EXEMPT: Readonly<Record<string, string>> = {
  // OpenRouter (and the council/ad-hoc route-table proxy that shares the same AnthropicClient
  // construction) intentionally keeps the SDK-default maxRetries pending the deferred
  // retry-amplification measurement (PM 260619 Rec 2 / the maxRetries:0-for-OpenRouter decision is
  // waiting-for-signal). The offline storm above BOTH layers is already short-circuited by the
  // fail-fast offline gate (fix 71e3a096e), so flipping the SDK layer to 0 is a measure-first
  // tuning decision, not a correctness fix. Keep this exemption until that measurement lands.
  isOpenRouterProxy:
    'Intentionally keeps SDK-default maxRetries pending the deferred retry-amplification ' +
    'measurement (PM 260619 Rec 2). The offline storm is already gated above both retry layers ' +
    'by the fail-fast offline check (71e3a096e); flipping to 0 is measure-first tuning.',
  isRouteTableProxy:
    'Council/ad-hoc route-table proxy shares the PRECEDENCE-1 AnthropicClient construction with ' +
    'OpenRouter and inherits the same measure-first posture (PM 260619 Rec 2).',
};

/** A discriminator that resolved its maxRetries decision via `maxRetries: 0` (delegating to runWithRetry). */
export interface ResolvedZeroDiscriminator {
  readonly name: string;
}

export interface RetryStackingViolation {
  readonly discriminator: string;
  readonly message: string;
}

/**
 * The PRECEDENCE-1 proxy-identity discriminator convention: `const is<Name>Proxy = proxyConfig...`.
 * The `is` prefix + `Proxy` suffix is the file's documented naming convention for "this request
 * routes through the local proxy as provider <Name>" (see the in-code comment instructing authors
 * to add an `isNewProxy`). Keyed on the assignment to `proxyConfig.defaultHeaders` so a same-named
 * local elsewhere can't accidentally register.
 */
const DISCRIMINATOR_DECL_RE = /\bconst\s+(is[A-Z][A-Za-z0-9]*Proxy)\s*=\s*[^;]*\bproxyConfig\.defaultHeaders\b/g;

const MAX_RETRIES_ZERO_RE = /maxRetries\s*:\s*0\b/g;
const PROXY_TOKEN_RE = /\bis[A-Z][A-Za-z0-9]*Proxy\b/g;

/**
 * Strip `//` line comments and `/* *\/` block comments so the discriminator/maxRetries scan can only
 * match real code. The exemption markers are read from the SEPARATE allowlist (not from comments),
 * so we don't need comment text for the decision — only for the doc context the reader sees.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // line comments — the `[^:]` guard avoids eating `://` inside a URL literal
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * The opening `{` index of the object literal that directly contains the `maxRetries: 0` literal at
 * `zeroIdx`. Walk left tracking brace depth; the first `{` seen at depth 0 (i.e. that isn't closed by
 * an intervening `}` to its right within our walk) opens the enclosing object. Returns -1 if not
 * found (malformed / unexpected shape → caller treats as "not decided", the safe direction).
 */
function enclosingObjectOpenBrace(code: string, zeroIdx: number): number {
  let depth = 0;
  for (let i = zeroIdx; i >= 0; i--) {
    const c = code[i];
    if (c === '}' || c === ')' || c === ']') depth++;
    else if (c === '{' || c === '(' || c === '[') {
      if (depth === 0) return c === '{' ? i : -1; // first opener at depth 0 must be `{`
      depth--;
    }
  }
  return -1;
}

/**
 * Extract ONLY the boolean guard expression that directly governs the object literal opening at
 * `objOpen` — i.e. the condition of the `COND ? { … } : …` ternary, `COND && { … }`, or
 * `if (COND) { … }` immediately to its left. Crucially this does NOT include sibling spread elements
 * earlier in the same constructor (e.g. `...(isOther ? { provider } : {}),` before the maxRetries
 * spread): the leftward scan stops at the nearest delimiter that bounds THIS conditional — a `(`
 * (the spread/group opener), `,` (previous object property / spread element), `;`, `{`, or `}`. That
 * boundary is what closes GPT-5.5 F1: a discriminator named in an unrelated sibling spread within the
 * same `return new AnthropicClient({...})` statement no longer counts as deciding maxRetries.
 *
 * Returns the guard substring (possibly empty if the object isn't conditionally guarded — e.g. a bare
 * `{ maxRetries: 0 }` with no condition, which names no discriminator and so decides nothing).
 */
function guardExpressionFor(code: string, objOpen: number): string {
  // Step left over whitespace before `{`.
  let i = objOpen - 1;
  while (i >= 0 && /\s/.test(code[i])) i--;
  if (i < 0) return '';

  // Ternary: `COND ? {` — consume the `?`, then the condition to its left.
  // `&&`: `COND && {` — consume `&&`.
  // if-block: `if (COND) {` — the char is `)`; capture the matching `(...)`.
  if (code[i] === ')') {
    // Balanced-paren capture of `(...)` to the left (covers `if (...)` and a parenthesised guard
    // that was directly followed by `{` — rare, but handled).
    let depth = 0;
    let j = i;
    for (; j >= 0; j--) {
      if (code[j] === ')') depth++;
      else if (code[j] === '(') {
        depth--;
        if (depth === 0) break;
      }
    }
    return j >= 0 ? code.slice(j + 1, i) : '';
  }

  if (code[i] === '?') {
    i--; // skip the `?`
  } else if (code[i] === '&' && code[i - 1] === '&') {
    i -= 2; // skip `&&`
  } else {
    // The object literal isn't a conditional value (e.g. a property value `extra: { maxRetries: 0 }`
    // or a bare object). Walk left to the nearest boundary and take that token span as the guard —
    // this covers the hoisted-const form `const extra = isX ? { maxRetries: 0 } : {}` where the
    // condition is still to the left within the same statement element.
  }

  // Now capture the condition expression to the left, bounded by the nearest delimiter that fences
  // this conditional from siblings: `(`, `,`, `;`, `{`, `}`. Balanced inner parens are kept.
  let depth = 0;
  let k = i;
  for (; k >= 0; k--) {
    const c = code[k];
    if (c === ')' || c === ']') depth++;
    else if (c === '(' || c === '[') {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && (c === ',' || c === ';' || c === '{' || c === '}')) {
      break;
    }
  }
  return code.slice(k + 1, i + 1);
}

/**
 * Discriminator names that the source resolves to `maxRetries: 0`. For each `maxRetries: 0` literal,
 * extract ONLY the boolean condition directly guarding its enclosing object literal (see
 * guardExpressionFor) and collect the `is<Name>Proxy` tokens in THAT condition — not the whole
 * statement. This precision closes both the neighbouring-declaration false-positive AND the
 * unrelated-sibling-spread false-negative (GPT-5.5 F1): a discriminator only counts as "decided" when
 * it is in the very condition that applies `{ maxRetries: 0 }`.
 */
function discriminatorsDecidedZero(code: string): Set<string> {
  const decided = new Set<string>();
  for (const m of code.matchAll(MAX_RETRIES_ZERO_RE)) {
    const zeroIdx = m.index ?? 0;
    const objOpen = enclosingObjectOpenBrace(code, zeroIdx);
    if (objOpen === -1) continue; // unexpected shape → not decided (safe direction)
    const guard = guardExpressionFor(code, objOpen);
    for (const t of guard.matchAll(PROXY_TOKEN_RE)) {
      decided.add(t[0]);
    }
  }
  return decided;
}

/**
 * Pure checker. Returns one violation per proxy discriminator that NEITHER resolves to
 * `maxRetries: 0` NOR carries a documented exemption — plus a synthetic violation if NO proxy
 * discriminator is found at all (the convention moved / block was refactored — re-verify by hand).
 */
export function checkProviderProxyRetryStacking(
  clientFactorySrc: string,
  exempt: Readonly<Record<string, string>> = RETRY_STACKING_EXEMPT,
): RetryStackingViolation[] {
  const violations: RetryStackingViolation[] = [];
  const code = stripComments(clientFactorySrc);

  const discriminators = [...code.matchAll(DISCRIMINATOR_DECL_RE)].map((m) => m[1]);
  const uniqueDiscriminators = [...new Set(discriminators)];

  if (uniqueDiscriminators.length === 0) {
    violations.push({
      discriminator: '',
      message:
        `${CLIENT_FACTORY}: found no provider-proxy discriminator (\`const is<Name>Proxy = ` +
        `proxyConfig.defaultHeaders?...\`). The PRECEDENCE-1 proxy block appears to have moved or ` +
        `been refactored. Update this guard and re-verify, by hand, that every provider proxy still ` +
        `makes an explicit maxRetries decision (maxRetries:0 OR a documented exemption).`,
    });
    return violations;
  }

  const decidedZero = discriminatorsDecidedZero(code);

  for (const name of uniqueDiscriminators) {
    const hasZeroDecision = decidedZero.has(name);
    const exemptReason = exempt[name];
    const hasExemption = typeof exemptReason === 'string' && exemptReason.trim().length > 0;
    if (hasZeroDecision && hasExemption) {
      violations.push({
        discriminator: name,
        message:
          `${CLIENT_FACTORY}: proxy discriminator \`${name}\` BOTH sets \`maxRetries: 0\` AND is in ` +
          `RETRY_STACKING_EXEMPT — contradictory. A proxy either delegates retries to runWithRetry ` +
          `(maxRetries:0, no exemption) or intentionally stacks (exemption, no maxRetries:0). Remove ` +
          `the exemption in scripts/check-provider-proxy-retry-stacking.ts.`,
      });
      continue;
    }
    if (!hasZeroDecision && !hasExemption) {
      violations.push({
        discriminator: name,
        message:
          `${CLIENT_FACTORY}: provider-proxy discriminator \`${name}\` makes NO explicit ` +
          `\`maxRetries\` decision. Its AnthropicClient construction will SILENTLY INHERIT the SDK ` +
          `default (~2 retries) while runWithRetry ALSO retries the same request — the stacked ` +
          `dual-retry storm (PM 260619). Either pass \`maxRetries: 0\` (delegate retries to ` +
          `runWithRetry) in the construction guarded by \`${name}\`, OR — if it must keep the SDK ` +
          `retry pending measurement — add \`${name}\` to RETRY_STACKING_EXEMPT in ` +
          `scripts/check-provider-proxy-retry-stacking.ts with a reason. Make the decision; don't ` +
          `inherit it.`,
      });
    }
  }

  // Stale-exemption ratchet: an exemption keyed to a discriminator that no longer exists is dead
  // weight that hides intent — flag it so the allowlist tracks reality.
  const discriminatorSet = new Set(uniqueDiscriminators);
  for (const name of Object.keys(exempt)) {
    if (!discriminatorSet.has(name)) {
      violations.push({
        discriminator: name,
        message:
          `RETRY_STACKING_EXEMPT has an entry for \`${name}\`, but no such proxy discriminator ` +
          `exists in ${CLIENT_FACTORY} anymore. Remove the stale exemption from ` +
          `scripts/check-provider-proxy-retry-stacking.ts.`,
      });
    }
  }

  return violations;
}

function readOrThrow(rel: string): string {
  const abs = path.join(process.cwd(), rel);
  if (!fs.existsSync(abs)) {
    throw new Error(`source not found at ${rel} — update this guard if the file moved.`);
  }
  return fs.readFileSync(abs, 'utf8');
}

export function main(): void {
  let clientFactorySrc: string;
  try {
    clientFactorySrc = readOrThrow(CLIENT_FACTORY);
  } catch (err) {
    console.error(`\n✗ check-provider-proxy-retry-stacking: ${(err as Error).message}\n`);
    process.exit(1);
  }

  const violations = checkProviderProxyRetryStacking(clientFactorySrc);
  if (violations.length > 0) {
    console.error(
      `\n✗ check-provider-proxy-retry-stacking:\n${violations.map((v) => `  - ${v.message}`).join('\n')}\n`,
    );
    process.exit(1);
  }

  const code = stripComments(clientFactorySrc);
  const discriminators = [...new Set([...code.matchAll(DISCRIMINATOR_DECL_RE)].map((m) => m[1]))];
  const zero = discriminatorsDecidedZero(code);
  const decidedZero = discriminators.filter((d) => zero.has(d));
  const exempted = discriminators.filter((d) => RETRY_STACKING_EXEMPT[d]);
  console.log(
    `✓ check-provider-proxy-retry-stacking: all ${discriminators.length} provider-proxy ` +
      `discriminator(s) make an explicit maxRetries decision ` +
      `(${decidedZero.length} delegate via maxRetries:0 [${decidedZero.join(', ') || 'none'}]; ` +
      `${exempted.length} documented-exempt [${exempted.join(', ') || 'none'}]).`,
  );
}

// Only run the CLI side-effect when invoked directly (not when imported by the unit test).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

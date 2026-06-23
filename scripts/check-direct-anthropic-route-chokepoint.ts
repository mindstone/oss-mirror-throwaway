#!/usr/bin/env npx tsx
/**
 * CI guard: every direct-Anthropic route arm must normalize the model id through the
 * single `resolveDirectAnthropicModel` chokepoint (in `providerRouteDecision.ts`) — never
 * by ad-hoc prefix-stripping / brand-minting at the arm.
 *
 * Why: the `direct_anthropic_dialect_normalization` bug class recurred 4× because the three
 * direct-Anthropic arms (active-provider, profile-Anthropic, Codex-divert) each decided how to
 * handle the `anthropic/` dialect prefix independently and drifted apart (see
 * docs/postmortems/260606_direct_anthropic_self_prefix_reject_auth_mislabel_postmortem.md, rec 3).
 * Unifying them through one resolver makes that divergence unrepresentable; this guard keeps it
 * that way (a future 4th arm that hand-rolls the strip/reject fails CI here). Complements the
 * `no-model-brand-casts` eslint rule (which keeps the wire-model brand-mint in wireModelId.ts).
 *
 * Conservative heuristic (raw-text scan of the route producer), mirroring
 * scripts/check-chat-completions-chokepoint.ts. The brand cast itself is separately guarded by
 * eslint, so this focuses on: resolver-is-used + no bypass patterns.
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = process.cwd();
const ROUTE_PRODUCER = path.join('src', 'core', 'rebelCore', 'providerRouting.ts');

// The three direct-Anthropic arms (active-provider, profile-Anthropic, Codex-divert) must each
// route through the chokepoint. A drop below this is either a removed arm or a bypass — both
// warrant a look (update this count + the postmortem family if you intentionally add/remove an arm).
const MIN_RESOLVER_CALL_SITES = 3;

const RESOLVER_CALL_RE = /\bresolveDirectAnthropicModel\s*\(/g;

// Bypass patterns the arms must NOT use (the resolver owns these):
const BYPASS_PATTERNS: ReadonlyArray<{ re: RegExp; why: string }> = [
  {
    re: /\bhasForeignDialectForDirectAnthropic\s*\(/,
    why: 'the foreign-dialect predicate is subsumed by resolveDirectAnthropicModel (do not re-introduce it at an arm)',
  },
  {
    re: /\bbrandRouteWireModel\s*\(\s*stripAnthropicProviderPrefix\s*\(/,
    why: 'minting a direct-Anthropic wire model by stripping inline — route through resolveDirectAnthropicModel().wireModel instead',
  },
];

function fail(message: string): never {
  console.error(`\n✗ check-direct-anthropic-route-chokepoint: ${message}\n`);
  process.exit(1);
}

function main(): void {
  const abs = path.join(REPO_ROOT, ROUTE_PRODUCER);
  if (!fs.existsSync(abs)) {
    fail(`route producer not found at ${ROUTE_PRODUCER} — update this guard if the file moved.`);
  }
  const source = fs.readFileSync(abs, 'utf8');

  for (const { re, why } of BYPASS_PATTERNS) {
    if (re.test(source)) {
      fail(
        `${ROUTE_PRODUCER} uses a direct-Anthropic normalization bypass (/${re.source}/): ${why}. ` +
        `All direct-Anthropic arms must go through resolveDirectAnthropicModel().`,
      );
    }
  }

  const resolverCallSites = (source.match(RESOLVER_CALL_RE) ?? []).length;
  if (resolverCallSites < MIN_RESOLVER_CALL_SITES) {
    fail(
      `${ROUTE_PRODUCER} has ${resolverCallSites} resolveDirectAnthropicModel() call-site(s), ` +
      `expected >= ${MIN_RESOLVER_CALL_SITES} (one per direct-Anthropic arm). A direct-Anthropic arm ` +
      `appears to bypass the chokepoint, or an arm was removed (update MIN_RESOLVER_CALL_SITES + the postmortem family if intentional).`,
    );
  }

  console.log(
    `✓ check-direct-anthropic-route-chokepoint: ${resolverCallSites} resolveDirectAnthropicModel() call-sites, no bypass patterns.`,
  );
}

main();

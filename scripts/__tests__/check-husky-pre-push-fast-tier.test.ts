/**
 * Unit tests for the husky pre-push fast-tier contract check (260419 A3).
 *
 * Tests the pure `checkFastTierContract` evaluator with fixture strings
 * (passing fixture + failing fixtures) so the script's hard-fail
 * invariant (`VITEST_FAST=1` precedes every `vitest related --run`) is
 * exercised in both directions.
 *
 * @see ../check-husky-pre-push-fast-tier.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkFastTierContract } from '../check-husky-pre-push-fast-tier';

// ---------------------------------------------------------------------------
// Fixture strings
// ---------------------------------------------------------------------------

const PASSING_FIXTURE = `#!/usr/bin/env sh
. "\${0%/*}/_/husky.sh"

current_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)
commit_msg=$(git log -1 --pretty=%B 2>/dev/null || true)

case "$commit_msg" in *"[deploy-beta]"*) is_beta=1 ;; esac

own_files=$(
  git log --first-parent --no-merges --format=%H "$range" 2>/dev/null \\
    | while read -r sha; do
        git show --name-only --format= "$sha" -- '*.ts' '*.tsx' 2>/dev/null || true
      done \\
    | grep -vE '\\.(test|spec)\\.(ts|tsx)$' \\
    | sort -u
)

merged_raw=""
for merge_hash in $(git log --merges --format='%H' "$range" 2>/dev/null); do
  merged_raw="$merged_raw
$(git diff --name-only "\${merge_hash}^1" "$merge_hash" -- '*.ts' '*.tsx' 2>/dev/null || true)"
done

# Real invocation — gated by VITEST_FAST=1 on the same line.
printf '%s\\n' "$scope" | tr '\\n' '\\0' | xargs -0 env VITEST_FAST=1 npx vitest related --run
`;

const FAILING_FIXTURE_NO_VITEST_FAST = `#!/usr/bin/env sh
. "\${0%/*}/_/husky.sh"

current_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)

# REGRESSION: VITEST_FAST=1 dropped — pre-push will run *.integration.* tests.
printf '%s\\n' "$scope" | tr '\\n' '\\0' | xargs -0 npx vitest related --run
`;

const FAILING_FIXTURE_NO_INVOCATION = `#!/usr/bin/env sh
. "\${0%/*}/_/husky.sh"

current_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)

# Hook lost its related-tests gate entirely.
npm run validate:fast
`;

const FAILING_FIXTURE_TWO_INVOCATIONS_ONE_UNGATED = `#!/usr/bin/env sh
. "\${0%/*}/_/husky.sh"

# First invocation gated correctly.
printf '%s\\n' "$scope" | tr '\\n' '\\0' | xargs -0 env VITEST_FAST=1 npx vitest related --run

# Second invocation — REGRESSION: missing VITEST_FAST=1.
echo "$other_scope" | xargs -I{} npx vitest related --run {}
`;

// ---------------------------------------------------------------------------
// checkFastTierContract — passing fixture
// ---------------------------------------------------------------------------

describe('checkFastTierContract — passing fixture', () => {
  it('returns ok=true when VITEST_FAST=1 precedes every vitest related --run', () => {
    const result = checkFastTierContract(PASSING_FIXTURE);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.vitestRelatedOccurrences).toBe(1);
    expect(result.vitestRelatedFastGated).toBe(1);
  });

  it('emits no soft warnings on the canonical fixture (all defense-in-depth markers present)', () => {
    const result = checkFastTierContract(PASSING_FIXTURE);
    expect(result.softWarnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// checkFastTierContract — failing fixtures
// ---------------------------------------------------------------------------

describe('checkFastTierContract — failing fixtures', () => {
  it('fails when VITEST_FAST=1 is missing from a vitest related --run line (the 260419 regression shape)', () => {
    const result = checkFastTierContract(FAILING_FIXTURE_NO_VITEST_FAST);
    expect(result.ok).toBe(false);
    expect(result.vitestRelatedOccurrences).toBe(1);
    expect(result.vitestRelatedFastGated).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/VITEST_FAST=1/);
    expect(result.errors[0]).toMatch(/260419/);
  });

  it('fails when no vitest related --run invocation exists at all', () => {
    const result = checkFastTierContract(FAILING_FIXTURE_NO_INVOCATION);
    expect(result.ok).toBe(false);
    expect(result.vitestRelatedOccurrences).toBe(0);
    expect(result.errors.some((e) => e.includes('no \'vitest related --run\' invocation'))).toBe(true);
  });

  it('fails when one of two vitest related --run lines is missing the env gate', () => {
    const result = checkFastTierContract(FAILING_FIXTURE_TWO_INVOCATIONS_ONE_UNGATED);
    expect(result.ok).toBe(false);
    expect(result.vitestRelatedOccurrences).toBe(2);
    expect(result.vitestRelatedFastGated).toBe(1);
    expect(result.errors).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Defense-in-depth soft warnings
// ---------------------------------------------------------------------------

describe('checkFastTierContract — defense-in-depth soft warnings', () => {
  it('emits a soft warning when the branch filter is missing', () => {
    // Minimal source that still satisfies the primary invariant but is
    // missing the `git rev-parse --abbrev-ref HEAD` branch read.
    const src = `printf '%s\\n' "$scope" | tr '\\n' '\\0' | xargs -0 env VITEST_FAST=1 npx vitest related --run\n`;
    const result = checkFastTierContract(src);
    expect(result.ok).toBe(true);
    expect(result.softWarnings.some((w) => /branch/i.test(w))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Real-hook canary
// ---------------------------------------------------------------------------

describe('real .husky/pre-push at HEAD', () => {
  it('passes the fast-tier contract check (canary against accidental regression)', () => {
    const repoRoot = join(__dirname, '..', '..');
    const hookSrc = readFileSync(join(repoRoot, '.husky', 'pre-push'), 'utf8');
    const result = checkFastTierContract(hookSrc);
    if (!result.ok) {
      // Surface diagnostic inline so CI logs are readable.
      throw new Error(
        `Real .husky/pre-push failed fast-tier check:\n${result.errors.join('\n')}`,
      );
    }
    expect(result.ok).toBe(true);
    expect(result.vitestRelatedOccurrences).toBeGreaterThanOrEqual(1);
    expect(result.vitestRelatedFastGated).toBe(result.vitestRelatedOccurrences);
  });
});

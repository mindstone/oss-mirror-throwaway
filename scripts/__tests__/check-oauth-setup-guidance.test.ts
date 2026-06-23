/**
 * Stage 3 refinement (F3): behavioural coverage for the hardened class-kill guard
 * `scripts/check-oauth-setup-guidance.ts`. Proves the two failure modes the reviewer asked for —
 * a re-introduced bare "not configured" string AND a wrong-provider id — both fail, while a faithful
 * structured branch passes. Drives the guard's pure `checkSingleFile` over temp fixtures so it does
 * not depend on the repo's live source (which must stay green).
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkSingleFile, collectErrors, isInScope } from '../check-oauth-setup-guidance';

let dir: string;

function fixture(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body, 'utf8');
  return path;
}

function parseSource(body: string): ts.SourceFile {
  return ts.createSourceFile('synth.ts', body, ts.ScriptTarget.Latest, true);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'oauth-guard-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('check-oauth-setup-guidance — hardened guard', () => {
  it('passes a faithful structured branch sourcing guidance for its own provider', () => {
    const path = fixture(
      'slackHandlers.ts',
      `import { describeMissingOAuthCredentials } from '@core/services/oauthConnectorSetup';
       export function h() {
         const guidance = describeMissingOAuthCredentials('slack');
         return { success: false, error: guidance.message, setupGuidance: guidance };
       }`,
    );
    expect(checkSingleFile(path, 'slackHandlers.ts', 'slack')).toEqual([]);
  });

  it('FAILS when a bare "not configured" string is re-introduced', () => {
    const path = fixture(
      'slackHandlers.bare.ts',
      `import { describeMissingOAuthCredentials } from '@core/services/oauthConnectorSetup';
       export function h() {
         const guidance = describeMissingOAuthCredentials('slack');
         return { success: false, error: 'Slack OAuth credentials are not configured.', setupGuidance: guidance };
       }`,
    );
    const errs = checkSingleFile(path, 'slackHandlers.bare.ts', 'slack');
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join('\n')).toMatch(/bare "not configured"/);
  });

  it('FAILS when the file sources guidance for the WRONG provider', () => {
    const path = fixture(
      'slackHandlers.wrong.ts',
      `import { describeMissingOAuthCredentials } from '@core/services/oauthConnectorSetup';
       export function h() {
         const guidance = describeMissingOAuthCredentials('github');
         return { success: false, error: guidance.message, setupGuidance: guidance };
       }`,
    );
    const errs = checkSingleFile(path, 'slackHandlers.wrong.ts', 'slack');
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join('\n')).toMatch(/wrong provider.*"github".*expected.*"slack"/s);
  });

  it('FAILS when the structured path is dropped entirely (no call site)', () => {
    const path = fixture(
      'slackHandlers.missing.ts',
      `export function h() { return { success: false, error: 'nope' }; }`,
    );
    const errs = checkSingleFile(path, 'slackHandlers.missing.ts', 'slack');
    expect(errs.join('\n')).toMatch(/does not call describeMissingOAuthCredentials/);
  });

  it('FAILS on a bare string ALONGSIDE a helper call (half-revert keeps the call but re-adds a string)', () => {
    // Reviewer fail-case (c): the helper is still called but a bare "not configured" literal was
    // re-introduced. Must fail the NEGATIVE assertion even though POSITIVE/PROVIDER pass.
    const path = fixture(
      'salesforceHandlers.halfrevert.ts',
      `import { describeMissingOAuthCredentials } from '@core/services/oauthConnectorSetup';
       export function h() {
         const guidance = describeMissingOAuthCredentials('salesforce');
         return { success: false, error: 'Salesforce OAuth credentials not configured.', setupGuidance: guidance };
       }`,
    );
    const errs = checkSingleFile(path, 'salesforceHandlers.halfrevert.ts', 'salesforce');
    expect(errs.join('\n')).toMatch(/bare "not configured"/);
  });

  // -- F2 soundness: in-scope determination is by construction, not "already calls the helper" --

  it('treats a bare-string handler with NO helper call as IN-SCOPE (the prior escape)', () => {
    // The exact escape: a new OAuth handler that returns a bare "not configured" string and never
    // calls the helper. The old rule (in-scope iff it calls the helper) marked this out-of-scope →
    // silently green. The sound rule keys on the missing-credential literal, so it is in scope.
    const bareNoHelper = parseSource(
      `export function startAuth() {
         return { success: false, error: 'Acme OAuth credentials not configured. Add CLIENT_ID and CLIENT_SECRET.' };
       }`,
    );
    expect(isInScope(bareNoHelper)).toBe(true);

    // And a handler with no OAuth involvement at all stays out of scope (no false positive).
    const unrelated = parseSource(
      `export function listThings() { return { items: [] }; }`,
    );
    expect(isInScope(unrelated)).toBe(false);
  });

  it('collectErrors FAILS when a NEW bare-string handler with no helper is dropped into src/main/ipc (escape closed)', () => {
    // Re-demonstrate fail-on-synthetic for the escape against the REAL discovery path: write a new
    // *Handlers.ts into the globbed directory, prove the guard flags it, then clean up.
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const rel = 'src/main/ipc/zzGuardSynthBareStringHandlers.ts';
    const abs = resolve(repoRoot, rel);
    try {
      writeFileSync(
        abs,
        `export function registerZzGuardSynthHandlers() {
           return { success: false, error: 'ZZ OAuth credentials not configured.' };
         }`,
        'utf8',
      );
      const errs = collectErrors();
      expect(errs.join('\n')).toContain(rel);
      expect(errs.join('\n')).toMatch(/not pinned in EXPECTED_PROVIDER/);
    } finally {
      if (existsSync(abs)) rmSync(abs);
    }
    // Sanity: once removed, the live tree is green again (proves the failure was the synthetic file).
    expect(collectErrors()).toEqual([]);
  });

  it('the live repo source is green (real-code regression floor)', () => {
    expect(collectErrors()).toEqual([]);
  });
});

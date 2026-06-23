/**
 * Phase 7 (F3): behavioural coverage for the renderer-side class-kill guard
 * `scripts/check-renderer-oauth-setup-guidance.ts`. Proves it FAILS on a synthetic renderer consumer
 * that calls a start-auth and ignores the setup-guidance funnel, PASSES on a faithful consumer, and
 * that the live renderer tree is green (the now-fixed real-code regression floor). Drives the guard's
 * pure `checkSingleFile` / `collectErrors` over temp fixtures ONLY — it never writes into the live
 * source tree (a live-tree fixture once raced concurrent scanners, e.g. broadcastCoverageGuard.test.ts
 * hit ENOENT scanning src/renderer during the fixture's delete window).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  callsStartAuth,
  checkSingleFile,
  collectErrors,
  referencesGuidance,
} from '../check-renderer-oauth-setup-guidance';

let dir: string;

function fixture(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body, 'utf8');
  return path;
}

function parseSource(body: string): ts.SourceFile {
  return ts.createSourceFile('synth.tsx', body, ts.ScriptTarget.Latest, true);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'renderer-oauth-guard-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('check-renderer-oauth-setup-guidance — renderer class-kill guard', () => {
  it('FAILS on a synthetic consumer that calls startAuth and ignores guidance', () => {
    const path = fixture(
      'BadConnect.tsx',
      `export function BadConnect() {
         const result = window.slackApi.startAuth();
         return result;
       }`,
    );
    const errs = checkSingleFile(path, 'src/renderer/BadConnect.tsx');
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join('\n')).toMatch(/never references the setup-guidance funnel/);
  });

  it('FAILS on a synthetic consumer that calls mcpAuthenticate and ignores guidance', () => {
    const path = fixture(
      'BadMcp.tsx',
      `export function BadMcp() {
         const r = window.miscApi.mcpAuthenticate({ serverId: 'Todoist' });
         return r;
       }`,
    );
    const errs = checkSingleFile(path, 'src/renderer/BadMcp.tsx');
    expect(errs.join('\n')).toMatch(/never references the setup-guidance funnel/);
  });

  it('PASSES a consumer that routes startAuth through handleResult', () => {
    const path = fixture(
      'GoodConnect.tsx',
      `import { useConnectorSetupGuidance } from './useConnectorSetupGuidance';
       export function GoodConnect() {
         const setupGuidanceDialog = useConnectorSetupGuidance();
         const result = window.slackApi.startAuth();
         if (!setupGuidanceDialog.handleResult(result)) { /* generic error */ }
         return null;
       }`,
    );
    expect(checkSingleFile(path, 'src/renderer/GoodConnect.tsx')).toEqual([]);
  });

  it('PASSES a consumer that forwards onSetupGuidance', () => {
    const path = fixture(
      'GoodForward.tsx',
      `export function GoodForward({ handleResult }: { handleResult: (r: unknown) => boolean }) {
         void window.connect({ onSetupGuidance: handleResult });
         return window.slackApi.startAuth();
       }`,
    );
    expect(checkSingleFile(path, 'src/renderer/GoodForward.tsx')).toEqual([]);
  });

  it('treats a file with no start-auth call as out of scope (no false positive)', () => {
    const unrelated = parseSource(`export function listThings() { return { items: [] }; }`);
    expect(callsStartAuth(unrelated)).toBe(false);
    // A comment mentioning startAuth must NOT pull a file into scope (AST call-site only).
    const commentOnly = parseSource(`// calls startAuth() somewhere else\nexport const x = 1;`);
    expect(callsStartAuth(commentOnly)).toBe(false);
  });

  it('recognises the guidance funnel by any of its identifiers (incl. hosted setupGuidance state)', () => {
    expect(referencesGuidance(parseSource(`const x = useConnectorSetupGuidance();`))).toBe(true);
    expect(referencesGuidance(parseSource(`x.handleResult(r);`))).toBe(true);
    expect(referencesGuidance(parseSource(`f({ onSetupGuidance: g });`))).toBe(true);
    expect(referencesGuidance(parseSource(`if (isOAuthSetupGuidance(r.setupGuidance)) {}`))).toBe(true);
    // OnboardingWizard-style: reads the hosted controller via state.setupGuidance.
    expect(referencesGuidance(parseSource(`<Dialog guidance={state.setupGuidance.guidance} />`))).toBe(true);
    expect(referencesGuidance(parseSource(`const y = 1;`))).toBe(false);
  });

  it('collectErrors FAILS when a NEW unwired consumer is dropped into the scanned renderer tree (escape closed)', () => {
    // Re-demonstrate fail-on-synthetic against the REAL discovery path (walk → parse → per-file
    // check + EXEMPT handling) by rooting the scan at a TEMP tree. Deliberately NOT written into
    // the live src/renderer: that raced concurrent suites scanning the live tree (ENOENT in the
    // delete window — see broadcastCoverageGuard.test.ts flake, 260610).
    const base = mkdtempSync(join(tmpdir(), 'renderer-oauth-guard-tree-'));
    const rel = 'src/renderer/zzGuardSynthRendererConsumer.tsx';
    try {
      const rendererRoot = join(base, 'src', 'renderer');
      mkdirSync(rendererRoot, { recursive: true });
      writeFileSync(
        join(base, rel),
        `export function ZzGuardSynthConsumer() {
           const result = window.slackApi.startAuth();
           return result;
         }`,
        'utf8',
      );
      const errs = collectErrors(rendererRoot, base);
      expect(errs.join('\n')).toContain(rel);
      expect(errs.join('\n')).toMatch(/never references the setup-guidance funnel/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
    // Sanity: the live tree (default scan roots) is green — proves the failure above came from
    // the synthetic consumer, not real renderer code.
    expect(collectErrors()).toEqual([]);
  });

  it('the live renderer source is green (real-code regression floor)', () => {
    expect(collectErrors()).toEqual([]);
  });
});

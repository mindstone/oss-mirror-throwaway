#!/usr/bin/env npx tsx
/**
 * CI validation (class-kill, Phase 7 F3): every RENDERER connect surface that invokes a connector
 * start-auth / mcp-authenticate / onboarding `generateAuthLink` must ROUTE the result through the
 * shared connector setup-guidance funnel (`useConnectorSetupGuidance` → `handleResult` /
 * `onSetupGuidance`, or read it via `isOAuthSetupGuidance` / `setupGuidance`) so a broken-by-default
 * connector opens the `ConnectorSetupDialog` — instead of silently dropping `setupGuidance`.
 *
 * Why a SEPARATE guard from `check-oauth-setup-guidance.ts`? That one polices the MAIN process: it
 * proves each start-auth IPC handler / orchestrator EMITS the structured guidance. It cannot see
 * the renderer, where the recurring bug lives: a consumer calls `*Api.startAuth()` /
 * `miscApi.mcpAuthenticate()` / `generateAuthLink()` and forgets to forward the `setupGuidance` it
 * receives to the dialog (Phase 2 found 6 such consumers; Stage 5 wired 9; Phase 7 found 2 more —
 * onboarding-flow + the Messaging Slack CTA — plus a third, the Todoist connect in TasksPanel).
 * This guard makes that forwarding un-droppable by construction.
 *
 * Static analysis only (no runtime import, no secrets). FP-safe by design:
 *  - DISCOVERY is by construction: a renderer file is in scope iff it CALLS a start-auth consumer
 *    (`<anything>.startAuth(...)`, `<anything>.mcpAuthenticate(...)`, `generateAuthLink(...)`, or
 *    `useConnectSlackMcpAction(...)`). AST call-site detection (not import / not comment / not a
 *    string), so a mention in a comment or doc can't drag a file into scope.
 *  - REQUIREMENT: every in-scope file must REFERENCE the guidance funnel — any identifier in
 *    {@link GUIDANCE_REFERENCES} (`useConnectorSetupGuidance`, `handleResult`, `onSetupGuidance`,
 *    `isOAuthSetupGuidance`, `setupGuidance`). A file that opens `ConnectorSetupDialog` from a
 *    hosted controller (the onboarding wizard reads `state.setupGuidance`) satisfies this via the
 *    `setupGuidance` reference.
 *  - ESCAPE HATCH: a file that legitimately consumes a start-auth WITHOUT routing to the dialog
 *    (e.g. the helper definitions themselves, or a status-only caller) must be listed in
 *    {@link EXEMPT} with a one-line justification. Adding a NEW start-auth consumer therefore forces
 *    a choice: route through the funnel, or consciously exempt — never silently uncovered.
 *
 * Proven (see `scripts/__tests__/check-renderer-oauth-setup-guidance.test.ts`): FAILS on a synthetic
 * renderer consumer that calls `startAuth()` and ignores guidance; PASSES on the (now-fixed) real tree.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_ROOT = 'src/renderer';

/**
 * Identifiers whose REFERENCE (anywhere in the file: import, prop, call, member access) proves the
 * file routes through / reads the shared setup-guidance funnel. `setupGuidance` covers surfaces that
 * host the controller and read its state (e.g. `state.setupGuidance.guidance` in OnboardingWizard).
 */
const GUIDANCE_REFERENCES: ReadonlySet<string> = new Set([
  'useConnectorSetupGuidance',
  'handleResult',
  'onSetupGuidance',
  'isOAuthSetupGuidance',
  'setupGuidance',
]);

/**
 * Renderer files that invoke a start-auth consumer but legitimately do NOT route to the dialog.
 * Each entry needs a one-line justification. Keeping this explicit (rather than silently skipping)
 * means a NEW start-auth consumer either references the funnel or is consciously exempted here.
 *
 * Currently EMPTY: every real renderer start-auth consumer routes through the funnel. An entry here
 * is only for a caller that legitimately must not open the dialog (e.g. a pure status/success-only
 * caller); the stale-entry check below prevents this list from rotting.
 */
const EXEMPT: Readonly<Record<string, string>> = {};

function parse(abs: string): ts.SourceFile {
  return ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true);
}

/**
 * Whether the source CALLS a connector start-auth consumer (AST call site, not import/comment/string):
 *  - `<expr>.startAuth(...)`        (slackApi/googleWorkspaceApi/microsoftApi/githubApi/hubspotApi/plaudApi/…)
 *  - `<expr>.mcpAuthenticate(...)`  (miscApi.mcpAuthenticate / authenticateMcpServer-style)
 *  - `generateAuthLink(...)`        (onboarding hook action)
 *  - `useConnectSlackMcpAction(...)`(shared Slack connect action hook)
 */
const START_AUTH_METHODS: ReadonlySet<string> = new Set([
  'startAuth',
  'mcpAuthenticate',
  'authenticateMcpServer',
]);
const START_AUTH_CALLEES: ReadonlySet<string> = new Set([
  'generateAuthLink',
  'useConnectSlackMcpAction',
]);

export function callsStartAuth(sf: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      // `<expr>.startAuth(...)` / `<expr>.mcpAuthenticate(...)` / `<expr>.authenticateMcpServer(...)`
      if (ts.isPropertyAccessExpression(callee) && START_AUTH_METHODS.has(callee.name.text)) {
        found = true;
      }
      // bare `generateAuthLink(...)` / `useConnectSlackMcpAction(...)`
      if (ts.isIdentifier(callee) && START_AUTH_CALLEES.has(callee.text)) {
        found = true;
      }
      // `actions.generateAuthLink(...)` (member-access form)
      if (ts.isPropertyAccessExpression(callee) && START_AUTH_CALLEES.has(callee.name.text)) {
        found = true;
      }
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Whether the source REFERENCES any guidance-funnel identifier (import, member, prop, or call). */
export function referencesGuidance(sf: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && GUIDANCE_REFERENCES.has(node.text)) {
      found = true;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * Per-file assertion: an in-scope renderer consumer must reference the guidance funnel. Pure (no
 * process exit / no console); exported so the behavioural test can re-demonstrate fail-on-synthetic
 * (a start-auth consumer that ignores guidance) without shelling out.
 */
export function checkSingleFile(abs: string, rel: string): string[] {
  const sf = parse(abs);
  if (!callsStartAuth(sf)) return []; // not a start-auth consumer → out of scope
  if (referencesGuidance(sf)) return []; // routes through / reads the funnel → ok
  return [
    `${rel} calls a connector start-auth (startAuth / mcpAuthenticate / generateAuthLink / ` +
      `useConnectSlackMcpAction) but never references the setup-guidance funnel ` +
      `(useConnectorSetupGuidance / handleResult / onSetupGuidance / isOAuthSetupGuidance / ` +
      `setupGuidance). A broken-by-default connector would drop its guidance instead of opening ` +
      `ConnectorSetupDialog. Route the result through useConnectorSetupGuidance().handleResult ` +
      `(or pass onSetupGuidance), or — if this caller legitimately must not open the dialog — add ` +
      `it to EXEMPT in scripts/check-renderer-oauth-setup-guidance.ts with a justification.`,
  ];
}

/** Recursively collect renderer source files (skips tests, type decls, node_modules). */
function discoverRenderer(rendererRootAbs: string, baseAbs: string): string[] {
  const out: string[] = [];
  const walk = (dirAbs: string): void => {
    for (const entry of readdirSync(dirAbs)) {
      const abs = resolve(dirAbs, entry);
      const st = statSync(abs);
      if (st.isDirectory()) {
        if (entry === 'node_modules' || entry === '__tests__' || entry === '__mocks__') continue;
        walk(abs);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry)) continue;
      if (/\.(test|spec)\.tsx?$/.test(entry)) continue;
      if (entry.endsWith('.d.ts')) continue;
      out.push(relative(baseAbs, abs));
    }
  };
  walk(rendererRootAbs);
  return out.sort();
}

/**
 * Run the full renderer-wide check; returns the accumulated error list (empty ⇒ pass).
 *
 * The roots are parameterised as a TEST SEAM ONLY (defaults scan the live
 * `src/renderer`): the behavioural test exercises the real discovery walk against a
 * synthetic consumer in a TEMP tree instead of writing fixtures into the live
 * renderer tree, which raced concurrent live-tree scanners (a parallel suite once
 * hit ENOENT mid-scan on the fixture's delete window). CLI behaviour is unchanged.
 */
export function collectErrors(
  rendererRootAbs: string = resolve(REPO_ROOT, RENDERER_ROOT),
  baseAbs: string = REPO_ROOT,
): string[] {
  const errors: string[] = [];
  const files = discoverRenderer(rendererRootAbs, baseAbs);
  const inScope: string[] = [];

  for (const rel of files) {
    const abs = resolve(baseAbs, rel);
    if (!callsStartAuth(parse(abs))) continue;
    inScope.push(rel);
    if (rel in EXEMPT) continue; // consciously exempted (justification recorded)
    errors.push(...checkSingleFile(abs, rel));
  }

  // Exempt entries that no longer call a start-auth are stale — don't let EXEMPT rot silently.
  for (const rel of Object.keys(EXEMPT)) {
    if (!inScope.includes(rel)) {
      errors.push(
        `${rel} is listed in EXEMPT (scripts/check-renderer-oauth-setup-guidance.ts) but no longer ` +
          `calls a connector start-auth — remove its EXEMPT entry.`,
      );
    }
  }

  return errors;
}

export function main(): void {
  const errors = collectErrors();
  if (errors.length > 0) {
    console.error('✗ check-renderer-oauth-setup-guidance FAILED:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(
    '✓ check-renderer-oauth-setup-guidance: every renderer start-auth consumer routes through the ' +
      'setup-guidance funnel (or is consciously exempted).',
  );
}

// Run as a script (CLI), but stay import-safe for the behavioural test.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

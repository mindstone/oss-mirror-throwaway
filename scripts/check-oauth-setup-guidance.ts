#!/usr/bin/env npx tsx
/**
 * CI validation (class-kill, DA F1): every OAuth start-auth path that can hit the
 * no-client-credentials branch must return the STRUCTURED setup guidance
 * (`describeMissingOAuthCredentials` / `setupGuidance`) on that branch, not an ad-hoc
 * "OAuth … not configured" string — AND must source it for the connector that file owns.
 *
 * Two surfaces are in scope:
 *  - user-initiated start-auth IPC handlers (`src/main/ipc/*Handlers.ts`), and
 *  - host-side MCP auth orchestrators (`src/main/services/*AuthOrchestrator.ts`) reached by the
 *    agent/setup-tool path (`misc:mcp-authenticate` / `misc:mcp-invoke-stdio-auth` →
 *    `invokeStdioAuthenticateTool`). Stage 3's refinement round wired the orchestrators too.
 *
 * Kills the regression class where a path silently reverts to a bare "credentials not configured"
 * string and the renderer loses the structured, copy-the-env-vars guidance — a change that would
 * otherwise stay green (the bare string still type-checks and the IPC schema's `setupGuidance` is
 * optional). This guard makes that wiring un-droppable by construction.
 *
 * Static analysis only (no runtime import, no secrets read). Per in-scope file:
 *  1. POSITIVE — the file must CALL `describeMissingOAuthCredentials(...)` (call site, not merely
 *     an unused import): the structured path can't be silently removed.
 *  2. NEGATIVE — no string literal in the file matches the old bare "not configured" pattern
 *     (a half-revert that keeps the structured reference but re-adds a bare string still fails).
 *  3. PROVIDER — every `describeMissingOAuthCredentials('<p>')` literal in the file must match the
 *     provider that file owns (see EXPECTED_PROVIDER). Catches a copy-paste bug like
 *     slackHandlers.ts calling `describeMissingOAuthCredentials('github')`.
 *
 * Auto-discovery + completeness pin: rather than only trusting a hand-maintained list, we GLOB the
 * two directories (plus an explicitly-listed extra-file set, e.g. mcpService.ts's stdio-auth path)
 * and decide IN-SCOPE *by construction*, NOT by "already calls the helper". A file is in scope iff
 * it (a) RESOLVES OAuth client credentials (`resolveOAuthCredentials` / `resolveMicrosoftClientId` /
 * `resolve*Credentials`) OR (b) contains a missing-credential literal (the bare "not configured" /
 * "CLIENT_ID … CLIENT_SECRET" class). This closes the prior unsound rule: a NEW handler that returns
 * a bare "OAuth credentials not configured" string and NEVER calls the helper used to be discovered
 * but marked out-of-scope → silently green. Now it is in-scope (it owns a missing-cred literal /
 * resolves creds) and MUST be curated in EXPECTED_PROVIDER (provider pinned) or documented in
 * NON_OAUTH_EXEMPT — otherwise the completeness check fails loudly. Every in-scope file is then run
 * through the per-file assertions (helper call site + provider match + no bare string).
 *
 * Why not assert the literal shape of every return? Returns differ (some build a `guidance` local,
 * some inline it). Asserting helper-call + provider-match + absence of a bare string is the FP-safe
 * floor that proves the structured path is present and correct without coupling to each return.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const STRUCTURED_SYMBOL = 'describeMissingOAuthCredentials';

/**
 * In-scope start-auth handler + orchestrator files → the provider literal each one owns. This is
 * the curated source of truth; the completeness check below proves it covers every discovered file
 * (minus the documented exemptions), so a new connector handler/orchestrator cannot escape.
 */
const EXPECTED_PROVIDER: Readonly<Record<string, string>> = {
  // user-initiated start-auth IPC handlers
  'src/main/ipc/slackHandlers.ts': 'slack',
  'src/main/ipc/hubspotHandlers.ts': 'hubspot',
  'src/main/ipc/microsoftHandlers.ts': 'microsoft',
  'src/main/ipc/salesforceHandlers.ts': 'salesforce',
  'src/main/ipc/plaudHandlers.ts': 'plaud',
  'src/main/ipc/googleWorkspaceHandlers.ts': 'google',
  'src/main/ipc/githubHandlers.ts': 'github',
  'src/main/ipc/cloudHandlers.ts': 'digitalocean',
  // host-side MCP auth orchestrators (agent/setup-tool path)
  'src/main/services/slackAuthOrchestrator.ts': 'slack',
  'src/main/services/hubspotAuthOrchestrator.ts': 'hubspot',
  'src/main/services/googleWorkspaceAuthOrchestrator.ts': 'google',
  'src/main/services/microsoftAuthOrchestrator.ts': 'microsoft',
  // legacy setup-tool path: oauth-user-provided connectors (Salesforce) have NO host
  // orchestrator, so invokeStdioAuthenticateTool maps their missing-creds error to structured
  // guidance directly. Stage 3 review r2 (F1) wired this; pin it so it can't silently revert.
  'src/main/services/mcpService.ts': 'salesforce',
};

/**
 * Files outside the two globbed directories that participate in the OAuth setup-guidance contract
 * and must be checked. Kept explicit (the glob can't reach them) and small.
 */
const EXTRA_IN_SCOPE_FILES: readonly string[] = ['src/main/services/mcpService.ts'];

/**
 * Discovered files that legitimately do NOT resolve OAuth client credentials and so are exempt from
 * the structured-guidance requirement. Each entry needs a one-line justification. Keeping this
 * explicit (rather than silently skipping) means a NEW handler/orchestrator either lands in
 * EXPECTED_PROVIDER or is consciously exempted here — never silently uncovered.
 */
const NON_OAUTH_EXEMPT: Readonly<Record<string, string>> = {
  // Discourse self-generates its client_id and never reaches the null-credentials path
  // (see src/main/services/discourseAuthService.ts; excluded by oauthConnectorSetup.ts too).
  'src/main/services/discourseAuthService.ts': 'self-generated client_id; no null-creds path',
};

/**
 * The old bare "not configured" error-string class we're killing. Matches the historical strings
 * (e.g. "Slack OAuth credentials not configured.", "… credentials are not configured.",
 * "Microsoft 365 OAuth is not configured."). Deliberately broad on the connective so it can't be
 * sidestepped by reordering words.
 */
const BARE_NOT_CONFIGURED =
  /\bOAuth\b[^"'`]*\bnot configured\b|\bcredentials\b[^"'`]*\b(?:are|is)?\s*not configured\b/i;

/**
 * IN-SCOPE-by-construction literal: a file that contains a missing-credential message in a string
 * literal is owning the not-configured branch and is therefore in scope (regardless of whether it
 * calls the helper). Broader than {@link BARE_NOT_CONFIGURED} (also matches the env-var-pair form
 * "CLIENT_ID … CLIENT_SECRET") so a new bare-string handler can't dodge discovery by phrasing.
 */
const MISSING_CREDENTIAL_LITERAL =
  /\bOAuth\b[^"'`]*\bnot configured\b|\bcredentials\b[^"'`]*\b(?:are|is)?\s*not configured\b|CLIENT_ID[^"'`]*CLIENT_SECRET/i;

/** Identifiers whose invocation means the file RESOLVES OAuth client credentials (→ in scope). */
const RESOLVES_CREDENTIALS = /^(resolveOAuthCredentials|resolveMicrosoftClientId|resolve[A-Za-z]+Credentials)$/;

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
}

/** Whether the source CALLS `describeMissingOAuthCredentials(...)` (call site, not just import). */
function callsStructuredPath(sf: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === STRUCTURED_SYMBOL
    ) {
      found = true;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Whether the source CALLS a credential-resolver (`resolveOAuthCredentials` / `resolve*Credentials`). */
function resolvesOAuthCredentials(sf: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      RESOLVES_CREDENTIALS.test(node.expression.text)
    ) {
      found = true;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * IN-SCOPE-by-construction: a file participates in the OAuth setup-guidance contract iff it resolves
 * OAuth client credentials OR contains a missing-credential string literal. Crucially this does NOT
 * depend on the file already calling the helper — that was the unsound rule that let a new bare-string
 * handler escape (discovered but marked out-of-scope → silently green).
 */
export function isInScope(sf: ts.SourceFile): boolean {
  if (resolvesOAuthCredentials(sf)) return true;
  return stringLiteralTexts(sf).some((t) => MISSING_CREDENTIAL_LITERAL.test(t));
}

/**
 * Every provider string literal passed to a `describeMissingOAuthCredentials('<p>')` call. Used to
 * assert the file sources guidance for the connector it owns (not, say, a copy-pasted other one).
 */
function structuredProviderArgs(sf: ts.SourceFile): string[] {
  const providers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === STRUCTURED_SYMBOL
    ) {
      const arg = node.arguments[0];
      if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
        providers.push(arg.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return providers;
}

/** Collect every string-literal / no-substitution-template text in the source. */
function stringLiteralTexts(sf: ts.SourceFile): string[] {
  const texts: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      texts.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return texts;
}

/** Glob a directory (non-recursive) for files matching a suffix, returned repo-relative + sorted. */
function discover(dirRel: string, suffix: string): string[] {
  const dirAbs = resolve(REPO_ROOT, dirRel);
  if (!existsSync(dirAbs)) return [];
  return readdirSync(dirAbs)
    .filter((f) => f.endsWith(suffix) && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'))
    .map((f) => `${dirRel}/${f}`)
    .sort();
}

/**
 * Run the three per-file assertions (POSITIVE call site / NEGATIVE bare string / PROVIDER match)
 * against a single file at absolute path `abs`, labelled `rel`, owning connector `expectedProvider`.
 * Pure (no process exit / no console); exported so the behavioural test can re-demonstrate
 * fail-on-synthetic (bare string AND wrong provider) against a fixture without shelling out.
 */
export function checkSingleFile(
  abs: string,
  rel: string,
  expectedProvider: string,
): string[] {
  const out: string[] = [];
  const sf = parse(abs);

  // 1. POSITIVE: structured path is actually invoked.
  if (!callsStructuredPath(sf)) {
    out.push(
      `${rel} does not call ${STRUCTURED_SYMBOL}() — the structured OAuth setup-guidance ` +
        `path must be populated on the not-configured branch (it was silently dropped).`,
    );
  }

  // 2. NEGATIVE: no bare "not configured" string survives.
  const offending = stringLiteralTexts(sf).filter((t) => BARE_NOT_CONFIGURED.test(t));
  if (offending.length > 0) {
    out.push(
      `${rel} still contains a bare "not configured" OAuth error string ` +
        `(${offending.map((t) => JSON.stringify(t)).join(', ')}). Replace it with the structured ` +
        `${STRUCTURED_SYMBOL}() guidance (sourcing the error string from guidance.message).`,
    );
  }

  // 3. PROVIDER: every literal argument must match the connector this file owns.
  const wrong = structuredProviderArgs(sf).filter((p) => p !== expectedProvider);
  if (wrong.length > 0) {
    out.push(
      `${rel} calls ${STRUCTURED_SYMBOL}() with the wrong provider ` +
        `(${[...new Set(wrong)].map((p) => JSON.stringify(p)).join(', ')}); expected ` +
        `${JSON.stringify(expectedProvider)}. A start-auth path must source guidance for its own ` +
        `connector.`,
    );
  }
  return out;
}

/** Run the full repo-wide check; returns the accumulated error list (empty ⇒ pass). */
export function collectErrors(): string[] {
  const errors: string[] = [];

  // --- Completeness: discovered set must be covered by curated EXPECTED_PROVIDER (minus exempt) ---
  const discovered = [
    ...discover('src/main/ipc', 'Handlers.ts'),
    ...discover('src/main/services', 'AuthOrchestrator.ts'),
    // Explicitly-listed extra files the globs can't reach (e.g. mcpService.ts's stdio-auth path).
    ...EXTRA_IN_SCOPE_FILES.filter((rel) => existsSync(resolve(REPO_ROOT, rel))),
  ];

  // IN-SCOPE-by-construction (F2): a file is in scope iff it resolves OAuth client credentials OR
  // owns a missing-credential literal — NOT "already calls the helper". This is the sound rule: a
  // NEW handler that returns a bare "OAuth credentials not configured" string and never calls the
  // helper is now in scope and must be curated (provider pinned) or documented in NON_OAUTH_EXEMPT.
  // EXTRA_IN_SCOPE_FILES are treated as in-scope unconditionally (they are listed precisely because
  // they participate in the contract via a variable-provider helper call, not a literal we can sniff).
  for (const rel of discovered) {
    const abs = resolve(REPO_ROOT, rel);
    const inScope = EXTRA_IN_SCOPE_FILES.includes(rel) || isInScope(parse(abs));
    const curated = rel in EXPECTED_PROVIDER;
    const exempt = rel in NON_OAUTH_EXEMPT;

    if (inScope && !curated && !exempt) {
      errors.push(
        `${rel} resolves OAuth client credentials or contains a missing-credential string but is ` +
          `not pinned in EXPECTED_PROVIDER. It must route its not-configured branch through ` +
          `${STRUCTURED_SYMBOL}('<own-provider>') and be pinned here (or, if it legitimately has no ` +
          `null-credentials path, add a justification to NON_OAUTH_EXEMPT).`,
      );
    }
    if (curated && !inScope) {
      errors.push(
        `${rel} is pinned in EXPECTED_PROVIDER but no longer resolves OAuth credentials nor owns a ` +
          `missing-credential string — it appears to have left the OAuth setup-guidance scope. ` +
          `Remove its EXPECTED_PROVIDER pin (or restore the not-configured branch).`,
      );
    }
  }

  // Curated files that vanished from disk are a hard error (don't silently shrink coverage).
  for (const rel of Object.keys(EXPECTED_PROVIDER)) {
    if (!existsSync(resolve(REPO_ROOT, rel))) {
      errors.push(`In-scope file pinned in EXPECTED_PROVIDER not found at ${rel}.`);
    }
  }

  // --- Per-file assertions over the curated set --------------------------------------------------
  for (const [rel, expectedProvider] of Object.entries(EXPECTED_PROVIDER)) {
    const abs = resolve(REPO_ROOT, rel);
    if (!existsSync(abs)) continue; // already reported above
    errors.push(...checkSingleFile(abs, rel, expectedProvider));
  }

  return errors;
}

export function main(): void {
  const errors = collectErrors();
  if (errors.length > 0) {
    console.error('✗ check-oauth-setup-guidance FAILED:');
    for (const e of errors) console.error(`  - ${e}`);
    console.error(
      `\n  Fix: on each path's not-configured branch, return ` +
        `{ success: false, error: guidance.message, setupGuidance: guidance } where ` +
        `guidance = ${STRUCTURED_SYMBOL}('<own-provider>') ` +
        `(import from '@core/services/oauthConnectorSetup').`,
    );
    process.exit(1);
  }

  const curatedCount = Object.keys(EXPECTED_PROVIDER).length;
  console.log(
    `✓ check-oauth-setup-guidance: all ${curatedCount} in-scope start-auth paths call ` +
      `${STRUCTURED_SYMBOL}() with the correct provider and emit no bare "not configured" string.`,
  );
  console.log(
    `  (checked: ${Object.keys(EXPECTED_PROVIDER)
      .map((f) => relative('src/main', f))
      .join(', ')})`,
  );
}

// Run as a script (CLI), but stay import-safe for the behavioural test.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

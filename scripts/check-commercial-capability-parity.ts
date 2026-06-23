#!/usr/bin/env npx tsx
/**
 * CI validation: every `@private/mindstone` commercial capability is actually wired —
 * the commercial bootstrap exposes a REAL (non-stub) implementation, the OSS stub stays
 * inert (broken-by-default preserved), and the desktop bootstrap registers/consumes the
 * capability — so "stub for OSS, forget commercial wiring" cannot ship.
 *
 * Kills the `oss_scrub_commercial_capability_drop` regression family (rec
 * cca89241502c9db7). Two high-sev instances shipped in one week:
 *  - 260608: OAuth connector creds — the scrub stubbed the embedded credentials and the
 *    commercial build silently lost all 7 connectors (docs/plans/260608_commercial-oauth-creds-restore).
 *  - 260610: Sentry DSN — all 3 surfaces telemetry-dead (docs/plans/260610_fix-beta-sentry-dsn;
 *    that surface is guarded separately by scripts/check-built-bundle-sentry-dsn.mjs).
 * Decision context: docs-private/ops/OSS_COMMERCIAL_CONFIG_TODO.md ("The class").
 *
 * This generalizes the original single-capability guard
 * (`scripts/check-commercial-oauth-credentials.ts`, now the `oauth-credentials` registry
 * entry below, assertions preserved exactly) into a parameterized registry over the
 * `PrivateMindstoneBootstrap` surface (src/core/services/privateMindstoneBootstrap.ts):
 *
 *  - `oauth-credentials` — commercial provider has non-empty clientId/clientSecret
 *    literals per connector; OSS stub carries NO credential literals; both bootstraps wire
 *    `LIVE_OAUTH_CREDENTIALS_PROVIDER`; desktop calls `setOAuthCredentialsProvider(...)`.
 *  - `meeting-bot-backend-config` — both bootstraps wire
 *    `LIVE_MEETING_BOT_BACKEND_CONFIG_PROVIDER`; desktop calls
 *    `setMeetingBotBackendConfigProvider(...)`. Value delivery is guarded separately by
 *    `scripts/check-built-bundle-meeting-bot-config.mjs`.
 *  - `auth-provider` — commercial `LIVE_AUTH_PROVIDER` is `DESKTOP_REBEL_AUTH_PROVIDER`
 *    (the real auth provider), stub stays `OSS_NULL_AUTH_PROVIDER`; desktop calls
 *    `setRebelAuthProvider(LIVE_AUTH_PROVIDER)`.
 *  - `current-user-provider` — commercial factory RETURNS `new ElectronCurrentUserProvider()`
 *    (a discarded `new` doesn't count), stub must NOT; desktop calls
 *    `setCurrentUserProviderFactory(...)`.
 *  - `contribution-relay` — commercial `registerPrivateMindstoneHandlers` BODY registers the
 *    relay extension with submit/refreshStatus/notifyPublished each backed by the real
 *    implementation (no-ops with the right names don't count); stub must NOT register a
 *    relay; desktop LIVE-calls `registerPrivateMindstoneHandlers(getHandlerRegistry())`.
 *  - `auth-config-refresh` — commercial `forceAuthConfigRefresh` calls the real
 *    `fetchAuthConfig`, stub must NOT; the desktop deep-link handler
 *    (`src/main/startup/deepLinkHandler.ts`) injects `fetchAuthConfig: forceAuthConfigRefresh`
 *    into `fetchWithSubscriptionRetry(...)` (a bare identifier reference doesn't count).
 *  - `auth-health-check` — commercial `registerPrivateMindstoneHealthCheck` BODY registers
 *    `checkAuthHealth`; desktop LIVE-calls
 *    `registerPrivateMindstoneHealthCheck({ registerAuthHealthCheck: setAuthHealthCheck })`.
 *
 * Registration/injection assertions pin the LIVE AST shape (the call as an unconditional
 * statement in the right body / the property bound to the real function / the factory's
 * return expression), not "identifier appears somewhere" — per the GPT-5.5 stage-4 review
 * (F1), name-anywhere matching false-passes on dead `if (false)` calls, no-op injections
 * with the right property names, discarded `new` side effects, and registrations moved to
 * unused helpers. Mirrors the TS-compiler-API precedent in
 * scripts/check-agent-tool-body-model-source.ts (regex windows false-pass).
 *
 * (`PRIVATE_MINDSTONE_BOOTSTRAP_MODE`/`BUNDLE_MARKER` are intentionally NOT registry
 * entries: they are compile-pinned literals covered by `modePurity.test.ts` and the
 * runtime mode log line, and there is no real-vs-stub "forgotten wiring" failure mode.)
 *
 * Static analysis only (no runtime import, no secret values read into the process; errors
 * name files/identifiers, never values). In an OSS checkout the commercial tree is stripped
 * (mirror/substitutions.yaml → private/mindstone/**): commercial-side assertions are
 * skipped and only the stub + desktop assertions run.
 *
 * Note on shape-pinning: the commercial-side assertions pin the CURRENT real
 * implementation identifiers (e.g. `DESKTOP_REBEL_AUTH_PROVIDER`). Renaming a real
 * implementation legitimately requires updating the registry entry here — that is the
 * point: an unreviewed swap to anything else (including a stub) must trip a gate.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// File roles
// ---------------------------------------------------------------------------

export const PARITY_FILES = {
  commercialBootstrap: 'private/mindstone/src/bootstrap.ts',
  stubBootstrap: 'src/main/oss/private-mindstone-stub/bootstrap.ts',
  desktopMain: 'src/main/index.ts',
  // The subscription-checkout retry seam (fetchWithSubscriptionRetry +
  // forceAuthConfigRefresh injection) was extracted from index.ts into the
  // deep-link handler (Stage 2 of the index.ts startup refactor —
  // docs/plans/260623_refactor-index-startup-extract/PLAN.md). The
  // auth-config-refresh parity check scans this file for that seam.
  desktopDeepLink: 'src/main/startup/deepLinkHandler.ts',
  commercialOAuthProvider: 'private/mindstone/src/services/oauthCredentialsProvider.ts',
  stubOAuthProvider: 'src/main/oss/private-mindstone-stub/services/oauthCredentialsProvider.ts',
} as const;

export type ParityFileRole = keyof typeof PARITY_FILES;

/** Source text per role; `null` = file absent (commercial roles: OSS checkout → skip). */
export type ParitySources = Record<ParityFileRole, string | null>;

// ---------------------------------------------------------------------------
// AST helpers (shared across capability checks)
// ---------------------------------------------------------------------------

function parse(roleName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(roleName, text, ts.ScriptTarget.Latest, true);
}

function nonEmptyStringProp(obj: ts.ObjectLiteralExpression, name: string): boolean {
  for (const prop of obj.properties) {
    if (
      ts.isPropertyAssignment(prop) &&
      ((ts.isIdentifier(prop.name) && prop.name.text === name) ||
        (ts.isStringLiteral(prop.name) && prop.name.text === name)) &&
      ts.isStringLiteral(prop.initializer)
    ) {
      return prop.initializer.text.trim().length > 0;
    }
  }
  return false;
}

/** Find the credentials map: an object literal whose keys are connector names. */
function findCredentialsMap(sf: ts.SourceFile, connectors: readonly string[]): Map<string, ts.ObjectLiteralExpression> {
  const result = new Map<string, ts.ObjectLiteralExpression>();
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      for (const prop of node.properties) {
        if (
          ts.isPropertyAssignment(prop) &&
          ts.isIdentifier(prop.name) &&
          connectors.includes(prop.name.text) &&
          ts.isObjectLiteralExpression(prop.initializer)
        ) {
          result.set(prop.name.text, prop.initializer);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return result;
}

/**
 * Assert the `privateMindstoneBootstrap` object literal wires the named key (the
 * `satisfies PrivateMindstoneBootstrap` chain would fail compilation if the key were
 * MISSING, but we assert it here too so the seam can't be silently dropped — e.g. by
 * renaming the object or detaching `satisfies` — without a gate firing).
 */
function bootstrapWiresKey(sf: ts.SourceFile, keyName: string): boolean {
  let wired = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'privateMindstoneBootstrap' &&
      node.initializer
    ) {
      // unwrap `... satisfies PrivateMindstoneBootstrap`
      let init: ts.Node = node.initializer;
      if (ts.isSatisfiesExpression(init)) init = init.expression;
      if (ts.isObjectLiteralExpression(init)) {
        for (const prop of init.properties) {
          if (
            (ts.isShorthandPropertyAssignment(prop) ||
              ts.isPropertyAssignment(prop) ||
              ts.isMethodDeclaration(prop)) &&
            prop.name !== undefined &&
            ts.isIdentifier(prop.name) &&
            prop.name.text === keyName
          ) {
            wired = true;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return wired;
}

/** The initializer expression of a top-level `const <name> = ...`, or null. */
function topLevelConstInitializer(sf: ts.SourceFile, name: string): ts.Expression | null {
  let found: ts.Expression | null = null;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      found = node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * Assert a registration callsite of the exact shape `<calleeName>(<argName>)`.
 *
 * This is the real failure seam: the original OAuth regression was a missing
 * registration, and a guard that only checks the provider data + the bootstrap key would
 * false-pass if this one call were deleted (the `satisfies` compile-check doesn't cover
 * the call site). Without this assertion the capability would resolve to the stub/null at
 * runtime with every gate green — exactly the bug family we're killing.
 *
 * The call must also be LIVE (see isLiveRegistrationStatement): a stale copy parked in a
 * dead `if (false)` branch must not satisfy the guard.
 */
function callsWithIdentifierArg(sf: ts.SourceFile, calleeName: string, argName: string): boolean {
  let registered = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === calleeName &&
      node.arguments.length === 1 &&
      ts.isIdentifier(node.arguments[0]) &&
      node.arguments[0].text === argName &&
      isLiveRegistrationStatement(node)
    ) {
      registered = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return registered;
}

/** Any call whose callee (identifier or `x.member`) is named `calleeName`, within `root`. */
function callNamed(root: ts.Node, calleeName: string): ts.CallExpression | null {
  let found: ts.CallExpression | null = null;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        (ts.isIdentifier(callee) && callee.text === calleeName) ||
        (ts.isPropertyAccessExpression(callee) && callee.name.text === calleeName)
      ) {
        found = node;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

/** Unwrap `(expr)`, `expr as T`, `expr satisfies T` down to the inner expression. */
function unwrapExpression(node: ts.Expression): ts.Expression {
  let cur: ts.Expression = node;
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur)) {
    cur = cur.expression;
  }
  return cur;
}

/**
 * Is this call a LIVE registration statement — a plain expression statement at module top
 * level or directly in a function body? Rejects calls buried in dead/conditional branches
 * (`if (false) register(...)`), loops, or expression position. Without this, a stale call
 * left behind in dead code would keep the guard green while the registration never runs
 * (GPT-5.5 stage-4 review F1 probe).
 */
function isLiveRegistrationStatement(call: ts.CallExpression): boolean {
  const stmt = call.parent;
  if (!ts.isExpressionStatement(stmt)) return false;
  const container = stmt.parent;
  if (ts.isSourceFile(container)) return true;
  return ts.isBlock(container) && ts.isFunctionLike(container.parent);
}

/** First LIVE (see isLiveRegistrationStatement) call named `calleeName` in the file. */
function liveCallNamed(sf: ts.SourceFile, calleeName: string): ts.CallExpression | null {
  let found: ts.CallExpression | null = null;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        ((ts.isIdentifier(callee) && callee.text === calleeName) ||
          (ts.isPropertyAccessExpression(callee) && callee.name.text === calleeName)) &&
        isLiveRegistrationStatement(node)
      ) {
        found = node;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * Does the object literal bind property `propName` to the exact identifier `identName`
 * (either `propName: identName` or shorthand when the names coincide)? This pins the real
 * injection shape — a no-op with the right property name does NOT count.
 */
function propertyBoundToIdentifier(obj: ts.ObjectLiteralExpression, propName: string, identName: string): boolean {
  for (const prop of obj.properties) {
    if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === propName) {
      return propName === identName;
    }
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === propName) {
      const init = unwrapExpression(prop.initializer);
      return ts.isIdentifier(init) && init.text === identName;
    }
  }
  return false;
}

/**
 * The function body of the named member of the `privateMindstoneBootstrap` object literal
 * (unwraps `satisfies`; accepts a method or a property holding an arrow/function
 * expression). Capability checks that pin "the registration happens inside the bootstrap
 * seam" search THIS body, not the whole file — otherwise the registration could move to an
 * unused helper and the guard would false-pass (GPT-5.5 stage-4 review F1 probe).
 */
function bootstrapMemberFunctionBody(sf: ts.SourceFile, keyName: string): ts.Node | null {
  let body: ts.Node | null = null;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'privateMindstoneBootstrap' &&
      node.initializer
    ) {
      const init: ts.Expression = unwrapExpression(node.initializer);
      if (ts.isObjectLiteralExpression(init)) {
        for (const prop of init.properties) {
          if (prop.name === undefined || !ts.isIdentifier(prop.name) || prop.name.text !== keyName) continue;
          if (ts.isMethodDeclaration(prop) && prop.body) {
            body = prop.body;
          } else if (ts.isPropertyAssignment(prop)) {
            const fn = unwrapExpression(prop.initializer);
            if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && fn.body) {
              body = fn.body;
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return body;
}

/**
 * Is this object-literal member backed by the REAL implementation `implName`? Backed =
 * the member IS the implementation identifier (direct reference or shorthand) or its body
 * actually CALLS it. A no-op carrying the right property name fails — that is the exact
 * false-pass the relay probe demonstrated.
 */
function memberBackedByImplementation(prop: ts.ObjectLiteralElementLike, implName: string): boolean {
  if (ts.isShorthandPropertyAssignment(prop)) return prop.name.text === implName;
  if (ts.isPropertyAssignment(prop)) {
    const init = unwrapExpression(prop.initializer);
    if (ts.isIdentifier(init) && init.text === implName) return true;
    return callNamed(init, implName) !== null;
  }
  if (ts.isMethodDeclaration(prop) && prop.body) return callNamed(prop.body, implName) !== null;
  return false;
}

/**
 * Returns true iff the factory initializer is a function whose RETURN VALUE is
 * `new <className>(...)` — a discarded `new` side effect followed by a stub return does
 * NOT count (GPT-5.5 stage-4 review F1 probe). Concise arrow bodies and block bodies
 * (every `return` in the factory itself, ignoring nested functions) are recognized.
 */
function factoryReturnsNewOf(initializer: ts.Expression, className: string): boolean {
  const fn = unwrapExpression(initializer);
  const isNewOf = (expr: ts.Expression | undefined): boolean => {
    if (!expr) return false;
    const e = unwrapExpression(expr);
    return ts.isNewExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === className;
  };
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false;
  if (!ts.isBlock(fn.body)) return isNewOf(fn.body);
  const returns: ts.ReturnStatement[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return; // returns inside nested functions are not the factory's
    if (ts.isReturnStatement(node)) returns.push(node);
    ts.forEachChild(node, collect);
  };
  fn.body.forEachChild(collect);
  return returns.length > 0 && returns.every((r) => isNewOf(r.expression));
}

/** Does `root` reference identifier `name` anywhere OUTSIDE import declarations? */
function referencesIdentifierOutsideImports(root: ts.Node, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) return; // don't descend into imports
    if (ts.isIdentifier(node) && node.text === name) {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function objectArgHasProps(call: ts.CallExpression, propNames: readonly string[]): string[] {
  const missing: string[] = [];
  const arg = call.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return [...propNames];
  const present = new Set<string>();
  for (const prop of arg.properties) {
    if (
      (ts.isPropertyAssignment(prop) ||
        ts.isShorthandPropertyAssignment(prop) ||
        ts.isMethodDeclaration(prop)) &&
      prop.name !== undefined &&
      ts.isIdentifier(prop.name)
    ) {
      present.add(prop.name.text);
    }
  }
  for (const name of propNames) {
    if (!present.has(name)) missing.push(name);
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Capability checks (each: commercial real + stub inert + bootstrap key + desktop seam)
// ---------------------------------------------------------------------------

/** Connectors that previously had embedded credentials and must be restored. */
const SECRET_REQUIRING: readonly string[] = ['google', 'slack', 'hubspot', 'github', 'plaud', 'digitalocean'];
const CLIENT_ID_ONLY: readonly string[] = ['microsoft'];
const EXPECTED: readonly string[] = [...SECRET_REQUIRING, ...CLIENT_ID_ONLY];

/**
 * Original guard (scripts/check-commercial-oauth-credentials.ts), assertions preserved
 * exactly: commercial provider complete + non-empty per connector (Microsoft is a PKCE
 * public client, clientId only); OSS stub carries NO credential literals; both bootstraps
 * wire `LIVE_OAUTH_CREDENTIALS_PROVIDER`; desktop registers the provider into the core
 * env-only resolver.
 */
export function checkOAuthCredentials(s: ParitySources): string[] {
  const errors: string[] = [];

  if (s.commercialOAuthProvider !== null) {
    const map = findCredentialsMap(parse(PARITY_FILES.commercialOAuthProvider, s.commercialOAuthProvider), EXPECTED);
    for (const connector of EXPECTED) {
      const entry = map.get(connector);
      if (!entry) {
        errors.push(`Commercial provider is missing credentials for "${connector}" (OSS-scrub regression risk).`);
        continue;
      }
      if (!nonEmptyStringProp(entry, 'clientId')) {
        errors.push(`Commercial provider "${connector}" has an empty/missing clientId.`);
      }
      if ((SECRET_REQUIRING as readonly string[]).includes(connector) && !nonEmptyStringProp(entry, 'clientSecret')) {
        errors.push(`Commercial provider "${connector}" requires a clientSecret but none is set.`);
      }
    }
  }
  if (s.commercialBootstrap !== null) {
    if (!bootstrapWiresKey(parse(PARITY_FILES.commercialBootstrap, s.commercialBootstrap), 'LIVE_OAUTH_CREDENTIALS_PROVIDER')) {
      errors.push(`${PARITY_FILES.commercialBootstrap} does not wire LIVE_OAUTH_CREDENTIALS_PROVIDER into privateMindstoneBootstrap.`);
    }
  }

  if (s.stubOAuthProvider === null) {
    errors.push(`OSS stub provider not found at ${PARITY_FILES.stubOAuthProvider}.`);
  } else {
    const stubMap = findCredentialsMap(parse(PARITY_FILES.stubOAuthProvider, s.stubOAuthProvider), EXPECTED);
    if (stubMap.size > 0) {
      errors.push(`OSS stub provider must not contain credential literals; found: ${[...stubMap.keys()].join(', ')}.`);
    }
  }
  if (s.stubBootstrap !== null && !bootstrapWiresKey(parse(PARITY_FILES.stubBootstrap, s.stubBootstrap), 'LIVE_OAUTH_CREDENTIALS_PROVIDER')) {
    errors.push(`${PARITY_FILES.stubBootstrap} does not wire LIVE_OAUTH_CREDENTIALS_PROVIDER into privateMindstoneBootstrap.`);
  }

  if (s.desktopMain !== null && !callsWithIdentifierArg(parse(PARITY_FILES.desktopMain, s.desktopMain), 'setOAuthCredentialsProvider', 'LIVE_OAUTH_CREDENTIALS_PROVIDER')) {
    errors.push(
      'src/main/index.ts does not call setOAuthCredentialsProvider(LIVE_OAUTH_CREDENTIALS_PROVIDER) — ' +
        'the injected provider would never reach the core resolver and all OAuth connectors would resolve null.',
    );
  }

  return errors;
}

/**
 * Meeting-bot backend config: both private-mindstone bootstraps must expose the provider
 * key and desktop must inject it into the core resolver. The provider's value delivery is
 * build-time-injected and guarded by scripts/check-built-bundle-meeting-bot-config.mjs;
 * this parity check only pins the commercial/stub wiring seam against OSS scrub drops.
 */
export function checkMeetingBotBackendConfig(s: ParitySources): string[] {
  const errors: string[] = [];

  if (s.commercialBootstrap !== null) {
    if (
      !bootstrapWiresKey(
        parse(PARITY_FILES.commercialBootstrap, s.commercialBootstrap),
        'LIVE_MEETING_BOT_BACKEND_CONFIG_PROVIDER',
      )
    ) {
      errors.push(
        `${PARITY_FILES.commercialBootstrap} does not wire LIVE_MEETING_BOT_BACKEND_CONFIG_PROVIDER into privateMindstoneBootstrap.`,
      );
    }
  }

  if (
    s.stubBootstrap !== null &&
    !bootstrapWiresKey(parse(PARITY_FILES.stubBootstrap, s.stubBootstrap), 'LIVE_MEETING_BOT_BACKEND_CONFIG_PROVIDER')
  ) {
    errors.push(
      `${PARITY_FILES.stubBootstrap} does not wire LIVE_MEETING_BOT_BACKEND_CONFIG_PROVIDER into privateMindstoneBootstrap.`,
    );
  }

  if (
    s.desktopMain !== null &&
    !callsWithIdentifierArg(
      parse(PARITY_FILES.desktopMain, s.desktopMain),
      'setMeetingBotBackendConfigProvider',
      'LIVE_MEETING_BOT_BACKEND_CONFIG_PROVIDER',
    )
  ) {
    errors.push(
      'src/main/index.ts does not call setMeetingBotBackendConfigProvider(LIVE_MEETING_BOT_BACKEND_CONFIG_PROVIDER) — ' +
        'the injected provider would never reach the core resolver and meeting-bot backend config would resolve null.',
    );
  }

  return errors;
}

/**
 * Auth provider: the commercial bootstrap must expose the REAL desktop auth provider and
 * the desktop must register it. The stub must stay the null provider (OSS shows
 * unauthenticated, broken-by-default).
 */
export function checkAuthProvider(s: ParitySources): string[] {
  const errors: string[] = [];

  if (s.commercialBootstrap !== null) {
    const sf = parse(PARITY_FILES.commercialBootstrap, s.commercialBootstrap);
    const init = topLevelConstInitializer(sf, 'LIVE_AUTH_PROVIDER');
    if (!init || !ts.isIdentifier(init) || init.text !== 'DESKTOP_REBEL_AUTH_PROVIDER') {
      errors.push(
        `${PARITY_FILES.commercialBootstrap}: LIVE_AUTH_PROVIDER must be DESKTOP_REBEL_AUTH_PROVIDER (the real auth provider) — ` +
          'anything else (including a stub/null provider) silently de-authenticates commercial builds.',
      );
    }
    if (!bootstrapWiresKey(sf, 'LIVE_AUTH_PROVIDER')) {
      errors.push(`${PARITY_FILES.commercialBootstrap} does not wire LIVE_AUTH_PROVIDER into privateMindstoneBootstrap.`);
    }
  }

  if (s.stubBootstrap !== null) {
    const sf = parse(PARITY_FILES.stubBootstrap, s.stubBootstrap);
    const init = topLevelConstInitializer(sf, 'LIVE_AUTH_PROVIDER');
    if (!init || !ts.isIdentifier(init) || init.text !== 'OSS_NULL_AUTH_PROVIDER') {
      errors.push(
        `${PARITY_FILES.stubBootstrap}: LIVE_AUTH_PROVIDER must stay OSS_NULL_AUTH_PROVIDER (OSS broken-by-default contract).`,
      );
    }
    if (!bootstrapWiresKey(sf, 'LIVE_AUTH_PROVIDER')) {
      errors.push(`${PARITY_FILES.stubBootstrap} does not wire LIVE_AUTH_PROVIDER into privateMindstoneBootstrap.`);
    }
  }

  if (s.desktopMain !== null && !callsWithIdentifierArg(parse(PARITY_FILES.desktopMain, s.desktopMain), 'setRebelAuthProvider', 'LIVE_AUTH_PROVIDER')) {
    errors.push(
      'src/main/index.ts does not call setRebelAuthProvider(LIVE_AUTH_PROVIDER) — ' +
        'the bootstrap auth provider would never reach the core auth seam.',
    );
  }

  return errors;
}

/**
 * Current-user provider: commercial factory must construct the real
 * `ElectronCurrentUserProvider`; the stub must NOT reference it; desktop registers the
 * factory.
 */
export function checkCurrentUserProvider(s: ParitySources): string[] {
  const errors: string[] = [];

  if (s.commercialBootstrap !== null) {
    const sf = parse(PARITY_FILES.commercialBootstrap, s.commercialBootstrap);
    const init = topLevelConstInitializer(sf, 'LIVE_CURRENT_USER_PROVIDER_FACTORY');
    if (init === null || !factoryReturnsNewOf(init, 'ElectronCurrentUserProvider')) {
      errors.push(
        `${PARITY_FILES.commercialBootstrap}: LIVE_CURRENT_USER_PROVIDER_FACTORY must construct ElectronCurrentUserProvider ` +
          'AS ITS RETURN VALUE (the real current-user provider) — a discarded `new` plus a stub return, or any other factory ' +
          'shape, silently falls commercial builds back to an anonymous user.',
      );
    }
    if (!bootstrapWiresKey(sf, 'LIVE_CURRENT_USER_PROVIDER_FACTORY')) {
      errors.push(`${PARITY_FILES.commercialBootstrap} does not wire LIVE_CURRENT_USER_PROVIDER_FACTORY into privateMindstoneBootstrap.`);
    }
  }

  if (s.stubBootstrap !== null) {
    const sf = parse(PARITY_FILES.stubBootstrap, s.stubBootstrap);
    if (referencesIdentifierOutsideImports(sf, 'ElectronCurrentUserProvider')) {
      errors.push(`${PARITY_FILES.stubBootstrap} must not reference ElectronCurrentUserProvider (OSS stays stub-only).`);
    }
    if (!bootstrapWiresKey(sf, 'LIVE_CURRENT_USER_PROVIDER_FACTORY')) {
      errors.push(`${PARITY_FILES.stubBootstrap} does not wire LIVE_CURRENT_USER_PROVIDER_FACTORY into privateMindstoneBootstrap.`);
    }
  }

  if (
    s.desktopMain !== null &&
    !callsWithIdentifierArg(parse(PARITY_FILES.desktopMain, s.desktopMain), 'setCurrentUserProviderFactory', 'LIVE_CURRENT_USER_PROVIDER_FACTORY')
  ) {
    errors.push(
      'src/main/index.ts does not call setCurrentUserProviderFactory(LIVE_CURRENT_USER_PROVIDER_FACTORY) — ' +
        'the bootstrap current-user provider would never reach the core seam.',
    );
  }

  return errors;
}

/**
 * Contribution relay: the commercial `registerPrivateMindstoneHandlers` BODY must register
 * the relay extension with each member backed by its real implementation
 * (submit → submitViaRelay, refreshStatus → refreshStatusViaRelay, notifyPublished); the
 * stub must NOT register one (OSS submits via the public GitHub-PR path); desktop must
 * LIVE-call `registerPrivateMindstoneHandlers(getHandlerRegistry())` (dead/conditional
 * leftovers don't count).
 */
const RELAY_MEMBER_IMPLS: ReadonlyArray<readonly [member: string, impl: string]> = [
  ['submit', 'submitViaRelay'],
  ['refreshStatus', 'refreshStatusViaRelay'],
  ['notifyPublished', 'notifyPublished'],
];

export function checkContributionRelay(s: ParitySources): string[] {
  const errors: string[] = [];

  if (s.commercialBootstrap !== null) {
    const sf = parse(PARITY_FILES.commercialBootstrap, s.commercialBootstrap);
    const handlersBody = bootstrapMemberFunctionBody(sf, 'registerPrivateMindstoneHandlers');
    const call = handlersBody ? callNamed(handlersBody, 'registerContributionRelayExtension') : null;
    if (!call) {
      errors.push(
        `${PARITY_FILES.commercialBootstrap} does not call registerContributionRelayExtension inside the ` +
          'registerPrivateMindstoneHandlers bootstrap member — commercial contribution sharing would silently fall back to the OSS path.',
      );
    } else {
      const missing = objectArgHasProps(call, RELAY_MEMBER_IMPLS.map(([member]) => member));
      if (missing.length > 0) {
        errors.push(
          `${PARITY_FILES.commercialBootstrap}: registerContributionRelayExtension is missing extension member(s): ${missing.join(', ')}.`,
        );
      }
      const arg = call.arguments[0];
      if (arg !== undefined && ts.isObjectLiteralExpression(arg)) {
        for (const [member, impl] of RELAY_MEMBER_IMPLS) {
          const prop = arg.properties.find(
            (p) => p.name !== undefined && ts.isIdentifier(p.name) && p.name.text === member,
          );
          if (prop !== undefined && !memberBackedByImplementation(prop, impl)) {
            errors.push(
              `${PARITY_FILES.commercialBootstrap}: registerContributionRelayExtension member "${member}" is not backed by ` +
                `${impl} — a no-op carrying the right property name silently breaks commercial contribution sharing.`,
            );
          }
        }
      }
    }
    if (!bootstrapWiresKey(sf, 'registerPrivateMindstoneHandlers')) {
      errors.push(`${PARITY_FILES.commercialBootstrap} does not wire registerPrivateMindstoneHandlers into privateMindstoneBootstrap.`);
    }
  }

  if (s.stubBootstrap !== null) {
    const sf = parse(PARITY_FILES.stubBootstrap, s.stubBootstrap);
    if (callNamed(sf, 'registerContributionRelayExtension')) {
      errors.push(`${PARITY_FILES.stubBootstrap} must not register a contribution relay extension (OSS stays stub-only).`);
    }
    if (!bootstrapWiresKey(sf, 'registerPrivateMindstoneHandlers')) {
      errors.push(`${PARITY_FILES.stubBootstrap} does not wire registerPrivateMindstoneHandlers into privateMindstoneBootstrap.`);
    }
  }

  if (s.desktopMain !== null) {
    const call = liveCallNamed(parse(PARITY_FILES.desktopMain, s.desktopMain), 'registerPrivateMindstoneHandlers');
    const arg = call?.arguments.length === 1 ? call.arguments[0] : undefined;
    const passesRegistry =
      arg !== undefined &&
      ts.isCallExpression(arg) &&
      ts.isIdentifier(arg.expression) &&
      arg.expression.text === 'getHandlerRegistry' &&
      arg.arguments.length === 0;
    if (!passesRegistry) {
      errors.push(
        'src/main/index.ts does not LIVE-call registerPrivateMindstoneHandlers(getHandlerRegistry()) as an unconditional ' +
          'statement — no private-mindstone IPC handlers (incl. the contribution relay and auth handlers) would ever register ' +
          '(a call in dead/conditional code does not count).',
      );
    }
  }

  return errors;
}

/**
 * Auth-config refresh: the commercial `forceAuthConfigRefresh` must invoke the real
 * `fetchAuthConfig` (the stub is a deliberate no-op); the desktop must inject
 * `forceAuthConfigRefresh` as the `fetchAuthConfig` dependency of a
 * `fetchWithSubscriptionRetry(...)` call — the actual seam — not merely reference the
 * identifier somewhere (a stray `void forceAuthConfigRefresh;` must not count).
 */
function subscriptionRetryInjectsRefresh(sf: ts.SourceFile): boolean {
  let injected = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'fetchWithSubscriptionRetry') {
      for (const arg of node.arguments) {
        const obj = unwrapExpression(arg);
        if (ts.isObjectLiteralExpression(obj) && propertyBoundToIdentifier(obj, 'fetchAuthConfig', 'forceAuthConfigRefresh')) {
          injected = true;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return injected;
}

export function checkAuthConfigRefresh(s: ParitySources): string[] {
  const errors: string[] = [];

  if (s.commercialBootstrap !== null) {
    const sf = parse(PARITY_FILES.commercialBootstrap, s.commercialBootstrap);
    const init = topLevelConstInitializer(sf, 'forceAuthConfigRefresh');
    if (!init || !callNamed(init, 'fetchAuthConfig')) {
      errors.push(
        `${PARITY_FILES.commercialBootstrap}: forceAuthConfigRefresh must call fetchAuthConfig (the real refresh) — ` +
          'a no-op here silently breaks subscription/auth-config refresh in commercial builds.',
      );
    }
    if (!bootstrapWiresKey(sf, 'forceAuthConfigRefresh')) {
      errors.push(`${PARITY_FILES.commercialBootstrap} does not wire forceAuthConfigRefresh into privateMindstoneBootstrap.`);
    }
  }

  if (s.stubBootstrap !== null) {
    const sf = parse(PARITY_FILES.stubBootstrap, s.stubBootstrap);
    if (referencesIdentifierOutsideImports(sf, 'fetchAuthConfig')) {
      errors.push(`${PARITY_FILES.stubBootstrap}: forceAuthConfigRefresh must stay a no-op (no fetchAuthConfig) in the OSS stub.`);
    }
    if (!bootstrapWiresKey(sf, 'forceAuthConfigRefresh')) {
      errors.push(`${PARITY_FILES.stubBootstrap} does not wire forceAuthConfigRefresh into privateMindstoneBootstrap.`);
    }
  }

  if (s.desktopDeepLink !== null && !subscriptionRetryInjectsRefresh(parse(PARITY_FILES.desktopDeepLink, s.desktopDeepLink))) {
    errors.push(
      `${PARITY_FILES.desktopDeepLink} never consumes forceAuthConfigRefresh as the fetchAuthConfig dependency of ` +
        'fetchWithSubscriptionRetry(...) — the subscription checkout retry seam would lose its auth-config refresh ' +
        'dependency (a bare reference to the identifier elsewhere does not count).',
    );
  }

  return errors;
}

/**
 * Auth health check: the commercial `registerPrivateMindstoneHealthCheck` BODY must
 * register the real `checkAuthHealth` (a registration parked in an unused helper does not
 * count); the desktop must LIVE-call
 * `registerPrivateMindstoneHealthCheck({ registerAuthHealthCheck: setAuthHealthCheck })`
 * so the registration actually happens (dead/conditional leftovers don't count).
 */
export function checkAuthHealthCheck(s: ParitySources): string[] {
  const errors: string[] = [];

  if (s.commercialBootstrap !== null) {
    const sf = parse(PARITY_FILES.commercialBootstrap, s.commercialBootstrap);
    const healthBody = bootstrapMemberFunctionBody(sf, 'registerPrivateMindstoneHealthCheck');
    const call = healthBody ? callNamed(healthBody, 'registerAuthHealthCheck') : null;
    const firstArg = call !== null && call.arguments.length === 1 ? call.arguments[0] : undefined;
    if (firstArg === undefined || !ts.isIdentifier(firstArg) || firstArg.text !== 'checkAuthHealth') {
      errors.push(
        `${PARITY_FILES.commercialBootstrap} does not register checkAuthHealth via registerAuthHealthCheck inside the ` +
          'registerPrivateMindstoneHealthCheck bootstrap member — commercial builds would lose the real auth health signal ' +
          '(a registration outside that member never runs).',
      );
    }
    if (!bootstrapWiresKey(sf, 'registerPrivateMindstoneHealthCheck')) {
      errors.push(`${PARITY_FILES.commercialBootstrap} does not wire registerPrivateMindstoneHealthCheck into privateMindstoneBootstrap.`);
    }
  }

  if (s.stubBootstrap !== null) {
    const sf = parse(PARITY_FILES.stubBootstrap, s.stubBootstrap);
    const healthBody = bootstrapMemberFunctionBody(sf, 'registerPrivateMindstoneHealthCheck');
    if (!healthBody || !callNamed(healthBody, 'registerAuthHealthCheck')) {
      errors.push(`${PARITY_FILES.stubBootstrap} does not register an auth health check (OSS must report a pass/stub state, not nothing).`);
    }
    if (!bootstrapWiresKey(sf, 'registerPrivateMindstoneHealthCheck')) {
      errors.push(`${PARITY_FILES.stubBootstrap} does not wire registerPrivateMindstoneHealthCheck into privateMindstoneBootstrap.`);
    }
  }

  if (s.desktopMain !== null) {
    const call = liveCallNamed(parse(PARITY_FILES.desktopMain, s.desktopMain), 'registerPrivateMindstoneHealthCheck');
    const arg = call?.arguments.length === 1 ? call.arguments[0] : undefined;
    const wiresRealSink =
      arg !== undefined &&
      ts.isObjectLiteralExpression(arg) &&
      propertyBoundToIdentifier(arg, 'registerAuthHealthCheck', 'setAuthHealthCheck');
    if (!wiresRealSink) {
      errors.push(
        'src/main/index.ts does not LIVE-call registerPrivateMindstoneHealthCheck({ registerAuthHealthCheck: setAuthHealthCheck }) ' +
          'as an unconditional statement — no auth health check would ever register (a call in dead/conditional code does not count).',
      );
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface CommercialCapability {
  readonly id: string;
  /**
   * 'error' → exit 1 on violation. 'report' → print, exit 0 (FP-check stage; see rec
   * cca89241502c9db7: "FP-check before error-gating"). All current entries passed the
   * FP-check on the 260610 tree, so all are error-gated.
   */
  readonly enforcement: 'error' | 'report';
  /** `PrivateMindstoneBootstrap` interface keys this entry guards (surface-coverage check). */
  readonly coversBootstrapKeys: readonly string[];
  readonly check: (sources: ParitySources) => string[];
}

export const COMMERCIAL_CAPABILITIES: readonly CommercialCapability[] = [
  { id: 'oauth-credentials', enforcement: 'error', coversBootstrapKeys: ['LIVE_OAUTH_CREDENTIALS_PROVIDER'], check: checkOAuthCredentials },
  {
    id: 'meeting-bot-backend-config',
    enforcement: 'error',
    coversBootstrapKeys: ['LIVE_MEETING_BOT_BACKEND_CONFIG_PROVIDER'],
    check: checkMeetingBotBackendConfig,
  },
  { id: 'auth-provider', enforcement: 'error', coversBootstrapKeys: ['LIVE_AUTH_PROVIDER'], check: checkAuthProvider },
  { id: 'current-user-provider', enforcement: 'error', coversBootstrapKeys: ['LIVE_CURRENT_USER_PROVIDER_FACTORY'], check: checkCurrentUserProvider },
  { id: 'contribution-relay', enforcement: 'error', coversBootstrapKeys: ['registerPrivateMindstoneHandlers'], check: checkContributionRelay },
  { id: 'auth-config-refresh', enforcement: 'error', coversBootstrapKeys: ['forceAuthConfigRefresh'], check: checkAuthConfigRefresh },
  { id: 'auth-health-check', enforcement: 'error', coversBootstrapKeys: ['registerPrivateMindstoneHealthCheck'], check: checkAuthHealthCheck },
];

// ---------------------------------------------------------------------------
// Anti-rot: registry must cover the whole PrivateMindstoneBootstrap surface
// ---------------------------------------------------------------------------

export const BOOTSTRAP_CONTRACT_FILE = 'src/core/services/privateMindstoneBootstrap.ts';

/**
 * Keys of `PrivateMindstoneBootstrap` deliberately NOT guarded by a registry entry:
 * compile-pinned mode/marker literals with no real-vs-stub "forgotten wiring" failure mode
 * (covered by modePurity.test.ts + the runtime mode log line).
 */
export const KNOWN_UNGUARDED_BOOTSTRAP_KEYS: readonly string[] = [
  'PRIVATE_MINDSTONE_BOOTSTRAP_MODE',
  'PRIVATE_MINDSTONE_BOOTSTRAP_BUNDLE_MARKER',
];

/**
 * Every property of the `PrivateMindstoneBootstrap` interface must be covered by a
 * registry entry or explicitly allowlisted. This is what makes the guard hold for FUTURE
 * capabilities: adding a bootstrap key without deciding how it's guarded fails the gate,
 * instead of silently joining the unguarded set (the exact rot path that made the original
 * guard OAuth-only).
 */
export function checkBootstrapSurfaceCoverage(contractSource: string): string[] {
  const errors: string[] = [];
  const sf = parse(BOOTSTRAP_CONTRACT_FILE, contractSource);
  const covered = new Set<string>([
    ...COMMERCIAL_CAPABILITIES.flatMap((c) => c.coversBootstrapKeys),
    ...KNOWN_UNGUARDED_BOOTSTRAP_KEYS,
  ]);
  let interfaceFound = false;
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'PrivateMindstoneBootstrap') {
      interfaceFound = true;
      for (const member of node.members) {
        if ((ts.isPropertySignature(member) || ts.isMethodSignature(member)) && ts.isIdentifier(member.name)) {
          if (!covered.has(member.name.text)) {
            errors.push(
              `PrivateMindstoneBootstrap key "${member.name.text}" has no commercial-capability registry entry ` +
                '(scripts/check-commercial-capability-parity.ts) and is not in KNOWN_UNGUARDED_BOOTSTRAP_KEYS — ' +
                'decide how the new capability is guarded against the oss_scrub_commercial_capability_drop family.',
            );
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!interfaceFound) {
    errors.push(`PrivateMindstoneBootstrap interface not found in ${BOOTSTRAP_CONTRACT_FILE} — update this guard if it moved.`);
  }
  return errors;
}

export function readParitySourcesFromDisk(repoRoot: string = REPO_ROOT): ParitySources {
  const sources = {} as Record<ParityFileRole, string | null>;
  for (const [role, rel] of Object.entries(PARITY_FILES) as Array<[ParityFileRole, string]>) {
    const abs = resolve(repoRoot, rel);
    sources[role] = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
  }
  return sources;
}

function main(): void {
  const sources = readParitySourcesFromDisk();

  // Stub + desktop files must always exist (they are part of the OSS tree itself).
  // desktopDeepLink hosts the subscription-checkout retry seam (extracted from
  // index.ts in the 260623 startup refactor); requiring it here makes path drift on
  // the deep-link handler fail directly in the CLI, not just via tests/TS.
  const required: ParityFileRole[] = ['stubBootstrap', 'desktopMain', 'stubOAuthProvider', 'desktopDeepLink'];
  const missingRequired = required.filter((role) => sources[role] === null);
  if (missingRequired.length > 0) {
    console.error('✗ check-commercial-capability-parity FAILED:');
    for (const role of missingRequired) {
      console.error(`  - required file not found: ${PARITY_FILES[role]} — update PARITY_FILES if it moved.`);
    }
    process.exit(1);
  }

  if (sources.commercialBootstrap === null) {
    console.log('[check-commercial-capability-parity] commercial tree absent (OSS checkout) — skipping commercial-side assertions.');
  }

  const hardErrors: string[] = [];
  const reportOnly: string[] = [];
  for (const capability of COMMERCIAL_CAPABILITIES) {
    const errors = capability.check(sources).map((e) => `[${capability.id}] ${e}`);
    if (capability.enforcement === 'error') hardErrors.push(...errors);
    else reportOnly.push(...errors);
  }

  const contractAbs = resolve(REPO_ROOT, BOOTSTRAP_CONTRACT_FILE);
  if (!existsSync(contractAbs)) {
    hardErrors.push(`[surface-coverage] required file not found: ${BOOTSTRAP_CONTRACT_FILE} — update this guard if it moved.`);
  } else {
    hardErrors.push(...checkBootstrapSurfaceCoverage(readFileSync(contractAbs, 'utf8')).map((e) => `[surface-coverage] ${e}`));
  }

  if (reportOnly.length > 0) {
    console.warn('⚠ check-commercial-capability-parity report-only findings (not yet error-gated):');
    for (const e of reportOnly) console.warn(`  - ${e}`);
  }

  if (hardErrors.length > 0) {
    console.error('✗ check-commercial-capability-parity FAILED:');
    for (const e of hardErrors) console.error(`  - ${e}`);
    process.exit(1);
  }

  console.log(
    `✓ check-commercial-capability-parity: ${COMMERCIAL_CAPABILITIES.length} capabilities checked ` +
      `(${COMMERCIAL_CAPABILITIES.map((c) => c.id).join(', ')}); commercial wired; OSS stubs inert; desktop registers each seam.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

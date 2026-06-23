#!/usr/bin/env npx tsx
/**
 * BTS transport symmetry CI check (Stage 7 — PLAN.md; PM 260428 action #4).
 *
 * Every dispatchable BTS transport implements the same `BtsTransportAdapter`
 * interface and declares a `requiredBehaviors` descriptor. This script statically
 * verifies — via the TypeScript AST, not a runtime stub — that each adapter's
 * IMPLEMENTATION actually does what its descriptor claims. It is the machine
 * enforcement of the symmetry that was previously prose and silently regressed:
 *
 *   - PM 260428: `callProfileHttp` regressed from throwing a classified
 *     `ModelError` on 4xx to a generic `Error` (broke cooldown, the
 *     JSON-capability heuristic, and agentErrorCatalog at once).
 *   - PM 260429: a transport silently dropped cooldown recording.
 *   - PM 260429: the Codex proxy returned SSE to a JSON client (lost SSE guard).
 *   - investigation 260509 / PM 260427: a transport dropped `outputFormat`.
 *
 * Stage 10 — cooldown recording moved to the DISPATCH layer. The actual
 * `cooldown.record*` call no longer lives in any adapter body; it lives once in
 * `executeBtsPlan` (behindTheScenesClient.ts). The `recordsCooldown` behaviour is
 * therefore checked in TWO places now:
 *   1. a DISPATCH-SITE assertion (run once) that `executeBtsPlan` records both
 *      success and rate-limit via the dispatch-layer recorders, so coverage holds
 *      for ALL transports by construction (including the dormant
 *      anthropic-compatible-local-proxy, whose prior `recordsCooldown:false`
 *      exception is now resolved — asserted, not silently dropped);
 *   2. a per-adapter check that an adapter declaring `recordsCooldown:true` and
 *      classifying its own HTTP 4xx emits the typed cooldown signal
 *      (`attachCooldownRateLimitSignal`) so the dispatch recorder has data to act on.
 *
 * For each behaviour declared `true`, the adapter's source MUST contain the
 * corresponding marker(s). For `sentryViaCaptureKnownConditionOnly` we assert an
 * ABSENCE (no direct `captureException`). The registry is the source of truth for
 * which transports exist (exhaustive `Record<BtsTransport, …>`), so a new
 * transport added without an adapter is already a TypeScript error; this script
 * closes the "adapter exists but quietly omits a behaviour" gap.
 *
 * Each adapter additionally declares the behaviour set in `requiredBehaviors`;
 * the registry must expose exactly the dispatchable transports — this script
 * also asserts that coverage so a transport cannot be added without a reviewed
 * symmetry contract.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const transportsDir = resolve(repoRoot, 'src/core/services/bts/transports');
const registryFile = resolve(transportsDir, 'index.ts');
const dispatchFile = resolve(repoRoot, 'src/core/services/behindTheScenesClient.ts');
const cooldownFile = resolve(repoRoot, 'src/core/services/bts/cooldown.ts');

/**
 * Stage 10 dispatch-coverage assertion. Cooldown recording is now centralised in
 * `executeBtsPlan` (behindTheScenesClient.ts), so coverage holds for EVERY
 * transport — including the dormant anthropic-compatible-local-proxy — by
 * construction. Assert that:
 *   - the dispatch core invokes BOTH the success and the rate-limit recorders, so
 *     no transport can silently lose recording (PM 260429), and
 *   - the recorders actually call `cooldown.recordSuccess` / `recordRateLimit` in
 *     `bts/cooldown.ts` (so the dispatch call is not an inert wrapper).
 * This replaces the per-adapter `recordCooldown*` body check Stage 7 used and
 * resolves the dormant transport's prior `recordsCooldown:false` exception by
 * verifying dispatch covers it, rather than by carrying an exception.
 */
function checkDispatchCooldownCoverage(errors: string[]): void {
  let dispatchSource: string;
  let cooldownSource: string;
  try {
    dispatchSource = stripComments(readFileSync(dispatchFile, 'utf8'));
    cooldownSource = stripComments(readFileSync(cooldownFile, 'utf8'));
  } catch (err) {
    errors.push(`Failed to read dispatch/cooldown source for cooldown-coverage check: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // 1. The dispatch core records BOTH success and rate-limit (call form).
  if (!/\brecordBtsCooldownSuccess\s*\(/.test(dispatchSource)) {
    errors.push(
      '[behindTheScenesClient.ts] dispatch layer does not call recordBtsCooldownSuccess(...). ' +
      'Stage 10 centralises cooldown SUCCESS recording at executeBtsPlan; without it no transport records success.',
    );
  }
  if (!/\brecordBtsCooldownRateLimitFromError\s*\(/.test(dispatchSource)) {
    errors.push(
      '[behindTheScenesClient.ts] dispatch layer does not call recordBtsCooldownRateLimitFromError(...). ' +
      'Stage 10 centralises cooldown RATE-LIMIT recording at executeBtsPlan; without it no transport records 429s (PM 260429 class).',
    );
  }

  // 2. The recorders are not inert — they reach the underlying cooldown instance.
  if (!/\bcooldown\.recordSuccess\s*\(/.test(cooldownSource)) {
    errors.push(
      '[bts/cooldown.ts] recordBtsCooldownSuccess does not call cooldown.recordSuccess(...). The dispatch recorder is inert.',
    );
  }
  if (!/\bcooldown\.recordRateLimit\s*\(/.test(cooldownSource)) {
    errors.push(
      '[bts/cooldown.ts] recordBtsCooldownRateLimitFromError does not call cooldown.recordRateLimit(...). The dispatch recorder is inert.',
    );
  }
}

/**
 * Stage 10 refinement — entry-point cooldown-coverage assertion.
 *
 * `checkDispatchCooldownCoverage` proves the DISPATCH layer records, but it has a
 * blind spot that is exactly the F1 regression: it never asserts that every public
 * BTS entry point actually REACHES that recorder. `callWithModel` historically
 * invoked the transports (`callDirectWithProfile`/`callAnthropic`) DIRECTLY from
 * its callback, bypassing `executeBtsPlan` entirely — so after Stage 10 moved
 * recording to dispatch it silently recorded nothing, on a public entry point.
 *
 * This check closes that blind spot mechanically. For every exported BTS entry
 * point (`call(BehindTheScenes|WithModel)*`), its function body MUST satisfy at
 * least one of:
 *   (a) route through dispatch — call `executeBtsPlan` or
 *       `executeBtsPlanWithOperationalFallback` (which records by construction), OR
 *   (b) record itself — call BOTH `recordBtsCooldownSuccess` AND
 *       `recordBtsCooldownRateLimitFromError` directly (the seam used by
 *       `callWithModel`, which can't route through dispatch because its callback
 *       hand-rolls the transport selection).
 * An entry point that invokes a transport without satisfying either is the F1
 * class and fails CI — so a future entry point, or a reactivated `callWithModel`
 * that drops recording, cannot ship a silent bypass.
 *
 * Robustness: the recorder/dispatch names are matched as CALL forms in the entry
 * point's own AST body (nested arrow callbacks included), not as bare identifiers,
 * so an unused import or a comment cannot satisfy the check. An entry point that
 * legitimately performs no transport call (none today) would need to be added to
 * NON_RECORDING_ENTRY_POINTS with a rationale — there is deliberately no such
 * escape hatch wired in, to keep the check non-gameable.
 */
const ENTRY_POINT_NAME = /^call(BehindTheScenes|WithModel)/;
const TRANSPORT_INVOCATION_CALLS = ['callDirectWithProfile', 'callAnthropic'];
const DISPATCH_CALLS = ['executeBtsPlan', 'executeBtsPlanWithOperationalFallback'];
const DIRECT_RECORDER_CALLS = ['recordBtsCooldownSuccess', 'recordBtsCooldownRateLimitFromError'];

function calledFunctionNames(fnBody: ts.Node): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) {
        names.add(callee.text);
      } else if (ts.isPropertyAccessExpression(callee)) {
        names.add(callee.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fnBody);
  return names;
}

function checkEntryPointCooldownCoverage(errors: string[]): void {
  let source: string;
  try {
    source = readFileSync(dispatchFile, 'utf8');
  } catch (err) {
    errors.push(`Failed to read dispatch source for entry-point cooldown-coverage check: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const sf = ts.createSourceFile(dispatchFile, source, ts.ScriptTarget.Latest, true);

  let entryPointsSeen = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      ENTRY_POINT_NAME.test(node.name.text) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
      node.body
    ) {
      entryPointsSeen += 1;
      const name = node.name.text;
      const calls = calledFunctionNames(node.body);

      const routesThroughDispatch = DISPATCH_CALLS.some((c) => calls.has(c));
      const recordsDirectly = DIRECT_RECORDER_CALLS.every((c) => calls.has(c));
      const invokesTransportDirectly = TRANSPORT_INVOCATION_CALLS.some((c) => calls.has(c));

      if (!routesThroughDispatch && !recordsDirectly) {
        errors.push(
          `[behindTheScenesClient.ts] entry point \`${name}\` obtains a transport response without reaching the central cooldown recorder. ` +
          `It must either route through dispatch (${DISPATCH_CALLS.join('/')}) or record directly (both ${DIRECT_RECORDER_CALLS.join(' AND ')}). ` +
          (invokesTransportDirectly
            ? `It calls a transport (${TRANSPORT_INVOCATION_CALLS.join('/')}) directly — this is the F1 silent-bypass class (PM 260429): a public entry point that records no 429s/successes.`
            : 'Add the recorder seam before giving it a transport call.'),
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  if (entryPointsSeen === 0) {
    errors.push(
      '[behindTheScenesClient.ts] entry-point cooldown-coverage check found zero exported `call(BehindTheScenes|WithModel)*` entry points — ' +
      'the dispatch module shape may have changed (checkEntryPointCooldownCoverage needs updating). Failing loudly rather than vacuously passing.',
    );
  }
}

/**
 * Dispatch-level wire-sanitization coverage. The sanitizer
 * (`sanitizeBtsOptionsForWireModel`) mints the branded `WireSafeBtsOptions`
 * every adapter's `execute` requires (compile-time half). This check asserts
 * the runtime half: the dispatch layer actually CALLS the sanitizer (so the
 * brand is earned, not just cast) — at the adapter dispatch
 * (`executeBtsPlanInner`), the terminal no-credentials fallback, and the
 * `callWithModel` direct-transport branches. Without a sanitizer call, an
 * sampling-forbidden model (e.g. Claude Fable 5 or Opus 4.8) receives the
 * caller's `temperature` and 400s every watchdog/safety/consult call.
 */
function checkDispatchWireSanitizationCoverage(errors: string[]): void {
  let dispatchSource: string;
  try {
    dispatchSource = stripComments(readFileSync(dispatchFile, 'utf8'));
  } catch (err) {
    errors.push(`Failed to read dispatch source for wire-sanitization-coverage check: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const sanitizerCalls = dispatchSource.match(/\bsanitizeBtsOptionsForWireModel\s*\(/g) ?? [];
  // One call at executeBtsPlanInner + one at the terminal fallback + three in
  // callWithModel's branches = 5. Require at least the two structurally
  // distinct seams (adapter dispatch + at least one direct-transport branch) —
  // a count floor of 2 keeps the check robust to refactors that consolidate
  // branches while still catching wholesale removal.
  if (sanitizerCalls.length < 2) {
    errors.push(
      '[behindTheScenesClient.ts] dispatch layer calls sanitizeBtsOptionsForWireModel(...) ' +
      `${sanitizerCalls.length} time(s); expected it at the adapter dispatch (executeBtsPlanInner) ` +
      'AND the direct-transport seams (terminal fallback / callWithModel). Without per-dispatch ' +
      'sanitization, sampling-forbidden models (Fable 5 / Opus 4.8 / Opus 4.7) 400 on BTS sampling params.',
    );
  }
}

/**
 * Derive the dispatchable transports AND their adapter modules from the registry
 * `index.ts` — the single source of truth. The registry's
 * `Record<BtsTransport, …>` annotation makes the map exhaustive at compile time,
 * so a transport added to the union without a registry entry is already a
 * TypeScript error; deriving the list here (rather than re-listing) means a new
 * transport is checked automatically with no second list to forget to update.
 *
 * Walks the registry object literal:
 *   - each property key `'transport': adapterIdentifier` gives the transport name
 *   - each `import { adapterIdentifier } from './module'` gives the module file
 * so we can resolve transport → adapter module via the imported identifier.
 */
function deriveTransportRegistry(): {
  transports: string[];
  adapterModules: Record<string, string>;
} {
  const source = readFileSync(registryFile, 'utf8');
  const sf = ts.createSourceFile(registryFile, source, ts.ScriptTarget.Latest, true);

  // identifier (e.g. `profileHttpAdapter`) → module file (e.g. `profile-http.ts`).
  const importedFrom = new Map<string, string>();
  // transport key → adapter identifier.
  const transportToAdapter = new Map<string, string>();

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      if (spec.startsWith('./')) {
        const moduleFile = `${spec.slice(2)}.ts`;
        const named = node.importClause?.namedBindings;
        if (named && ts.isNamedImports(named)) {
          for (const el of named.elements) {
            importedFrom.set(el.name.text, moduleFile);
          }
        }
      }
    }
    // The registry object literal: `'transport-key': adapterIdentifier,`.
    if (ts.isPropertyAssignment(node) && ts.isStringLiteralLike(node.name) && ts.isIdentifier(node.initializer)) {
      transportToAdapter.set(node.name.text, node.initializer.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  const transports: string[] = [];
  const adapterModules: Record<string, string> = {};
  for (const [transport, adapterId] of transportToAdapter) {
    transports.push(transport);
    const moduleFile = importedFrom.get(adapterId);
    if (moduleFile) adapterModules[transport] = moduleFile;
  }
  return { transports, adapterModules };
}

const { transports: EXPECTED_TRANSPORTS, adapterModules: ADAPTER_MODULES } = deriveTransportRegistry();

/** The behaviour flags every adapter must declare. */
const REQUIRED_BEHAVIOR_KEYS = [
  'recordsCooldown',
  'guardsSseViaParseJson',
  'classifiesHttpErrors',
  'propagatesOutputFormat',
  'sentryViaCaptureKnownConditionOnly',
  'extractsReasoningContent',
  'wrapsTransientRetry',
  'requiresWireSafeOptions',
] as const;
type BehaviorKey = (typeof REQUIRED_BEHAVIOR_KEYS)[number];

interface ParsedAdapter {
  module: string;
  source: string;
  /** Declared `transport` literal on the adapter object. */
  declaredTransport: string | null;
  /** The `requiredBehaviors` flag values. */
  behaviors: Partial<Record<BehaviorKey, boolean>>;
  /** Whether a `notes` rationale accompanies the descriptor. */
  hasNotes: boolean;
}

function failures(): string[] {
  return [];
}

/** Read a module and pull the `requiredBehaviors` literal + `transport` literal
 *  out of the exported adapter object via the TypeScript AST. */
function parseAdapter(moduleFile: string): ParsedAdapter {
  const filePath = resolve(transportsDir, moduleFile);
  const source = readFileSync(filePath, 'utf8');
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);

  const behaviors: Partial<Record<BehaviorKey, boolean>> = {};
  let declaredTransport: string | null = null;
  let hasNotes = false;

  const visit = (node: ts.Node): void => {
    // Find object literals that have a `requiredBehaviors` property — i.e. the
    // adapter object. Read sibling `transport` + nested `requiredBehaviors`.
    if (ts.isObjectLiteralExpression(node)) {
      const hasRequiredBehaviors = node.properties.some(
        (p) => ts.isPropertyAssignment(p) && p.name.getText(sf) === 'requiredBehaviors',
      );
      if (hasRequiredBehaviors) {
        for (const prop of node.properties) {
          if (!ts.isPropertyAssignment(prop)) continue;
          const name = prop.name.getText(sf);
          if (name === 'transport' && ts.isStringLiteralLike(prop.initializer)) {
            declaredTransport = prop.initializer.text;
          }
          if (name === 'requiredBehaviors' && ts.isObjectLiteralExpression(prop.initializer)) {
            for (const flag of prop.initializer.properties) {
              if (!ts.isPropertyAssignment(flag)) continue;
              const flagName = flag.name.getText(sf);
              if (flagName === 'notes') {
                hasNotes = true;
                continue;
              }
              const kind = flag.initializer.kind;
              if (kind === ts.SyntaxKind.TrueKeyword) behaviors[flagName as BehaviorKey] = true;
              else if (kind === ts.SyntaxKind.FalseKeyword) behaviors[flagName as BehaviorKey] = false;
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return { module: moduleFile, source, declaredTransport, behaviors, hasNotes };
}

/**
 * Behaviour → source markers (regexes) that MUST be present when the flag is
 * `true`. Markers match CALL SITES / wire-field ASSIGNMENTS, not bare
 * identifiers — so removing the actual call (while leaving an unused import)
 * still trips the check. `all` = every regex must match; `any` = at least one.
 *
 * Marker patterns are evaluated against the implementation body only (the import
 * block is stripped first), so an import alone never satisfies a behaviour.
 */
const PRESENCE_MARKERS: Record<BehaviorKey, { all?: RegExp[]; any?: RegExp[] }> = {
  // Stage 10: the actual `cooldown.record*` call lives at the DISPATCH site (see
  // the dispatch-coverage assertion in main()), NOT in adapter bodies. The
  // per-adapter half of the contract is that an adapter declaring
  // `recordsCooldown:true` SURFACES a typed rate-limit signal
  // (`attachCooldownRateLimitSignal`, call form not import) so the dispatch
  // recorder has data to record. PM 260429 — dropping this call would silently
  // stop the dispatch layer from recording that transport's 429s.
  recordsCooldown: {
    all: [/\battachCooldownRateLimitSignal\s*\(/],
  },
  // SSE guard is the dedicated parser, invoked (not merely imported).
  guardsSseViaParseJson: { all: [/\bparseJsonResponseBody\s*\(/] },
  // 4xx must be classified — either the HTTP classifier (fetch) or the generic
  // classifier (SDK), as a call. Catches the PM 260428 generic-`Error` regression
  // where the classified call was replaced by `throw new Error(...)`.
  classifiesHttpErrors: { any: [/\bclassifyHttpError\s*\(/, /\bclassifyError\s*\(/] },
  // outputFormat must reach the wire on a provider-appropriate field assignment.
  propagatesOutputFormat: {
    any: [
      /\boutput_format\s*=/,
      /\boutput_config\s*:/,
      /\bresponse_format\s*=/,
    ],
  },
  // Absence-check handled separately.
  sentryViaCaptureKnownConditionOnly: {},
  // Reasoning-model extraction: read reasoning_content via the shared translator
  // and/or strip <think> blocks. At least one must be a call (not a bare import).
  // PM 260427 — the 55-day direct-profile reasoning_content omission this whole
  // script exists to prevent; a transport that drops the call trips here.
  extractsReasoningContent: {
    any: [/\bextractOpenAITextFields\s*\(/, /\bstripThinkingBlocks\s*\(/],
  },
  // Transient-retry wrap must be an actual call site, not an unused import.
  // Invariants 23-24 — declared per-transport so the intentional proxy/non-proxy
  // asymmetry is verified rather than silently ignored.
  wrapsTransientRetry: { all: [/\bwithTransientRetry\s*\(/] },
  // The transport's options parameter must carry the branded WireSafeBtsOptions
  // type (a TYPE-position annotation, `: WireSafeBtsOptions`), so an unsanitized
  // dispatch is a compile error. The sanitizer call itself lives at the DISPATCH
  // layer — asserted by checkDispatchWireSanitizationCoverage below
  // (sampling-forbidden models reject sampling params with a 400).
  requiresWireSafeOptions: { all: [/:\s*WireSafeBtsOptions\b/] },
};

/** Strip the leading import block so markers only match the implementation. */
function implementationBody(source: string): string {
  // Remove every `import ... ;` and `import {\n...\n} from '...';` statement.
  return source.replace(/^\s*import\b[\s\S]*?from\s*['"][^'"]+['"];?\s*$/gm, '');
}

/**
 * Strip `//` line comments and block comments so a marker regex can't be
 * satisfied by a COMMENTED-OUT call (e.g. `// recordBtsCooldownSuccess(...)`).
 * Used by the dispatch-coverage check where we match raw source rather than the
 * adapter AST. Conservative — leaves string contents alone, which is fine because
 * the markers are identifiers followed by `(`, not string literals.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function checkAdapter(adapter: ParsedAdapter, errors: string[]): void {
  const where = `transports/${adapter.module}`;
  const body = implementationBody(adapter.source);

  // Every required flag must be explicitly declared (true or false).
  for (const key of REQUIRED_BEHAVIOR_KEYS) {
    if (!(key in adapter.behaviors)) {
      errors.push(`[${where}] adapter does not declare requiredBehaviors.${key}.`);
    }
  }

  // Presence checks for each behaviour declared `true`.
  for (const key of REQUIRED_BEHAVIOR_KEYS) {
    if (adapter.behaviors[key] !== true) continue;
    const markers = PRESENCE_MARKERS[key];
    if (markers.all) {
      for (const marker of markers.all) {
        if (!marker.test(body)) {
          errors.push(
            `[${where}] declares requiredBehaviors.${key}=true but its implementation is missing required call/marker \`${marker.source}\`. ` +
            'A transport claiming this behaviour must implement it (PM 260428/260429 regression class).',
          );
        }
      }
    }
    if (markers.any) {
      const hit = markers.any.some((m) => m.test(body));
      if (!hit) {
        errors.push(
          `[${where}] declares requiredBehaviors.${key}=true but its implementation matches none of: ${markers.any
            .map((m) => `\`${m.source}\``)
            .join(', ')}.`,
        );
      }
    }
  }

  // A behaviour deliberately declared `false` must carry a `notes` rationale so
  // the asymmetry is a reviewed decision, not silent drift.
  const declaredFalse = REQUIRED_BEHAVIOR_KEYS.filter((k) => adapter.behaviors[k] === false);
  if (declaredFalse.length > 0 && !adapter.hasNotes) {
    errors.push(
      `[${where}] declares ${declaredFalse.join(', ')} = false without a \`notes\` rationale. ` +
      'Deliberate omissions must be documented inline so reviewers can confirm them.',
    );
  }

  // Sentry discipline: the absence check applies to EVERY adapter regardless of
  // flag (a transport must never call captureException directly).
  if (adapter.behaviors.sentryViaCaptureKnownConditionOnly === true) {
    // Match a direct call `captureException(` (allow the word inside comments to
    // be lenient is risky — we forbid the call form specifically).
    if (/\bcaptureException\s*\(/.test(adapter.source)) {
      errors.push(
        `[${where}] declares sentryViaCaptureKnownConditionOnly=true but calls captureException(...) directly. ` +
        'Route Sentry through captureKnownCondition (PM 260424/260427 fingerprint fragmentation).',
      );
    }
  }
}

function main(): void {
  const errors = failures();

  // 0. Guard: the transport list is derived from the registry. An empty list
  //    means the registry shape changed and the AST walk no longer recognises it
  //    — fail loudly rather than vacuously pass.
  if (EXPECTED_TRANSPORTS.length === 0) {
    console.error(
      'BTS transport symmetry check FAILED:\n  - derived zero transports from transports/index.ts; ' +
      'the registry object-literal shape may have changed (deriveTransportRegistry needs updating).',
    );
    process.exit(1);
  }

  // 1. Every expected transport has an adapter module + descriptor.
  const parsedByModule = new Map<string, ParsedAdapter>();
  for (const transport of EXPECTED_TRANSPORTS) {
    const moduleFile = ADAPTER_MODULES[transport];
    if (!moduleFile) {
      errors.push(`Transport "${transport}" has no adapter module mapping in the symmetry script.`);
      continue;
    }
    if (!parsedByModule.has(moduleFile)) {
      try {
        parsedByModule.set(moduleFile, parseAdapter(moduleFile));
      } catch (err) {
        errors.push(`Failed to parse adapter module ${moduleFile}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const parsed = parsedByModule.get(moduleFile);
    if (parsed && parsed.declaredTransport === null) {
      errors.push(`[transports/${moduleFile}] no exported adapter declaring a \`transport\` literal was found.`);
    }
  }

  // 2. Symmetry checks per adapter module.
  for (const parsed of parsedByModule.values()) {
    checkAdapter(parsed, errors);
  }

  // 2b. Stage 10 — dispatch-level cooldown coverage. Asserts the central
  //     dispatch records success + rate-limit for ALL transports (so the
  //     dormant transport is covered without a per-adapter exception).
  checkDispatchCooldownCoverage(errors);

  // 2c. Stage 10 refinement — every PUBLIC entry point reaches the recorder.
  //     Closes the F1 blind spot: a public entry point (e.g. a reactivated
  //     callWithModel) that obtains a transport response without routing through
  //     dispatch OR recording directly is a silent rate-limit-recording bypass.
  checkEntryPointCooldownCoverage(errors);

  // 2d. The dispatch layer mints WireSafeBtsOptions via the sanitizer at every
  //     transport-invocation seam (sampling-forbidden models reject sampling
  //     params with a 400; the per-adapter
  //     `requiresWireSafeOptions` flag covers the receiving side).
  checkDispatchWireSanitizationCoverage(errors);

  // 3. Every derived transport key resolved to an adapter module, and its literal
  //    is present in the registry source. The list itself comes from the registry
  //    (single source of truth), so this guards against a key whose adapter
  //    identifier failed to resolve to an import.
  const registrySource = readFileSync(registryFile, 'utf8');
  for (const transport of EXPECTED_TRANSPORTS) {
    if (!registrySource.includes(`'${transport}'`)) {
      errors.push(`Registry (transports/index.ts) is missing a mapping for "${transport}".`);
    }
  }

  if (errors.length > 0) {
    console.error('BTS transport symmetry check FAILED:\n');
    for (const e of errors) console.error(`  - ${e}`);
    console.error(`\n${errors.length} symmetry violation(s).`);
    process.exit(1);
  }

  console.log(
    `BTS transport symmetry check passed — ${EXPECTED_TRANSPORTS.length} transports, ` +
    `${parsedByModule.size} adapter modules, all declared behaviours verified against implementation, ` +
    'dispatch-level cooldown coverage verified (Stage 10).',
  );
}

main();

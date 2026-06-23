#!/usr/bin/env npx tsx
/**
 * ENFORCING GATE (wired into `validate:fast`; also runnable on demand as
 * `npm run audit:cloud-push-allowlist-coverage`): inventories the cloud→desktop broadcast
 * surface and classifies each channel as allowlisted / exempt / dynamic-broadcast-reviewed /
 * undeclared, so the cloud-sync intent of every broadcast can be reviewed in one place AND a
 * forgotten declaration fails the build.
 *
 * Origin: PM 260618_autotitle_cloud_livesync_allowlist_merge_gap (rec 2 = this instrument;
 * rec 1 #e513 = the enforcing gate this tool now backs). The auto-title, show-more-activity,
 * and time-saved:status features each broadcast a per-turn/session field whose channel was
 * never added to CLOUD_PUSH_ALLOWLIST — so a cloud-executed turn's update silently never
 * reached the desktop renderer (cross_surface_asymmetry, ≥3 recurrences). The allowlist, the
 * merge predicates, and the broadcast emit-sites are parallel, hand-maintained, and invisible
 * from each other's diffs.
 *
 * ## What this gate proves (and what it does NOT — no false confidence)
 *
 * It proves: EVERY statically-resolvable cloud→desktop broadcast emit-site under the scanned
 * roots — literal channel, OR a channel resolved from a repo-wide named-constant, OR a
 * genuinely-computed channel forwarded by a `// dynamic-broadcast-reviewed:`-annotated
 * forwarding wrapper — is declared (allowlisted / exempt / dynamic-broadcast-reviewed). A NEW
 * literal or resolved-constant cloud→desktop channel that isn't declared FAILS the build; a NEW
 * computed-channel (function-parameter) emit-site that isn't human-reviewed-and-annotated also
 * FAILS the build (fail-closed on the dynamic surface — no log-and-pass). It does NOT prove
 * anything about channels emitted by mechanisms OUTSIDE the scanned function set
 * (`broadcastToAllWindows` / `sendToAllWindows` / `cloudEventBroadcaster.broadcast`) or outside
 * the scanned roots (`src/main` + `src/core` + `src/shared` + `cloud-service/src`).
 *
 * ## What this tool scans
 *
 * `broadcastToAllWindows` (the Electron-main helper) is a thin wrapper over the platform-
 * agnostic `getBroadcastService().sendToAllWindows(...)`, which CORE and cloud-wired code call
 * directly — that is the surface where the recurring class actually lives. On the cloud,
 * `getBroadcastService().sendToAllWindows` is wired to `cloudEventBroadcaster.broadcast(...)`
 * (cloud-service/src/bootstrap.ts `setBroadcastService`), and cloud-service ALSO emits cloud→desktop directly via
 * `cloudEventBroadcaster.broadcast('<channel>', …)`. So the scanned surface is all FOUR channel-bearing
 * emit shapes — `broadcastToAllWindows`, `sendToAllWindows`, `cloudEventBroadcaster.broadcast`, and the
 * schema-backed typed helper `broadcastTypedPayload` — across `src/main` + `src/core` + `src/shared` +
 * `cloud-service/src` (260620: the cloud-service roots were added so the cloud-native broadcaster's
 * literal emit-sites are enumerated, closing the structural blind spot — GPT F1 / Completeness F3).
 *
 * ## Typed-helper coverage (260620, Amendment A2)
 *
 * `broadcastTypedPayload(sink, '<channel>', payload)` (src/shared/ipc/broadcasts.ts) is the PREFERRED
 * emit API for schema-backed channels: it routes the payload through a stricter compile-time type, then
 * calls `sink.sendToAllWindows(channel, payload)` internally with a `channel` FUNCTION PARAMETER. So the
 * `sendToAllWindows` scan sees only the helper's internal forwarder (annotated dynamic-broadcast-reviewed)
 * — NOT the call sites where the real channel literal lives (`broadcastTypedPayload(..., 'memory:…', …)`).
 * Treating the helper's body as "reviewed" while leaving its call sites unscanned was a FALSE-GREEN that
 * hid live cloud-reachable gaps (`memory:write-approval-resolved`, `tool-safety:staged-call-updated`).
 * The scan therefore models each scanned function as a `{fn, channelArgIndex}` spec and includes
 * `broadcastTypedPayload` with channelArgIndex 1 (arg 0 is the BroadcastSink). Both final reviewers
 * converged on this (GPT must-address F1 + DA F1). The wrapper file broadcastHelpers.ts is excluded
 * (its internal call forwards a dynamic channel param, like the helper body itself).
 *
 * ## Named-constant resolution (260620)
 *
 * When a broadcast's first arg is an identifier (`COOLDOWN_STATUS_CHANNEL`) or a simple property
 * access (`MCP_APPS_BROADCAST_CHANNELS.PERMISSION_CHANGED`), it is resolved to its string-literal
 * value via a repo-wide constant map built from `const X = '<literal>'` and object-literal
 * `const OBJ = { KEY: '<literal>' }` declarations across the scanned roots. Resolved constants
 * become classifiable literals (this is what surfaces the cloud-reachable `cooldown:status-changed`
 * that hid behind a constant — Completeness F1). Only genuinely-computed args (a `channel`
 * function parameter in a forwarding wrapper) remain "dynamic" and are reported separately.
 *
 * ## Interception-awareness
 *
 * `cloudEventChannel.dispatchToRenderer` intercepts a handful of channels (`cloud:session-changed`,
 * `inbox:changed`, `automation:cloud-delta`, `slack:workspace-changed`, `slack:workspace-disconnected`,
 * `tokens:provider-changed`) BEFORE the allowlist check — they are handled in the main process and
 * never forwarded to the renderer. Those are DECLARED, not gaps; each carries a `// not-cloud-pushed:`
 * exemption noting the interception (precedent: the `inbox:state` exemption documents exactly this).
 *
 * ## What this tool reports
 *
 * A `broadcastToAllWindows(...)` / `sendToAllWindows(...)` / `cloudEventBroadcaster.broadcast(...)`
 * emit-site whose channel (literal or resolved-constant) is NEITHER in CLOUD_PUSH_ALLOWLIST NOR
 * covered by a `// not-cloud-pushed: <channel>` exemption comment is reported as UNDECLARED
 * (exit 1 — the triage worklist). A genuinely-dynamic (unresolvable first arg) emit-site — a
 * forwarding wrapper that re-emits whatever `channel` a caller passes — must carry a
 * `// dynamic-broadcast-reviewed: <reason>` annotation on or directly above the emit line; an
 * UNANNOTATED dynamic emit-site is also reported as UNREVIEWED and FAILS (exit 1). So a new
 * computed-channel broadcast can't be slipped past the gate without a human stating why it can't
 * introduce an unclassified cloud-reachable channel.
 *
 * ## Decision rule (how to classify a flagged channel)
 *
 * The decisive question is the one the time-saved:status exemption already documents
 * (src/main/index.ts `broadcastTimeSavedStatus`): **can a CLOUD-EXECUTED turn produce this
 * broadcast?** `broadcastToAllWindows` is Electron-main-only; the cloud path forwards a turn's
 * events to the desktop via cloudEventChannel, gated by CLOUD_PUSH_ALLOWLIST.
 *   - If the producing service runs ONLY in the Electron main process (not wired into
 *     cloud-service, not emitted from the shared core turn-execution path), a cloud turn
 *     can't produce it → it is correctly desktop-main-only → add a `// not-cloud-pushed:`
 *     exemption. (An allowlist entry would be dead config implying a capability that
 *     doesn't exist.)
 *   - If a cloud-executed turn CAN produce it and the desktop needs the live update, it is a
 *     LATENT cloud-sync gap → add it to CLOUD_PUSH_ALLOWLIST (and co-declare its merge policy
 *     in both directions per CROSS_SURFACE_PARITY_CHECKLIST — see the postmortem).
 *
 * ## Exemption convention (machine-readable)
 *
 *   // not-cloud-pushed: <channel> — <reason a cloud turn can't / shouldn't push it>
 *
 * The FIRST token after `not-cloud-pushed:` is the channel id (`segment:segment`). The
 * exemption is keyed by channel name and is global (one comment exempts that channel
 * everywhere it is emitted). Keep the comment near an emit-site so the reason stays legible.
 *
 * ## Dynamic-emit annotation convention (machine-readable, line-scoped)
 *
 *   // dynamic-broadcast-reviewed: <why this forwarder can't introduce an unclassified channel>
 *
 * A genuinely-dynamic emit-site forwards a `channel` FUNCTION PARAMETER (or a runtime
 * `event.channel`) — there is no channel name to key an exemption by, so this annotation is
 * keyed by LOCATION instead: it must sit on the emit-site's own line OR within the
 * DYNAMIC_REVIEW_WINDOW lines immediately above it (so the reason lives right at the call).
 * Annotate ONLY a true forwarding seam (it re-emits an already-classified channel its caller
 * passed) — the annotation is a human attestation, not a rubber stamp. An UNANNOTATED dynamic
 * emit-site fails the gate.
 *
 * Run: npx tsx scripts/check-cloud-push-allowlist-coverage.ts
 * @see src/main/services/cloud/cloudEventChannel.ts (CLOUD_PUSH_ALLOWLIST + the cloud→desktop push gate)
 * @see src/main/utils/broadcastHelpers.ts (broadcastToAllWindows)
 * @see cloud-service/src/cloudEventBroadcaster.ts (cloud-side broadcast → WS fan-out to desktops)
 * @see docs/project/CROSS_SURFACE_PARITY_CHECKLIST.md
 * @see docs-private/postmortems/260618_autotitle_cloud_livesync_allowlist_merge_gap_postmortem.md
 */
import { readFileSync, readdirSync, statSync, type Dirent } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Roots scanned for broadcast emit-sites + exemption comments. `cloud-service/src` is included
 * (260620) because the cloud emits cloud→desktop channels DIRECTLY via
 * `cloudEventBroadcaster.broadcast(...)`, outside `src/*` — without this root the tool was
 * structurally blind to "what cloud can push" (GPT F1 / Completeness F3).
 */
const SCAN_ROOTS: readonly string[] = ['src/main', 'src/core', 'src/shared', 'cloud-service/src'];
/** Where CLOUD_PUSH_ALLOWLIST is declared. */
const ALLOWLIST_SOURCE = 'src/main/services/cloud/cloudEventChannel.ts';

// The broadcast-to-renderer surface. `broadcastToAllWindows` (the Electron-main helper) is a
// thin wrapper over the platform-agnostic `getBroadcastService().sendToAllWindows(...)`, which
// CORE and cloud-reachable code call DIRECTLY (a cloud-executed turn forwards via this path,
// gated by CLOUD_PUSH_ALLOWLIST). On the cloud, `sendToAllWindows` is wired to
// `cloudEventBroadcaster.broadcast(...)` (cloud-service/src/bootstrap.ts `setBroadcastService`), and cloud-service
// ALSO calls `cloudEventBroadcaster.broadcast('<channel>', …)` directly — so all carry the
// cloud→desktop channel and ALL are scanned. Covering only the main-process wrapper would
// miss the surface where the recurring class (cloud-produced fields) actually lives. The wrapper
// file broadcastHelpers.ts is excluded (its internal sendToAllWindows call passes a dynamic
// channel parameter, not a literal).
//
// Each scanned emit shape is a `{fn, channelArgIndex}` spec: the index of the argument that
// carries the channel. For the direct broadcasters the channel is arg 0; for the schema-backed
// typed helper `broadcastTypedPayload(sink, '<channel>', payload)` the channel is arg 1 (arg 0 is
// the BroadcastSink). `broadcastTypedPayload` is added (Amendment A2) because its CALL SITES carry
// the literal channel — leaving them unscanned was the false-green that hid live cloud-reachable
// gaps (the helper body's internal sendToAllWindows call is a dynamic forwarder, not the literal).
interface ScannedCallSpec {
  /** Plain-identifier callee name, OR a method name matched on any receiver. */
  readonly fn: string;
  /** Argument index that carries the channel (0 for the direct broadcasters; 1 for the typed helper). */
  readonly channelArgIndex: number;
  /**
   * When set, this fn is a METHOD that is matched ONLY on this exact receiver identifier (e.g.
   * `cloudEventBroadcaster.broadcast`). When unset, the fn matches as a plain identifier call OR
   * as a method on any receiver (`obj.sendToAllWindows(...)`).
   */
  readonly receiver?: string;
}
const BROADCAST_FNS: readonly ScannedCallSpec[] = [
  { fn: 'broadcastToAllWindows', channelArgIndex: 0 },
  { fn: 'sendToAllWindows', channelArgIndex: 0 },
  // The cloud-side broadcaster: cloud-service emits cloud→desktop via `cloudEventBroadcaster.broadcast(...)`.
  // Matched ONLY on this exact receiver — there are many unrelated `.broadcast`/`broadcast` methods
  // (libraryBroadcaster.broadcast, automationScheduler.broadcast, fly-machine-repair status helpers,
  // meeting-trigger deps.broadcast) that are NOT the cloud→desktop event channel and must not be flagged.
  { fn: 'broadcast', channelArgIndex: 0, receiver: 'cloudEventBroadcaster' },
  // The schema-backed typed emit helper: `broadcastTypedPayload(sink, '<channel>', payload)` (arg 1).
  { fn: 'broadcastTypedPayload', channelArgIndex: 1 },
];
const EXCLUDED_FILES: ReadonlySet<string> = new Set(['src/main/utils/broadcastHelpers.ts']);
/** A channel id: one or more colon-separated lower-kebab segments (e.g. `time-saved:status`). */
const CHANNEL_RE = /[a-z0-9]+(?:-[a-z0-9]+)*(?::[a-z0-9]+(?:-[a-z0-9]+)*)+/;
const NOT_CLOUD_PUSHED_RE = new RegExp(String.raw`not-cloud-pushed:\s*(${CHANNEL_RE.source})`, 'g');
/**
 * A `// dynamic-broadcast-reviewed: <reason>` annotation marks a genuinely-dynamic
 * (function-parameter / `event.channel`) forwarding emit-site as human-reviewed. It is matched by
 * LINE (the comment must name no channel — the emit-site IS the key), so we capture only its
 * presence + line number.
 */
const DYNAMIC_REVIEWED_TOKEN = 'dynamic-broadcast-reviewed:';
/**
 * Lines that may sit between a `dynamic-broadcast-reviewed:` annotation block and the emit-site it
 * covers without breaking coverage: blank lines, `//` comment continuation lines, and pure
 * STRUCTURAL OPENERS (an object/array/call/arrow opener with no broadcast-bearing statement of its
 * own — e.g. `return {`, `const x: T = {`, `setBroadcastService({`, `(channel) => {`). This lets a
 * multi-line annotation sit directly above the call even when the call is nested one level inside an
 * object literal / arrow body, WITHOUT letting an annotation leak across an unrelated statement.
 */
const STRUCTURAL_OPENER_RE = /^[^;]*[{([]\s*(?:\/\/.*)?$/;

export function toPosix(p: string): string {
  return p.replaceAll('\\', '/');
}

/** Recursively collect .ts files under a root, skipping tests and node_modules/dist. */
function collectTsFiles(absRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'dist' || e.name === '__tests__') continue;
        walk(abs);
      } else if (e.isFile()) {
        if (!e.name.endsWith('.ts') && !e.name.endsWith('.tsx')) continue;
        if (e.name.endsWith('.test.ts') || e.name.endsWith('.test.tsx')) continue;
        out.push(abs);
      }
    }
  };
  if (statSafe(absRoot)) walk(absRoot);
  return out;
}

function statSafe(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export interface BroadcastEmit {
  relativePath: string;
  line: number;
  channel: string;
  /** Set when the channel was resolved from a named constant (`COOLDOWN_STATUS_CHANNEL`). */
  resolvedFrom?: string;
}

export interface DynamicEmit {
  relativePath: string;
  line: number;
  argText: string;
  /**
   * True when a `// dynamic-broadcast-reviewed:` annotation sits on this emit-site's line or
   * within DYNAMIC_REVIEW_WINDOW lines above it (set during the scan). An UNREVIEWED dynamic
   * emit-site fails the gate.
   */
  reviewed: boolean;
}

/**
 * Parse the `CLOUD_PUSH_ALLOWLIST = new Set([ … ])` declaration from cloudEventChannel.ts via
 * the TS compiler and return the set of allowlisted channel ids — the string-literal array
 * elements ONLY. This is comment- and apostrophe-immune: the previous regex (`/'([^']+)'/g`)
 * desynced its quote-pairing on the apostrophes inside the allowlist's comments
 * (`renderer's`, `can't`, `doesn't`), which BOTH captured comment fragments as fake channels
 * AND silently dropped real entries that followed such a comment (verified missing:
 * external-delivery:failed, conversations:start-requested, intent:*). PM 260618 / Chief F1.
 */
export function parseAllowlist(sourceText: string): Set<string> {
  const channels = new Set<string>();
  const sf = ts.createSourceFile('allowlist.ts', sourceText, ts.ScriptTarget.Latest, true);
  let found: ts.ArrayLiteralExpression | undefined;
  const visit = (n: ts.Node): void => {
    if (found) return;
    // Match `... CLOUD_PUSH_ALLOWLIST = new Set([ … ])`.
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === 'CLOUD_PUSH_ALLOWLIST' &&
      n.initializer &&
      ts.isNewExpression(n.initializer) &&
      ts.isIdentifier(n.initializer.expression) &&
      n.initializer.expression.text === 'Set'
    ) {
      const firstArg = n.initializer.arguments?.[0];
      if (firstArg && ts.isArrayLiteralExpression(firstArg)) {
        found = firstArg;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!found) return channels;
  for (const el of found.elements) {
    if (ts.isStringLiteralLike(el)) channels.add(el.text);
  }
  return channels;
}

/**
 * Build a repo-wide map of `CONST_NAME` / `OBJECT.MEMBER` → string-literal channel value, so a
 * broadcast whose first arg is a named constant can be resolved to its literal. Covers two shapes:
 *   - `const X = 'channel:name'` (and `export const X = '…' as const`) → key `X`
 *   - `const OBJ = { KEY: 'channel:name', … }` → key `OBJ.KEY`
 * Names are globally unique across the scanned roots for the channels we resolve (verified 260620),
 * so a flat name→literal map is safe; a colliding name simply isn't added (kept dynamic).
 */
export function buildConstantChannelMap(sourceTexts: { relativePath: string; text: string }[]): Map<string, string> {
  const map = new Map<string, string>();
  const collide = new Set<string>();
  const add = (key: string, value: string): void => {
    if (collide.has(key)) return;
    const existing = map.get(key);
    if (existing !== undefined && existing !== value) {
      // Same name, different literal across files → ambiguous; drop it (stay dynamic).
      map.delete(key);
      collide.add(key);
      return;
    }
    map.set(key, value);
  };
  // Unwrap `'x' as const` / parenthesised literals down to the underlying string literal.
  const literalOf = (expr: ts.Expression): string | undefined => {
    let e: ts.Expression = expr;
    while (ts.isAsExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
    return ts.isStringLiteralLike(e) ? e.text : undefined;
  };
  for (const { relativePath, text } of sourceTexts) {
    if (!text.includes('const ')) continue;
    const sf = ts.createSourceFile(relativePath, text, ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        const lit = literalOf(n.initializer);
        if (lit !== undefined) {
          add(n.name.text, lit);
        } else {
          // Object-literal constant: `const OBJ = { KEY: 'literal' }` → `OBJ.KEY`.
          let init: ts.Expression = n.initializer;
          while (ts.isAsExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression;
          if (ts.isObjectLiteralExpression(init)) {
            for (const prop of init.properties) {
              if (
                ts.isPropertyAssignment(prop) &&
                (ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name))
              ) {
                const propLit = literalOf(prop.initializer);
                if (propLit !== undefined) add(`${n.name.text}.${prop.name.text}`, propLit);
              }
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return map;
}

/** Collect every channel named in a `// not-cloud-pushed: <channel>` comment. */
export function parseExemptions(sourceText: string): Set<string> {
  const out = new Set<string>();
  for (const m of sourceText.matchAll(NOT_CLOUD_PUSHED_RE)) out.add(m[1]);
  return out;
}

/**
 * Decide whether a `// dynamic-broadcast-reviewed:` annotation covers the dynamic emit-site on
 * 1-based `emitLine`. The annotation is line-scoped (no channel name keys it — the emit-site is the
 * key): it must sit ON the emit line, OR in the contiguous run of comment / blank / structural-opener
 * lines DIRECTLY ABOVE it. Walking upward from `emitLine - 1`, we accept blank lines, `//` comment
 * lines (incl. multi-line annotation blocks), and pure structural-opener lines (`return {`,
 * `setBroadcastService({`, `(channel) => {`); the first line that is none of these stops the scan.
 * If a token line is seen during that walk (or on the emit line itself), the emit is reviewed. This
 * is robust to multi-line annotations and one level of object-literal / arrow nesting between the
 * comment and the call, while refusing to leak coverage across an unrelated intervening statement.
 */
export function isEmitReviewed(emitLine: number, lines: readonly string[]): boolean {
  const lineText = (oneBased: number): string => lines[oneBased - 1] ?? '';
  if (lineText(emitLine).includes(DYNAMIC_REVIEWED_TOKEN)) return true;
  for (let l = emitLine - 1; l >= 1; l--) {
    const text = lineText(l);
    if (text.includes(DYNAMIC_REVIEWED_TOKEN)) return true;
    const trimmed = text.trim();
    const isBlank = trimmed.length === 0;
    const isComment = trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
    const isOpener = STRUCTURAL_OPENER_RE.test(trimmed);
    if (!isBlank && !isComment && !isOpener) return false; // hit real intervening code → not covered
  }
  return false;
}

/**
 * Find broadcast call-sites (`broadcastToAllWindows` / `sendToAllWindows` /
 * `cloudEventBroadcaster.broadcast`): string-literal channels, named-constant channels resolved
 * to their literal via `constantMap`, and genuinely-dynamic (unresolvable) ones.
 */
export function scanBroadcasts(
  sourceText: string,
  relativePath: string,
  constantMap: Map<string, string> = new Map(),
): { literals: BroadcastEmit[]; dynamic: DynamicEmit[] } {
  const literals: BroadcastEmit[] = [];
  const dynamic: DynamicEmit[] = [];
  // Cheap pre-filter: only AST-parse files that actually call a scanned broadcast fn.
  if (!BROADCAST_FNS.some((spec) => sourceText.includes(`${spec.fn}(`))) return { literals, dynamic };
  const sf = ts.createSourceFile(relativePath, sourceText, ts.ScriptTarget.Latest, true);
  /** Resolve a non-literal first arg to a channel constant key (`X` or `OBJ.MEMBER`). */
  const constantKeyOf = (arg: ts.Expression): string | undefined => {
    if (ts.isIdentifier(arg)) return arg.text;
    if (
      ts.isPropertyAccessExpression(arg) &&
      ts.isIdentifier(arg.expression) &&
      ts.isIdentifier(arg.name)
    ) {
      return `${arg.expression.text}.${arg.name.text}`;
    }
    return undefined;
  };
  /**
   * Binding-aware (shadowing-safe) resolution — GPT-F2. The constant map is keyed by NAME only,
   * so an identifier arg shadowed by a NESTED local/param of the same name as a repo-wide channel
   * constant would otherwise over-resolve (mislabelling a genuinely-dynamic forwarder as a fixed
   * literal — a false-NEGATIVE that an enforcing gate must not hide). Before resolving an
   * identifier arg from the global map, walk UP from the emit-site collecting binding names
   * introduced by enclosing FUNCTIONS (parameters + their block-local `const`/`let`/`var` and
   * destructuring binders) and nested blocks/catch/for binders. If the identifier is bound in a
   * scope MORE LOCAL than module scope, it is NOT a repo-wide constant reference → leave it
   * dynamic. CRUCIAL: the SourceFile's OWN top-level declarations are deliberately NOT treated as
   * shadows — a module-level `const CHANNEL = '…'` IS the constant the map captured, so referencing
   * it is correct resolution, not a shadow (this is what keeps in-file constants like
   * CLOUD_STATUS_CHANGED_CHANNEL / COOLDOWN_STATUS_CHANNEL resolving). (`OBJ.MEMBER` property-access
   * keys are not affected — a local can't partially shadow a member access.)
   */
  const collectBoundNamesFromBindingName = (name: ts.BindingName, into: Set<string>): void => {
    if (ts.isIdentifier(name)) {
      into.add(name.text);
    } else {
      // Object/array destructuring pattern — collect each bound element name.
      for (const el of name.elements) {
        if (ts.isBindingElement(el)) collectBoundNamesFromBindingName(el.name, into);
      }
    }
  };
  const isLocallyBound = (identifierName: string, from: ts.Node): boolean => {
    let cur: ts.Node | undefined = from.parent;
    while (cur) {
      // STOP before the SourceFile: module-level declarations are the constants themselves, not
      // shadows. Reaching the top without a nested binding means "not shadowed → resolve".
      if (ts.isSourceFile(cur)) return false;
      const bound = new Set<string>();
      // Parameters of an enclosing function/arrow/method/constructor.
      if (
        ts.isFunctionDeclaration(cur) ||
        ts.isFunctionExpression(cur) ||
        ts.isArrowFunction(cur) ||
        ts.isMethodDeclaration(cur) ||
        ts.isConstructorDeclaration(cur)
      ) {
        for (const p of cur.parameters) collectBoundNamesFromBindingName(p.name, bound);
      }
      // Block-scoped declarations in an enclosing (non-module) block/function-body/case-block.
      ts.forEachChild(cur, (child) => {
        if (ts.isVariableStatement(child)) {
          for (const d of child.declarationList.declarations) collectBoundNamesFromBindingName(d.name, bound);
        }
      });
      // Loop/catch binders.
      if ((ts.isForStatement(cur) || ts.isForOfStatement(cur) || ts.isForInStatement(cur)) && cur.initializer && ts.isVariableDeclarationList(cur.initializer)) {
        for (const d of cur.initializer.declarations) collectBoundNamesFromBindingName(d.name, bound);
      }
      if (ts.isCatchClause(cur) && cur.variableDeclaration) {
        collectBoundNamesFromBindingName(cur.variableDeclaration.name, bound);
      }
      if (bound.has(identifierName)) return true;
      cur = cur.parent;
    }
    return false;
  };
  /**
   * Returns the matched ScannedCallSpec if `callee` is a cloud→desktop broadcast emit-site, else
   * undefined. The spec carries the channel-argument index so the visitor reads the right arg
   * (arg 0 for the direct broadcasters, arg 1 for `broadcastTypedPayload`).
   */
  const matchBroadcastCallee = (callee: ts.Expression): ScannedCallSpec | undefined => {
    // Plain `broadcastToAllWindows(...)` / `broadcastTypedPayload(...)` — match by identifier name.
    if (ts.isIdentifier(callee)) {
      return BROADCAST_FNS.find((spec) => spec.receiver === undefined && spec.fn === callee.text);
    }
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
      const method = callee.name.text;
      // A receiver-scoped spec (`cloudEventBroadcaster.broadcast(...)`) matches ONLY on its exact
      // receiver identifier so unrelated `.broadcast` methods (libraryBroadcaster, automationScheduler,
      // meeting deps, …) are excluded.
      const scoped = BROADCAST_FNS.find(
        (spec) =>
          spec.receiver !== undefined &&
          spec.fn === method &&
          ts.isIdentifier(callee.expression) &&
          callee.expression.text === spec.receiver,
      );
      if (scoped) return scoped;
      // A receiver-agnostic method (`obj.sendToAllWindows(...)`) matches on any receiver.
      return BROADCAST_FNS.find((spec) => spec.receiver === undefined && spec.fn === method);
    }
    return undefined;
  };
  const sourceLines = sourceText.split('\n');
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const spec = matchBroadcastCallee(callee);
      if (spec) {
        const arg = n.arguments[spec.channelArgIndex];
        const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
        const emitLine = line + 1;
        if (arg && ts.isStringLiteralLike(arg)) {
          literals.push({ relativePath, line: emitLine, channel: arg.text });
        } else if (arg) {
          const key = constantKeyOf(arg);
          // Shadowing-safe: a bare identifier shadowed by a local/param is NOT a repo-wide
          // constant reference — leave it dynamic (GPT-F2). Property-access keys (`OBJ.MEMBER`)
          // are resolved as before (a local can't partially shadow them).
          const shadowed = ts.isIdentifier(arg) && isLocallyBound(arg.text, n);
          const resolved = key !== undefined && !shadowed ? constantMap.get(key) : undefined;
          if (key !== undefined && resolved !== undefined) {
            literals.push({ relativePath, line: emitLine, channel: resolved, resolvedFrom: key });
          } else {
            dynamic.push({
              relativePath,
              line: emitLine,
              argText: arg.getText(sf).replace(/\s+/g, ' ').slice(0, 80),
              reviewed: isEmitReviewed(emitLine, sourceLines),
            });
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { literals, dynamic };
}

export interface CoverageResult {
  unclassified: BroadcastEmit[];
  dynamic: DynamicEmit[];
  /** Dynamic emit-sites WITHOUT a `dynamic-broadcast-reviewed` annotation — these FAIL the gate. */
  unreviewedDynamic: DynamicEmit[];
  /** Dynamic emit-sites WITH a `dynamic-broadcast-reviewed` annotation (declared, do not fail). */
  reviewedDynamicCount: number;
  staleExemptions: string[];
  allowlistedCount: number;
  exemptCount: number;
  emittedChannels: Set<string>;
}

export function computeCoverage(opts: {
  allowlist: Set<string>;
  exemptions: Set<string>;
  literals: BroadcastEmit[];
  dynamic: DynamicEmit[];
}): CoverageResult {
  const { allowlist, exemptions, literals, dynamic } = opts;
  const emittedChannels = new Set(literals.map((l) => l.channel));
  const unclassified = literals.filter((l) => !allowlist.has(l.channel) && !exemptions.has(l.channel));
  const unreviewedDynamic = dynamic.filter((d) => !d.reviewed);
  const reviewedDynamicCount = dynamic.length - unreviewedDynamic.length;
  // An exemption naming a channel that no longer has a literal emit-site → prune signal.
  const staleExemptions = [...exemptions].filter((c) => !emittedChannels.has(c));
  return {
    unclassified,
    dynamic,
    unreviewedDynamic,
    reviewedDynamicCount,
    staleExemptions,
    allowlistedCount: [...emittedChannels].filter((c) => allowlist.has(c)).length,
    exemptCount: [...emittedChannels].filter((c) => exemptions.has(c)).length,
    emittedChannels,
  };
}

export function runCoverageScan(repoRoot: string = REPO_ROOT): CoverageResult {
  const allowlistText = readFileSync(path.join(repoRoot, ALLOWLIST_SOURCE), 'utf8');
  const allowlist = parseAllowlist(allowlistText);

  // Read every scanned file once. Build the named-constant→literal map across ALL of them first
  // (a constant may be declared in one file and broadcast from another), then scan emit-sites.
  const sources: { relativePath: string; text: string }[] = [];
  for (const root of SCAN_ROOTS) {
    for (const abs of collectTsFiles(path.join(repoRoot, root))) {
      const rel = toPosix(path.relative(repoRoot, abs));
      if (EXCLUDED_FILES.has(rel)) continue;
      sources.push({ relativePath: rel, text: readFileSync(abs, 'utf8') });
    }
  }
  const constantMap = buildConstantChannelMap(sources);

  const literals: BroadcastEmit[] = [];
  const dynamic: DynamicEmit[] = [];
  const exemptions = new Set<string>();
  for (const { relativePath, text } of sources) {
    const found = scanBroadcasts(text, relativePath, constantMap);
    literals.push(...found.literals);
    dynamic.push(...found.dynamic);
    for (const c of parseExemptions(text)) exemptions.add(c);
  }
  // The allowlist source itself documents intent; also honor exemptions declared there.
  for (const c of parseExemptions(allowlistText)) exemptions.add(c);

  return computeCoverage({ allowlist, exemptions, literals, dynamic });
}

function main(): void {
  const r = runCoverageScan();

  // Stale exemptions are an advisory prune signal (never block — removing a producer should not
  // require simultaneously deleting its exemption comment in the same change).
  if (r.staleExemptions.length > 0) {
    console.warn('⚠ check-cloud-push-allowlist-coverage: not-cloud-pushed exemptions with no live emit-site (prune them):');
    for (const c of r.staleExemptions) console.warn(`  - ${c}`);
    console.warn('');
  }

  const hasFailures = r.unclassified.length > 0 || r.unreviewedDynamic.length > 0;
  if (!hasFailures) {
    console.log(
      `✓ check-cloud-push-allowlist-coverage: every cloud→desktop broadcast emit-site (literal + ` +
        `resolved-constant + reviewed-dynamic) is declared (${r.allowlistedCount} allowlisted, ` +
        `${r.exemptCount} exempt, ${r.reviewedDynamicCount} dynamic-broadcast-reviewed; ` +
        `${r.staleExemptions.length} stale).`,
    );
    return;
  }

  if (r.unclassified.length > 0) {
    console.error('✗ check-cloud-push-allowlist-coverage: broadcast channel(s) with undeclared cloud-sync intent:');
    for (const u of r.unclassified) {
      const via = u.resolvedFrom ? ` (via ${u.resolvedFrom})` : '';
      console.error(`  - ${u.relativePath}:${u.line}  broadcast('${u.channel}'${via}, …)`);
    }
    console.error('');
    console.error('Each cloud→desktop broadcast channel must declare whether a CLOUD-EXECUTED turn produces it:');
    console.error('  • If yes (desktop needs the live update): add it to CLOUD_PUSH_ALLOWLIST');
    console.error('    (src/main/services/cloud/cloudEventChannel.ts) AND co-declare its merge policy in BOTH');
    console.error('    directions — see docs/project/CROSS_SURFACE_PARITY_CHECKLIST.md.');
    console.error('  • If no (the producer is Electron-main-only): add a channel-named exemption comment:');
    console.error('      // not-cloud-pushed: <channel> — <why a cloud turn can\'t/shouldn\'t push it>');
    console.error('');
    console.error('Forgetting this is the auto-title / show-more-activity / time-saved:status class:');
    console.error('a cloud-run turn\'s update silently never reaches the desktop (PM 260618_autotitle_cloud_livesync_allowlist_merge_gap).');
    console.error('');
  }

  if (r.unreviewedDynamic.length > 0) {
    console.error(
      '✗ check-cloud-push-allowlist-coverage: genuinely-dynamic broadcast(<computed channel>) ' +
        'emit-site(s) WITHOUT a // dynamic-broadcast-reviewed: annotation:',
    );
    for (const d of r.unreviewedDynamic) console.error(`  - ${d.relativePath}:${d.line}  broadcast(${d.argText}…)`);
    console.error('');
    console.error('The channel here is a function parameter (a forwarding wrapper / runtime event.channel), so it');
    console.error('cannot be statically resolved to a literal. A human must confirm it can only re-emit an');
    console.error('already-classified channel (not introduce a new unclassified cloud-reachable one), then annotate');
    console.error('the emit-site on its own line or directly above it:');
    console.error('      // dynamic-broadcast-reviewed: <why this forwarder can\'t introduce an unclassified channel>');
    console.error('Do NOT rubber-stamp: if the wrapper could forward an arbitrary new channel, the channel it forwards');
    console.error('still needs to be declared at ITS source.');
    console.error('');
  }

  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

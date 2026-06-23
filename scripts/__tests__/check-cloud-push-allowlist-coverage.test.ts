/**
 * Unit coverage for the cloud-push allowlist coverage gate
 * (scripts/check-cloud-push-allowlist-coverage.ts; PM 260618_autotitle_cloud_livesync_allowlist_merge_gap rec 2).
 * Exercises the pure parsing/classification helpers on synthetic source so the gate's verdict
 * logic is pinned independently of the live source tree.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  parseAllowlist,
  parseExemptions,
  scanBroadcasts,
  computeCoverage,
  buildConstantChannelMap,
  isEmitReviewed,
  runCoverageScan,
} from '../check-cloud-push-allowlist-coverage';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('parseAllowlist', () => {
  it('extracts channel ids from the CLOUD_PUSH_ALLOWLIST Set literal', () => {
    const src = `
      export const CLOUD_PUSH_ALLOWLIST = new Set([
        'memory:update-status',
        'tool-safety:staged-call', // trailing comment
        'session:title-generated',
      ]);
      const OTHER = new Set(['not:counted']);
    `;
    const out = parseAllowlist(src);
    expect(out.has('memory:update-status')).toBe(true);
    expect(out.has('tool-safety:staged-call')).toBe(true);
    expect(out.has('session:title-generated')).toBe(true);
    // Only the allowlist block is parsed, not other Sets after it.
    expect(out.has('not:counted')).toBe(false);
  });

  it('is immune to apostrophes inside allowlist comments (the 260620 parse bug)', () => {
    // The exact bug: a regex (/'([^']+)'/g) desyncs its quote-pairing on apostrophes in comments
    // (renderer's / can't / doesn't), capturing comment fragments AND dropping the entry that
    // FOLLOWS such a comment. The AST parse must read only the string-literal array elements.
    // GPT-F1 / native-F1: pin EVERY historically-dropped real entry so the exact miss can't regress —
    // external-delivery:failed, conversations:start-requested, AND all three intent:* channels.
    const src = `
      export const CLOUD_PUSH_ALLOWLIST = new Set([
        'tool-safety:staged-call',
        // Desktop clients listening to a cloud session need these so the renderer's
        // drawer drops stale entries — a cloud turn can't push them otherwise.
        'external-delivery:failed',
        // This payload is metadata-only; it doesn't carry the user's content.
        'conversations:start-requested',
        // The cloud webhook can't deliver these without the renderer being told.
        'intent:external-context-arrived',
        'intent:buffered-message',
        // One more after a comment that doesn't pair its apostrophe cleanly.
        'intent:buffer-drained',
      ]);
    `;
    const out = parseAllowlist(src);
    // Every previously-dropped real channel parses...
    expect(out.has('tool-safety:staged-call')).toBe(true);
    expect(out.has('external-delivery:failed')).toBe(true);
    expect(out.has('conversations:start-requested')).toBe(true);
    expect(out.has('intent:external-context-arrived')).toBe(true);
    expect(out.has('intent:buffered-message')).toBe(true);
    expect(out.has('intent:buffer-drained')).toBe(true);
    // ...and exactly six — no comment fragment leaked in as a fake "channel".
    expect(out.size).toBe(6);
    for (const c of out) {
      expect(c).toMatch(/^[a-z0-9-]+(?::[a-z0-9-]+)+$/);
    }
  });

  it('returns empty when the declaration is absent', () => {
    expect(parseExemptions('').size).toBe(0);
    expect(parseAllowlist('const x = 1;').size).toBe(0);
  });
});

describe('buildConstantChannelMap', () => {
  it('resolves const-string, `as const`, and object-literal channel declarations', () => {
    const map = buildConstantChannelMap([
      { relativePath: 'src/shared/a.ts', text: `export const COOLDOWN_STATUS_CHANNEL = 'cooldown:status-changed' as const;` },
      { relativePath: 'src/core/b.ts', text: `const CLOUD_STATUS_CHANGED_CHANNEL = 'cloud:status-changed';` },
      { relativePath: 'src/shared/c.ts', text: `export const MCP_APPS_BROADCAST_CHANNELS = { PERMISSION_CHANGED: 'mcp:permission-changed' } as const;` },
    ]);
    expect(map.get('COOLDOWN_STATUS_CHANNEL')).toBe('cooldown:status-changed');
    expect(map.get('CLOUD_STATUS_CHANGED_CHANNEL')).toBe('cloud:status-changed');
    expect(map.get('MCP_APPS_BROADCAST_CHANNELS.PERMISSION_CHANGED')).toBe('mcp:permission-changed');
  });

  it('drops a constant name that resolves to two different literals (ambiguous → stay dynamic)', () => {
    const map = buildConstantChannelMap([
      { relativePath: 'src/a.ts', text: `const X = 'a:one';` },
      { relativePath: 'src/b.ts', text: `const X = 'a:two';` },
    ]);
    expect(map.has('X')).toBe(false);
  });
});

describe('parseExemptions', () => {
  it('captures the channel id named after not-cloud-pushed:', () => {
    const src = `
      // not-cloud-pushed: time-saved:status — desktop-only service.
      // not-cloud-pushed: library:skill-improvement-complete — TimeSavedService is desktop-only.
      // not-cloud-pushed: shared-drive:health-warning — local FS health checks.
    `;
    const out = parseExemptions(src);
    expect([...out].sort()).toEqual(
      ['library:skill-improvement-complete', 'shared-drive:health-warning', 'time-saved:status'].sort(),
    );
  });

  it('does NOT match a bare not-cloud-pushed: comment that fails to name a channel', () => {
    // The old (pre-260620) time-saved comment shape — no channel id, so the gate would
    // have refused to treat it as a valid exemption. Naming the channel is mandatory.
    const out = parseExemptions('// not-cloud-pushed: deliberately NOT in CLOUD_PUSH_ALLOWLIST.');
    expect(out.size).toBe(0);
  });
});

describe('scanBroadcasts', () => {
  it('extracts literal channels and ignores non-broadcast calls', () => {
    const src = `
      broadcastToAllWindows('plugins:navigate', { id });
      somethingElse('not:a:broadcast', x);
      broadcastToAllWindows('library:changed', payload);
    `;
    const { literals, dynamic } = scanBroadcasts(src, 'src/main/x.ts');
    expect(literals.map((l) => l.channel).sort()).toEqual(['library:changed', 'plugins:navigate']);
    expect(dynamic).toHaveLength(0);
  });

  it('also covers the getBroadcastService().sendToAllWindows(...) surface (where cloud-reachable channels emit)', () => {
    const src = `
      getBroadcastService().sendToAllWindows('memory:checkpoint-integrity-violation', payload);
      svc.sendToAllWindows('cloud:sessions-synced', state);
    `;
    const { literals, dynamic } = scanBroadcasts(src, 'src/core/x.ts');
    expect(literals.map((l) => l.channel).sort()).toEqual(['cloud:sessions-synced', 'memory:checkpoint-integrity-violation']);
    expect(dynamic).toHaveLength(0);
  });

  it('flags a dynamic (non-literal) first argument as an UNREVIEWED coverage gap', () => {
    const src = `function f(ch: string) { broadcastToAllWindows(ch, payload); }`;
    const { literals, dynamic } = scanBroadcasts(src, 'src/main/x.ts');
    expect(literals).toHaveLength(0);
    expect(dynamic).toHaveLength(1);
    expect(dynamic[0].argText).toContain('ch');
    // No annotation → unreviewed → must fail the gate.
    expect(dynamic[0].reviewed).toBe(false);
  });

  it('marks a dynamic emit-site REVIEWED when a // dynamic-broadcast-reviewed: annotation sits directly above it', () => {
    const src = [
      'function f(channel: string) {',
      '  // dynamic-broadcast-reviewed: forwards the caller-supplied channel; declared at its own site.',
      '  broadcastToAllWindows(channel, payload);',
      '}',
    ].join('\n');
    const { dynamic } = scanBroadcasts(src, 'src/main/x.ts');
    expect(dynamic).toHaveLength(1);
    expect(dynamic[0].reviewed).toBe(true);
  });

  it('marks a dynamic emit-site REVIEWED via a MULTI-LINE annotation block one nesting level above (the real cloud-service shape)', () => {
    // setBroadcastService({ … }) — a multi-line annotation above the object, then the call nested
    // one structural-opener level in. The block-aware upward scan must still cover it.
    const src = [
      '// dynamic-broadcast-reviewed: cloud-side BroadcastService adapter — forwards whatever channel',
      '// core/cloud code emits; each is declared at its own emit-site, and the desktop allowlist',
      '// fail-closes the receive end, so this seam adds no channel of its own.',
      'setBroadcastService({',
      '  sendToAllWindows: (channel, ...args) => cloudEventBroadcaster.broadcast(channel, ...args),',
      '});',
    ].join('\n');
    const { dynamic } = scanBroadcasts(src, 'cloud-service/src/bootstrap.ts');
    expect(dynamic).toHaveLength(1);
    expect(dynamic[0].reviewed).toBe(true);
  });

  it('does NOT leak annotation coverage across an unrelated intervening statement', () => {
    // An annotation above one statement must not cover a DIFFERENT dynamic emit-site below an
    // intervening real statement (the upward scan stops at the first non-comment/non-opener line).
    const src = [
      'function f(channel: string) {',
      '  // dynamic-broadcast-reviewed: covers ONLY the immediately-following call.',
      '  broadcastToAllWindows(channel, a);',
      '  doSomethingUnrelated();',
      '  broadcastToAllWindows(channel, b);',
      '}',
    ].join('\n');
    const { dynamic } = scanBroadcasts(src, 'src/main/x.ts');
    expect(dynamic).toHaveLength(2);
    expect(dynamic[0].reviewed).toBe(true);
    // The second call sits below a real intervening statement → NOT covered → fails.
    expect(dynamic[1].reviewed).toBe(false);
  });

  it('is shadowing-aware: a constant name shadowed by a NESTED local/param stays dynamic (GPT-F2)', () => {
    const constantMap = new Map<string, string>([['CH', 'real:channel']]);
    // `CH` is a repo-wide channel constant, but here it is a LOCAL parameter shadowing it — so the
    // emit forwards a runtime value, not the constant. Resolving it would be a false negative.
    const shadowed = `function f(CH: string) { broadcastToAllWindows(CH, p); }`;
    const r1 = scanBroadcasts(shadowed, 'src/main/x.ts', constantMap);
    expect(r1.literals).toHaveLength(0);
    expect(r1.dynamic).toHaveLength(1);
    expect(r1.dynamic[0].argText).toContain('CH');

    // ...but a MODULE-LEVEL `const CH = '…'` reference (the constant itself, not a shadow) DOES
    // resolve — the in-file constant is the map source, referencing it is correct resolution.
    const moduleConst = [
      `const CH = 'real:channel';`,
      `function f() { broadcastToAllWindows(CH, p); }`,
    ].join('\n');
    const r2 = scanBroadcasts(moduleConst, 'src/main/x.ts', constantMap);
    expect(r2.literals.map((l) => l.channel)).toEqual(['real:channel']);
    expect(r2.dynamic).toHaveLength(0);
  });

  it('resolves a named-constant first arg to its literal via the constant map', () => {
    const constantMap = new Map<string, string>([
      ['COOLDOWN_STATUS_CHANNEL', 'cooldown:status-changed'],
      ['MCP_APPS_BROADCAST_CHANNELS.PERMISSION_CHANGED', 'mcp:permission-changed'],
    ]);
    const src = `
      getBroadcastService().sendToAllWindows(COOLDOWN_STATUS_CHANNEL, payload);
      getBroadcastService().sendToAllWindows(MCP_APPS_BROADCAST_CHANNELS.PERMISSION_CHANGED, payload);
      getBroadcastService().sendToAllWindows(UNRESOLVED_CHANNEL, payload);
    `;
    const { literals, dynamic } = scanBroadcasts(src, 'src/main/x.ts', constantMap);
    expect(literals.map((l) => l.channel).sort()).toEqual(['cooldown:status-changed', 'mcp:permission-changed']);
    // The resolved-from origin is recorded for honest reporting.
    const cooldown = literals.find((l) => l.channel === 'cooldown:status-changed');
    expect(cooldown?.resolvedFrom).toBe('COOLDOWN_STATUS_CHANNEL');
    // An identifier with no map entry stays dynamic (genuinely-computed / unknown).
    expect(dynamic).toHaveLength(1);
    expect(dynamic[0].argText).toContain('UNRESOLVED_CHANNEL');
  });

  it('scans broadcastTypedPayload(sink, <literal>, payload) at channel arg index 1 (Amendment A2)', () => {
    // broadcastTypedPayload is the PREFERRED schema-backed emit API; its CALL SITES carry the
    // literal channel (arg 1; arg 0 is the BroadcastSink), while its internal sendToAllWindows
    // call forwards a dynamic param. Leaving the call sites unscanned was the false-green that hid
    // live cloud-reachable gaps (memory:write-approval-resolved, tool-safety:staged-call-updated).
    const src = `
      broadcastTypedPayload(getBroadcastService(), 'memory:write-approval-resolved', payload);
      broadcastTypedPayload(broadcast, 'tool-safety:staged-call-updated', { id, sessionId, status });
    `;
    const { literals, dynamic } = scanBroadcasts(src, 'src/main/services/safety/memoryWriteHook.ts');
    expect(literals.map((l) => l.channel).sort()).toEqual([
      'memory:write-approval-resolved',
      'tool-safety:staged-call-updated',
    ]);
    expect(dynamic).toHaveLength(0);
  });

  it('flags an UNCLASSIFIED broadcastTypedPayload channel — the gate has teeth on the typed-helper surface', () => {
    // The headline Amendment A2 guarantee: a synthetic, undeclared channel emitted via the typed
    // helper must surface as unclassified (→ exit 1), not slip past as it did before the helper was
    // scanned. Resolves the false-green both final reviewers (GPT F1 + DA F1) converged on.
    const src = `broadcastTypedPayload(getBroadcastService(), 'synthetic:unclassified-channel', {});`;
    const { literals } = scanBroadcasts(src, 'src/main/x.ts');
    const r = computeCoverage({
      allowlist: new Set(['memory:write-approval-resolved']),
      exemptions: new Set(),
      literals,
      dynamic: [],
    });
    expect(r.unclassified.map((u) => u.channel)).toEqual(['synthetic:unclassified-channel']);
  });

  it('detects a cloud-service cloudEventBroadcaster.broadcast(<literal>) emit-site', () => {
    const src = `cloudEventBroadcaster.broadcast('cloud:session-tombstoned', tombstone);`;
    const { literals, dynamic } = scanBroadcasts(src, 'cloud-service/src/routes/sessions.ts');
    expect(literals.map((l) => l.channel)).toEqual(['cloud:session-tombstoned']);
    expect(dynamic).toHaveLength(0);
  });

  it('does NOT match unrelated `.broadcast` methods (only cloudEventBroadcaster.broadcast)', () => {
    // libraryBroadcaster.broadcast / automationScheduler.this.broadcast / meeting deps.broadcast
    // are different objects — they are NOT the cloud→desktop event channel and must be ignored.
    const src = `
      libraryBroadcaster.broadcast({ affectsTree: true });
      this.broadcast('projection');
      deps.broadcast('meeting:trigger-dropped', payload);
    `;
    const { literals, dynamic } = scanBroadcasts(src, 'src/main/x.ts');
    expect(literals).toHaveLength(0);
    expect(dynamic).toHaveLength(0);
  });

  it('counts an intercepted channel as DECLARED when it carries a not-cloud-pushed exemption', () => {
    // The interception set (cloud:session-changed, inbox:changed, automation:cloud-delta) is
    // modeled via exemptions (step 4) — emitted from cloud-service but handled in main, so an
    // exemption marks them declared rather than a gap.
    const emitSrc = `cloudEventBroadcaster.broadcast('inbox:changed', {});`;
    const exemptionSrc = `// not-cloud-pushed: inbox:changed — intercepted in dispatchToRenderer.`;
    const { literals } = scanBroadcasts(emitSrc, 'cloud-service/src/bootstrap.ts');
    const exemptions = parseExemptions(exemptionSrc);
    const r = computeCoverage({ allowlist: new Set(), exemptions, literals, dynamic: [] });
    expect(r.unclassified).toHaveLength(0);
    expect(r.exemptCount).toBe(1);
  });

  it('short-circuits (no AST parse) when the helper is not called', () => {
    const { literals, dynamic } = scanBroadcasts('export const x = 1;', 'src/main/x.ts');
    expect(literals).toHaveLength(0);
    expect(dynamic).toHaveLength(0);
  });
});

describe('isEmitReviewed (dynamic-broadcast-reviewed line scoping)', () => {
  const lines = (s: string) => s.split('\n');

  it('covers an emit on its own line', () => {
    const src = `broadcast(channel); // dynamic-broadcast-reviewed: same-line attestation`;
    expect(isEmitReviewed(1, lines(src))).toBe(true);
  });

  it('covers an emit directly below a single-line annotation', () => {
    const src = ['// dynamic-broadcast-reviewed: forwarder', 'broadcast(channel);'].join('\n');
    expect(isEmitReviewed(2, lines(src))).toBe(true);
  });

  it('covers an emit below a multi-line annotation and a structural opener', () => {
    const src = [
      '// dynamic-broadcast-reviewed: line 1',
      '// continuation line 2',
      'return {',
      '  emit: (channel) => broadcast(channel),',
      '};',
    ].join('\n');
    expect(isEmitReviewed(4, lines(src))).toBe(true);
  });

  it('does NOT cover an emit when a real statement intervenes', () => {
    const src = [
      '// dynamic-broadcast-reviewed: covers the next call only',
      'broadcast(a);',
      'const x = compute();',
      'broadcast(b);',
    ].join('\n');
    expect(isEmitReviewed(2, lines(src))).toBe(true);
    expect(isEmitReviewed(4, lines(src))).toBe(false);
  });

  it('returns false with no annotation at all', () => {
    expect(isEmitReviewed(1, lines('broadcast(channel);'))).toBe(false);
  });
});

describe('computeCoverage', () => {
  const lit = (channel: string) => ({ relativePath: 'src/main/x.ts', line: 1, channel });

  it('reports a channel that is neither allowlisted nor exempt as unclassified', () => {
    const r = computeCoverage({
      allowlist: new Set(['memory:update-status']),
      exemptions: new Set(['plugins:navigate']),
      literals: [lit('memory:update-status'), lit('plugins:navigate'), lit('coaching:reflection')],
      dynamic: [],
    });
    expect(r.unclassified.map((u) => u.channel)).toEqual(['coaching:reflection']);
    expect(r.allowlistedCount).toBe(1);
    expect(r.exemptCount).toBe(1);
  });

  it('passes when every emitted channel is allowlisted or exempt', () => {
    const r = computeCoverage({
      allowlist: new Set(['memory:update-status']),
      exemptions: new Set(['plugins:navigate']),
      literals: [lit('memory:update-status'), lit('plugins:navigate')],
      dynamic: [],
    });
    expect(r.unclassified).toHaveLength(0);
  });

  it('flags an exemption with no live emit-site as stale (prune signal)', () => {
    const r = computeCoverage({
      allowlist: new Set(),
      exemptions: new Set(['plugins:navigate', 'gone:channel']),
      literals: [lit('plugins:navigate')],
      dynamic: [],
    });
    expect(r.staleExemptions).toEqual(['gone:channel']);
  });

  it('partitions dynamic emit-sites into reviewed (declared) and unreviewed (gate-failing)', () => {
    const dyn = (line: number, reviewed: boolean) => ({
      relativePath: 'src/main/x.ts',
      line,
      argText: 'channel',
      reviewed,
    });
    const r = computeCoverage({
      allowlist: new Set(),
      exemptions: new Set(),
      literals: [],
      dynamic: [dyn(1, true), dyn(2, false), dyn(3, true)],
    });
    expect(r.reviewedDynamicCount).toBe(2);
    expect(r.unreviewedDynamic.map((d) => d.line)).toEqual([2]);
  });
});

describe('live source tree (regression: the Amendment A2 typed-helper gaps stay closed)', () => {
  const allowlistText = readFileSync(
    path.join(REPO_ROOT, 'src/main/services/cloud/cloudEventChannel.ts'),
    'utf8',
  );
  const allowlist = parseAllowlist(allowlistText);

  it('allowlists memory:write-approval-resolved (cloud-wired memoryWriteHook, transient resolution notification)', () => {
    expect(allowlist.has('memory:write-approval-resolved')).toBe(true);
  });

  it('allowlists tool-safety:staged-call-updated (cloud-routable staged-execute/-reject IPC fires it)', () => {
    expect(allowlist.has('tool-safety:staged-call-updated')).toBe(true);
  });

  it('the full coverage scan over the live tree passes (every emit-site declared, incl. typed-helper call sites)', () => {
    const r = runCoverageScan(REPO_ROOT);
    expect(r.unclassified).toEqual([]);
    expect(r.unreviewedDynamic).toEqual([]);
    // The two A2-surfaced channels are now genuine literal emit-sites (via broadcastTypedPayload),
    // so they must be counted among the allowlisted emitted channels, not dropped.
    expect(r.emittedChannels.has('memory:write-approval-resolved')).toBe(true);
    expect(r.emittedChannels.has('tool-safety:staged-call-updated')).toBe(true);
  });
});

/**
 * Stage 5 — broadcast contract coverage guard + no-raw-send literal check.
 *
 * ## Coverage guard (anti-rot)
 * Iterates EVERY `BROADCAST_SCHEMAS` key and proves the harness machinery
 * (`sampleSchema` → `transport` (faithful structuredClone) → `schema.parse`)
 * round-trips a contract-valid payload cleanly for each. Because it enumerates
 * the live map: a schema ADDED to `BROADCAST_SCHEMAS` is auto-covered (no test
 * edit), and one REMOVED fails loudly. This mirrors the invoke harness's
 * `coverageGuard.ts` but without its `ipcContract`-domain partitioning (broadcasts
 * are a flat single map).
 *
 * Deliberate exemption: `memory:staged-files-changed` is PAYLOADLESS and is
 * intentionally NOT in `BROADCAST_SCHEMAS` (src/shared/ipc/broadcasts.ts:33) — it
 * carries no payload to validate, so it is correctly absent from the one-payload
 * typed map and from this round-trip guard.
 *
 * ## No-raw-schema-backed-send literal check
 * Asserts that no raw `webContents.send('<channel>', …)` exists in `src/**` for
 * any of the schema-backed channel literals — locking in the research claim (A1)
 * that ALL schema-backed emits route through the typed sink
 * (`getBroadcastService().sendToAllWindows`), which is where the sink-seam parses.
 * Cheap source read, NOT a full AST pass (the AST anti-bypass ratchet is the
 * recommended-OUT follow-up).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { BROADCAST_SCHEMAS } from '@shared/ipc/broadcasts';
import { sampleSchema } from '@main/ipc/__tests__/harness/sampleRequest';
import { transport } from '@main/ipc/__tests__/harness/transport';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');

describe('broadcast coverage guard — every BROADCAST_SCHEMAS channel round-trips', () => {
  const channels = Object.keys(BROADCAST_SCHEMAS) as (keyof typeof BROADCAST_SCHEMAS)[];

  it('has the expected set of schema-backed channels (a removal fails loudly)', () => {
    // The payloadless `memory:staged-files-changed` is deliberately NOT here
    // (broadcasts.ts:33). Adding a schema auto-covers it via the it.each below;
    // this snapshot makes a silent REMOVAL fail loudly.
    expect([...channels].sort()).toEqual(
      [
        'agent:route-plan-resolved',
        'cloud:drive-aware-sync-deferred',
        'conversations:start-requested',
        'memory:file-staged',
        'memory:write-approval-request',
        'memory:write-approval-resolved',
        'tool-safety:approval-request',
        'tool-safety:approval-resolved',
        'tool-safety:staged-call',
        'tool-safety:staged-call-updated',
      ].sort(),
    );
  });

  it.each(channels)(
    '%s: sampleSchema → transport (structuredClone) → schema.parse round-trips clean',
    (channel) => {
      const schema = BROADCAST_SCHEMAS[channel] as z.ZodTypeAny;
      const sample = sampleSchema(schema);
      const transported = transport(sample);
      // The faithful (structuredClone) round-trip must still satisfy the contract.
      expect(() => schema.parse(transported)).not.toThrow();
    },
  );
});

describe('no raw webContents.send for schema-backed channels (sink-routing invariant)', () => {
  // Read the same source files the live grep would; assert zero raw-send matches.
  const SOURCE_GLOBS = [
    'src/main',
    'src/core',
    'src/shared',
    'src/preload',
    'src/renderer',
  ];

  function collectTsFiles(dir: string): string[] {
    const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs');
    const out: string[] = [];
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return out;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        // Skip test dirs — fixtures legitimately reference channel literals.
        if (entry === '__tests__' || entry === 'node_modules') continue;
        out.push(...collectTsFiles(full));
      } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
        out.push(full);
      }
    }
    return out;
  }

  // Non-vacuity guard (GPT final-review F3): assert the scan actually visits a
  // substantial source tree. Without this, a path-resolution regression (wrong
  // REPO_ROOT, renamed dirs) would make collectTsFiles return [] and EVERY
  // raw-send assertion below trivially pass — a silent false-green.
  it('scans a non-trivial number of source files (scan is non-vacuous)', () => {
    const scanned = SOURCE_GLOBS.flatMap((glob) => collectTsFiles(join(REPO_ROOT, glob)));
    expect(scanned.length).toBeGreaterThan(500);
  });

  it.each(Object.keys(BROADCAST_SCHEMAS))(
    'no raw webContents.send(%j, …) anywhere in src — all emits route through the typed sink',
    (channel) => {
      // A raw send would bypass getBroadcastService().sendToAllWindows (where the
      // sink-seam parses), re-opening the 260405-class bypass. Match the literal
      // `webContents.send('<channel>'` (single or double quote) anywhere in src.
      const escaped = channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`webContents\\.send\\(\\s*['"]${escaped}['"]`);

      const offenders: string[] = [];
      for (const glob of SOURCE_GLOBS) {
        for (const file of collectTsFiles(join(REPO_ROOT, glob))) {
          const text = readFileSync(file, 'utf8');
          if (pattern.test(text)) {
            offenders.push(file.slice(REPO_ROOT.length + 1));
          }
        }
      }
      expect(offenders).toEqual([]);
    },
  );
});

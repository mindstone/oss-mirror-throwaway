/**
 * Behavioural tests for the desktop diagnostic-events ledger writer + reader.
 *
 * Covers:
 *   - end-to-end emit -> persist -> read roundtrip
 *   - rotation: when we exceed MAX_DIAGNOSTIC_EVENTS the live file is renamed
 *     to `.old` and a fresh file starts; reader returns combined recent slice
 *   - drop-on-no-platform-config: when platform path resolution throws,
 *     emits are dropped silently and the caller sees no exception
 *
 * Notes:
 *   - We work with a tmp dir via `setDiagnosticEventsLedgerPathOverride()`.
 *   - We bypass the bootstrap wiring and call the writer/reader implementations
 *     directly so the test isn't sensitive to startup ordering.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendDiagnosticEvent,
  resetDiagnosticEventsLedgerForTests,
  setDiagnosticEventsLedgerWriter,
  setDiagnosticEventsSurface,
} from '@core/services/diagnosticEventsLedger';
import { MAX_DIAGNOSTIC_EVENTS } from '@core/services/diagnostics/manifest';

import {
  desktopDiagnosticEventsLedgerReader,
  desktopDiagnosticEventsLedgerWriter,
  flushDiagnosticEventsLedger,
  resetDiagnosticEventsLedgerWriterForTests,
  setDiagnosticEventsLedgerPathOverride,
} from '../diagnosticEventsLedgerWriter';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-diag-events-'));
  setDiagnosticEventsLedgerPathOverride(tmpDir);
  setDiagnosticEventsLedgerWriter(desktopDiagnosticEventsLedgerWriter);
  setDiagnosticEventsSurface('desktop');
  resetDiagnosticEventsLedgerWriterForTests();
});

afterEach(async () => {
  resetDiagnosticEventsLedgerWriterForTests();
  resetDiagnosticEventsLedgerForTests();
  setDiagnosticEventsLedgerPathOverride(null);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('diagnosticEventsLedgerWriter — happy path roundtrip', () => {
  it('persists emitted events and reads them back oldest-first', async () => {
    appendDiagnosticEvent({
      kind: 'cooldown_enter',
      data: { scope: 'api', untilMs: 1, retryAfterProvided: false, durationMs: 30_000 },
    });
    appendDiagnosticEvent({
      kind: 'tool_advisory',
      data: { advisory: 'soft_budget', totalToolCalls: 12 },
    });
    appendDiagnosticEvent({
      kind: 'known_condition',
      data: { condition: 'model_error', level: 'warning' },
    });

    await flushDiagnosticEventsLedger();

    const entries = await desktopDiagnosticEventsLedgerReader.readRecent({
      limit: 100,
      maxBytes: 1_000_000,
    });
    expect(entries.map((e) => e.kind)).toEqual(['cooldown_enter', 'tool_advisory', 'known_condition']);
    expect(entries[0].surface).toBe('desktop');
  });

  it('drops malformed input silently (validation guard)', async () => {
    appendDiagnosticEvent({
      kind: 'cooldown_enter',
      data: {
        // Casting through `unknown` to a typed enum on purpose: we want to
        // simulate a programmer mistake that bypasses the type system but is
        // still caught by the runtime Zod validator.
        scope: 'unknown-scope' as unknown as 'api',
        untilMs: 1,
        retryAfterProvided: false,
        durationMs: 30_000,
      },
    });
    await flushDiagnosticEventsLedger();
    const entries = await desktopDiagnosticEventsLedgerReader.readRecent({ limit: 100, maxBytes: 1_000_000 });
    expect(entries).toEqual([]);
  });
});

describe('diagnosticEventsLedgerWriter — rotation', () => {
  it('rotates the live file once line count crosses MAX_DIAGNOSTIC_EVENTS', async () => {
    // Pre-seed the live file with MAX_DIAGNOSTIC_EVENTS lines so the next
    // append triggers rotation. We bypass the writer's queue for the seed
    // step by writing directly to disk.
    const livePath = path.join(tmpDir, 'diagnostic-events.jsonl');
    const oldPath = path.join(tmpDir, 'diagnostic-events.jsonl.old');

    const seedLine = JSON.stringify({
      v: 1,
      ts: 1,
      surface: 'desktop',
      kind: 'cooldown_exit',
      data: { scope: 'api', reason: 'expired' },
    }) + '\n';
    await fs.writeFile(livePath, seedLine.repeat(MAX_DIAGNOSTIC_EVENTS), 'utf8');

    appendDiagnosticEvent({
      kind: 'tool_advisory',
      data: { advisory: 'hard_budget', totalToolCalls: 30 },
    });
    await flushDiagnosticEventsLedger();

    const oldStat = await fs.stat(oldPath);
    expect(oldStat.size).toBeGreaterThan(0);

    const entries = await desktopDiagnosticEventsLedgerReader.readRecent({ limit: 5, maxBytes: 1_000_000 });
    // Last entry is the post-rotation tool_advisory.
    expect(entries[entries.length - 1].kind).toBe('tool_advisory');
  });
});

describe('diagnosticEventsLedgerWriter — robust to missing path config', () => {
  it('drops emits silently when getDataPath() throws (pre-bootstrap)', async () => {
    // Overriding to an invalid sentinel value triggers the fs error path; the
    // writer must swallow it without throwing.
    setDiagnosticEventsLedgerPathOverride('/this/path/does/not/exist/ever');
    expect(() => {
      appendDiagnosticEvent({
        kind: 'known_condition',
        data: { condition: 'model_error', level: 'warning' },
      });
    }).not.toThrow();
    await expect(flushDiagnosticEventsLedger()).resolves.not.toThrow();
  });
});

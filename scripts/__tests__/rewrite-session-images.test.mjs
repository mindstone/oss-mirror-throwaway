/**
 * Integration tests for `scripts/rewrite-session-images.mjs`.
 *
 * Runs the actual script as a subprocess against a temp `userData` directory
 * containing a synthetic legacy session with inline base64 images. Verifies:
 *
 *   - Dry-run prints planned actions but does not write
 *   - Real run creates a backup, writes assets atomically, shrinks the JSON
 *   - Idempotent re-run does not migrate anything new
 *   - Partial-migration handling (some refs present, others missing) only
 *     writes the missing slots
 *   - Corrupt / disallowed-mime images stay as `null` positional slots so
 *     the renderer still has fallback bytes
 *   - The printed backup path actually exists
 */

import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'rewrite-session-images.mjs');

// Minimal 1x1 transparent PNG with valid magic bytes.
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]),
  Buffer.from([0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00]),
  Buffer.from([0x1f, 0x15, 0xc4, 0x89]),
  Buffer.from([0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01]),
  Buffer.from([0x0d, 0x0a, 0x2d, 0xb4]),
  Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
]);

const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from('JFIF\0'),
  Buffer.alloc(64, 0),
]);

const PNG_B64 = PNG.toString('base64');
const JPEG_B64 = JPEG.toString('base64');

function buildSession(sessionId) {
  return {
    id: sessionId,
    title: 'fixture',
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    messages: [],
    eventsByTurn: {
      'turn-aaaa': [
        { type: 'status', message: 'started', timestamp: 1 },
        {
          type: 'tool',
          toolName: 'test',
          toolUseId: 'tu-1',
          detail: 'first tool with 2 images',
          stage: 'end',
          seq: 10,
          timestamp: 1,
          imageContent: [
            { type: 'image', data: PNG_B64, mimeType: 'image/png' },
            { type: 'image', data: JPEG_B64, mimeType: 'image/jpeg' },
          ],
        },
        {
          type: 'tool',
          toolName: 'test',
          toolUseId: 'tu-2',
          detail: 'tool with corrupt + good png',
          stage: 'end',
          seq: 11,
          timestamp: 1,
          imageContent: [
            // Corrupt: wrong magic bytes for declared mime.
            { type: 'image', data: Buffer.from('not a real png').toString('base64'), mimeType: 'image/png' },
            { type: 'image', data: PNG_B64, mimeType: 'image/png' },
          ],
        },
      ],
      'turn-bbbb': [
        {
          type: 'tool',
          toolName: 'test',
          toolUseId: 'tu-3',
          detail: 'tool with parallel toolResult.content',
          stage: 'end',
          seq: 12,
          timestamp: 1,
          imageContent: [
            { type: 'image', data: PNG_B64, mimeType: 'image/png' },
          ],
          toolResult: {
            content: [
              { type: 'text', text: 'preface' },
              { type: 'image', data: PNG_B64, mimeType: 'image/png', source: 'inline' },
            ],
          },
        },
      ],
    },
    activeTurnId: null,
  };
}

async function writeSession(userDataDir, sessionId, session) {
  const sessionsDir = path.join(userDataDir, 'sessions');
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionsDir, `${sessionId}.json`),
    JSON.stringify(session, null, 2),
  );
}

async function readSession(userDataDir, sessionId) {
  const raw = await fs.readFile(
    path.join(userDataDir, 'sessions', `${sessionId}.json`),
    'utf8',
  );
  return JSON.parse(raw);
}

function runScript(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT_PATH, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(options.env ?? {}) },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (exitCode) => {
      resolve({ stdout, stderr, exitCode: exitCode ?? -1 });
    });
  });
}

describe('rewrite-session-images.mjs', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rewrite-session-images-'));
  });

  afterEach(async () => {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('prints help when --help is provided', async () => {
    const result = await runScript(['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Usage:/);
    expect(result.stdout).toMatch(/--session/);
    expect(result.stdout).toMatch(/--dry-run/);
  });

  it('exits non-zero when --session is missing', async () => {
    const result = await runScript(['--user-data', tempDir]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/Missing required --session/);
  });

  it('dry-run reports planned migration without writing any files', async () => {
    const sessionId = 'sess-dryrun-test';
    const session = buildSession(sessionId);
    await writeSession(tempDir, sessionId, session);

    const beforeStat = await fs.stat(path.join(tempDir, 'sessions', `${sessionId}.json`));
    const beforeBytes = beforeStat.size;

    const result = await runScript([
      '--user-data', tempDir,
      '--session', sessionId,
      '--dry-run',
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/\[dry-run\]/);
    expect(result.stdout).toMatch(/Images migrated: 4/);
    expect(result.stdout).toMatch(/failed: 1/);

    // No files written: no assets dir, no backup, JSON unchanged.
    const assetsDir = path.join(tempDir, 'sessions', `${sessionId}.assets`);
    expect(existsSync(assetsDir)).toBe(false);

    const sessionsEntries = await fs.readdir(path.join(tempDir, 'sessions'));
    expect(sessionsEntries.filter((e) => e.startsWith(`${sessionId}.json.backup-`))).toEqual([]);

    const afterStat = await fs.stat(path.join(tempDir, 'sessions', `${sessionId}.json`));
    expect(afterStat.size).toBe(beforeBytes);
  });

  it('real run creates a backup, writes assets, shrinks the JSON, and preserves null slots', async () => {
    const sessionId = 'sess-realrun-test';
    const session = buildSession(sessionId);
    await writeSession(tempDir, sessionId, session);

    const beforeBytes = (await fs.stat(path.join(tempDir, 'sessions', `${sessionId}.json`))).size;

    const result = await runScript([
      '--user-data', tempDir,
      '--session', sessionId,
    ]);
    expect(result.exitCode).toBe(0);

    // Backup must exist at the printed path.
    const backupMatch = result.stdout.match(/Backup: (\S+\.backup-\d+)/);
    expect(backupMatch).not.toBeNull();
    expect(existsSync(backupMatch[1])).toBe(true);
    const backupRaw = await fs.readFile(backupMatch[1], 'utf8');
    expect(backupRaw).toMatch(/"data":/); // original inline base64 preserved in backup

    // Asset folder exists with the expected files.
    const assetsDir = path.join(tempDir, 'sessions', `${sessionId}.assets`);
    const assetEntries = (await fs.readdir(assetsDir)).sort();
    expect(assetEntries).toEqual([
      '_manifest.json',
      'legacy-turn-aaaa-10-0.png',
      'legacy-turn-aaaa-10-1.jpg',
      'legacy-turn-aaaa-11-1.png',
      'legacy-turn-bbbb-12-0.png',
    ]);

    const manifest = JSON.parse(
      await fs.readFile(path.join(assetsDir, '_manifest.json'), 'utf8'),
    );
    for (const assetId of [
      'legacy-turn-aaaa-10-0',
      'legacy-turn-aaaa-10-1',
      'legacy-turn-aaaa-11-1',
      'legacy-turn-bbbb-12-0',
    ]) {
      expect(manifest[assetId]).toEqual({ uploadStatus: 'pending' });
    }

    // Session JSON shrank.
    const afterBytes = (await fs.stat(path.join(tempDir, 'sessions', `${sessionId}.json`))).size;
    expect(afterBytes).toBeLessThan(beforeBytes);

    // Refs are positional. Corrupt slot must be null, paired imageContent kept.
    const after = await readSession(tempDir, sessionId);
    const ok2 = after.eventsByTurn['turn-aaaa'][1];
    expect(ok2.imageRef).toHaveLength(2);
    expect(ok2.imageRef[0].assetId).toBe('legacy-turn-aaaa-10-0');
    expect(ok2.imageRef[1].assetId).toBe('legacy-turn-aaaa-10-1');
    expect(ok2.imageContent).toBeUndefined();

    const partial = after.eventsByTurn['turn-aaaa'][2];
    expect(partial.imageRef).toHaveLength(2);
    expect(partial.imageRef[0]).toBeNull();
    expect(partial.imageRef[1].assetId).toBe('legacy-turn-aaaa-11-1');
    // Still has the corrupt image as fallback bytes.
    expect(Array.isArray(partial.imageContent)).toBe(true);
    expect(partial.imageContent).toHaveLength(1);
    expect(partial.imageContent[0].mimeType).toBe('image/png');

    // toolResult.content image block has its inline source/data stripped and gains imageRef.
    const tr = after.eventsByTurn['turn-bbbb'][0].toolResult.content;
    const trImage = tr.find((b) => b.type === 'image');
    expect(trImage.data).toBeUndefined();
    expect(trImage.source).toBeUndefined();
    expect(trImage.imageRef.assetId).toBe('legacy-turn-bbbb-12-0');
  });

  it('re-running on an already-migrated session is a no-op', async () => {
    const sessionId = 'sess-idempotency-test';
    await writeSession(tempDir, sessionId, buildSession(sessionId));

    const first = await runScript(['--user-data', tempDir, '--session', sessionId]);
    expect(first.exitCode).toBe(0);
    const sizeAfterFirst = (await fs.stat(path.join(tempDir, 'sessions', `${sessionId}.json`))).size;
    const sessionAfterFirst = await readSession(tempDir, sessionId);

    const second = await runScript(['--user-data', tempDir, '--session', sessionId]);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toMatch(/Images migrated: 0/);
    expect(second.stdout).toMatch(/Events touched: 0\//);

    const sizeAfterSecond = (await fs.stat(path.join(tempDir, 'sessions', `${sessionId}.json`))).size;
    expect(sizeAfterSecond).toBe(sizeAfterFirst);
    const sessionAfterSecond = await readSession(tempDir, sessionId);
    expect(sessionAfterSecond).toEqual(sessionAfterFirst);
  });

  it('partial-migration handling: only writes the missing positional slots', async () => {
    const sessionId = 'sess-partial-test';
    const session = buildSession(sessionId);
    // Pretend the first image of the 2-image event has already been migrated.
    const existingAssetId = 'pre-migrated-turn-aaaa-10-0';
    session.eventsByTurn['turn-aaaa'][1].imageRef = [
      { assetId: existingAssetId, mimeType: 'image/png', byteSize: PNG.byteLength, uploadStatus: 'uploaded' },
      null,
    ];
    // Strip the now-already-migrated inline payload so it matches a real migrated state.
    session.eventsByTurn['turn-aaaa'][1].imageContent = [
      // First slot was migrated previously and stripped → keep as a placeholder block (rare but valid)
      { type: 'image', data: '', mimeType: 'image/png' },
      // Second slot still has inline bytes.
      { type: 'image', data: PNG_B64, mimeType: 'image/png' },
    ];
    await writeSession(tempDir, sessionId, session);

    const result = await runScript(['--user-data', tempDir, '--session', sessionId]);
    expect(result.exitCode).toBe(0);

    const after = await readSession(tempDir, sessionId);
    const event = after.eventsByTurn['turn-aaaa'][1];
    expect(event.imageRef).toHaveLength(2);
    expect(event.imageRef[0].assetId).toBe(existingAssetId); // pre-existing ref preserved
    expect(event.imageRef[1].assetId).toBe('legacy-turn-aaaa-10-1'); // newly migrated slot

    // The pre-migrated asset is NOT written by this script (we never had its bytes).
    const assetsDir = path.join(tempDir, 'sessions', `${sessionId}.assets`);
    expect(existsSync(path.join(assetsDir, `${existingAssetId}.png`))).toBe(false);
    // The newly-migrated slot IS written.
    expect(existsSync(path.join(assetsDir, 'legacy-turn-aaaa-10-1.png'))).toBe(true);
  });

  it('does not abort the whole migration on one bad event', async () => {
    const sessionId = 'sess-error-recovery-test';
    const session = buildSession(sessionId);
    // Sandwich a corrupt event between two good ones (which is what buildSession already does).
    // After migration the good events must still be migrated.
    await writeSession(tempDir, sessionId, session);

    const result = await runScript(['--user-data', tempDir, '--session', sessionId]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Images migrated: 4/);
    expect(result.stdout).toMatch(/failed: 1/);

    const assetsDir = path.join(tempDir, 'sessions', `${sessionId}.assets`);
    // 4 good assets + manifest = 5 entries.
    const entries = await fs.readdir(assetsDir);
    expect(entries.length).toBeGreaterThanOrEqual(5);
  });

  it('prints a backup path that exists on disk', async () => {
    const sessionId = 'sess-backup-existence-test';
    await writeSession(tempDir, sessionId, buildSession(sessionId));

    const result = await runScript(['--user-data', tempDir, '--session', sessionId]);
    const match = result.stdout.match(/Backup: (\S+\.backup-\d+)/);
    expect(match).not.toBeNull();
    expect(existsSync(match[1])).toBe(true);
    // Backup is byte-identical to the original session JSON before migration.
    const backupRaw = await fs.readFile(match[1], 'utf8');
    const parsed = JSON.parse(backupRaw);
    expect(parsed.eventsByTurn['turn-aaaa'][1].imageContent[0].data).toBe(PNG_B64);
  });

  it('refuses to migrate a session whose id contains path-traversal characters', async () => {
    const result = await runScript([
      '--user-data', tempDir,
      '--session', '../etc/passwd',
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/Invalid session id/);
  });
});

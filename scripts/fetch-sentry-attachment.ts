#!/usr/bin/env -S npx tsx
/**
 * fetch-sentry-attachment.ts
 *
 * Download a non-image Sentry attachment to disk so an AI agent can `Read` it.
 *
 * The Sentry MCP returns attachments as MCP `EmbeddedResource` objects.
 * Factory's CLI renders `image/*` resources inline (so screenshots are
 * directly viewable) but persists only a `[Embedded Resource: <mime>]`
 * placeholder for other MIME types — the bytes are dropped before the
 * agent sees them. This script is the documented fallback for those
 * non-image attachments. The MCP remains the primary channel.
 *
 * Usage:
 *   List attachments:
 *     npx tsx scripts/fetch-sentry-attachment.ts \
 *       --event <event_id> --list
 *
 *   Download a specific attachment:
 *     npx tsx scripts/fetch-sentry-attachment.ts \
 *       --event <event_id> --attachment <attachment_id>
 *     # → prints absolute path of the saved file on stdout
 *
 * Auth: reads `SENTRY_AUTH_TOKEN` from process.env, then from `.env.local`
 * and `.env` at the repo root (same loader semantics as other scripts in
 * this directory). See `.env.example` for setup instructions.
 *
 * Defaults:
 *   --org      mindstone
 *   --project  rebel
 *   --api-base $SENTRY_API_BASE_URL || https://us.sentry.io
 *   --out      /tmp/sentry/<event_id>/
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import process from 'node:process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');

const ENV_FILES = ['.env', '.env.local'];

function loadEnvFiles(): void {
  for (const fileName of ENV_FILES) {
    const filePath = join(projectRoot, fileName);
    if (!existsSync(filePath)) continue;
    let contents = '';
    try {
      contents = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    for (const rawLine of contents.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      if (!key) continue;
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  }
}

interface AttachmentMeta {
  id: string;
  name: string;
  size: number;
  mimetype: string;
  sha1: string;
  dateCreated: string;
}

const SETUP_HINT = `
SENTRY_AUTH_TOKEN is not set.

One-time setup (~3 minutes):
  1. Go to https://mindstone.sentry.io/settings/account/api/auth-tokens/
  2. Click "Create New Token" (a User Auth Token). Scopes: event:read, org:read, project:read.
     Must be a User Auth Token or Internal Integration — Organization Auth Tokens
     (the sntrys_ release tokens) can't carry event:read and will 403.
  3. Add to .env.local at the repo root:
       SENTRY_AUTH_TOKEN=<your-sentry-user-auth-token>
  4. Re-run this command.

See .env.example for the full setup block.
`.trim();

function fail(message: string, code = 1): never {
  process.stderr.write(message.endsWith('\n') ? message : message + '\n');
  process.exit(code);
}

async function main(): Promise<void> {
  loadEnvFiles();

  const { values } = parseArgs({
    options: {
      event: { type: 'string' },
      attachment: { type: 'string' },
      name: { type: 'string' },
      out: { type: 'string' },
      org: { type: 'string', default: 'mindstone' },
      project: { type: 'string', default: 'rebel' },
      'api-base': { type: 'string' },
      list: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(
      [
        'fetch-sentry-attachment.ts — download a Sentry event attachment to disk',
        '',
        'Usage:',
        '  --event <id>          Sentry event ID (required)',
        '  --list                List attachments for the event and exit',
        '  --attachment <id>     Sentry attachment ID to download',
        '  --name <filename>     Output filename (default: queried from Sentry)',
        '  --out <dir>           Output directory (default: /tmp/sentry/<event>/)',
        '  --org <slug>          Sentry org slug (default: mindstone)',
        '  --project <slug>      Sentry project slug (default: rebel)',
        '  --api-base <url>      Sentry API base (default: https://us.sentry.io)',
        '  -h, --help            Show this help',
        '',
        'See .env.example → SENTRY_AUTH_TOKEN for required setup.',
      ].join('\n') + '\n',
    );
    return;
  }

  const eventId = values.event;
  if (!eventId) fail('Missing required --event <id>. Use --help for usage.', 2);

  const token = process.env.SENTRY_AUTH_TOKEN;
  if (!token) fail(SETUP_HINT, 3);

  const apiBase = (values['api-base'] ?? process.env.SENTRY_API_BASE_URL ?? 'https://us.sentry.io').replace(/\/+$/, '');
  const org = values.org ?? 'mindstone';
  const project = values.project ?? 'rebel';

  const baseUrl = `${apiBase}/api/0/projects/${org}/${project}/events/${eventId}/attachments`;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

  if (values.list) {
    const res = await fetch(`${baseUrl}/`, { headers });
    if (!res.ok) {
      fail(`Sentry list failed: ${res.status} ${res.statusText}\nURL: ${baseUrl}/`, 4);
    }
    const items = (await res.json()) as AttachmentMeta[];
    process.stdout.write(JSON.stringify(items, null, 2) + '\n');
    return;
  }

  const attachmentId = values.attachment;
  if (!attachmentId) fail('Missing --attachment <id>. Use --list to see available attachments.', 2);

  let filename = values.name;
  if (!filename) {
    const listRes = await fetch(`${baseUrl}/`, { headers });
    if (!listRes.ok) {
      fail(`Sentry list (for filename lookup) failed: ${listRes.status} ${listRes.statusText}`, 4);
    }
    const items = (await listRes.json()) as AttachmentMeta[];
    const match = items.find((a) => a.id === attachmentId);
    if (!match) fail(`Attachment ${attachmentId} not found on event ${eventId}.`, 4);
    filename = match.name;
  }
  if (/[\\/]/.test(filename) || filename === '..' || filename.startsWith('.')) {
    fail(`Refusing unsafe filename: ${filename}`, 5);
  }

  const outDir = values.out ?? `/tmp/sentry/${eventId}`;
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, filename);

  const downloadUrl = `${baseUrl}/${attachmentId}/?download=1`;
  const dlRes = await fetch(downloadUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!dlRes.ok) {
    fail(`Sentry download failed: ${dlRes.status} ${dlRes.statusText}\nURL: ${downloadUrl}`, 4);
  }
  const buf = Buffer.from(await dlRes.arrayBuffer());
  writeFileSync(outPath, buf);
  process.stdout.write(outPath + '\n');
}

main().catch((err) => {
  fail(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`, 1);
});

import crypto from 'node:crypto';
import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { redactSensitiveString } from '../src/shared/utils/sentryRedaction';

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_TARGET_PATH = '/api/integrations/slack/events';
const LOG_NEEDLE = 'slack_webhook_received';
const SELF_TEST_SIGNING_SECRET = 'slack-smoke-self-test-secret-never-print';

export interface SlackSmokePayload {
  token: string;
  team_id: string;
  api_app_id: string;
  type: 'event_callback';
  event_id: string;
  event_time: number;
  event: {
    type: 'app_mention';
    team: string;
    team_id: string;
    user: string;
    text: string;
    channel: string;
    channel_type: 'channel';
    ts: string;
    thread_ts: string;
  };
}

export interface SignedSlackPayload {
  rawBody: string;
  timestamp: string;
  signature: string;
  headers: Record<string, string>;
}

export interface SmokeSuccess {
  ok: true;
  status: number;
  durationMs: number;
  targetUrl: string;
  logNeedle: typeof LOG_NEEDLE;
}

export interface SmokeFailure {
  ok: false;
  code: string;
  message: string;
  status?: number;
  durationMs?: number;
  targetUrl?: string;
  responsePreview?: string;
  logNeedle?: typeof LOG_NEEDLE;
}

export type SmokeResult = SmokeSuccess | SmokeFailure;

interface SmokeOptions {
  targetUrl: string;
  signingSecret: string;
  timeoutMs?: number;
  logReader?: () => string;
}

interface CliOptions {
  selfTest: boolean;
  targetUrl?: string;
  signingSecret?: string;
  signingSecretEnv: string;
  logFile?: string;
  timeoutMs: number;
}

export function createDeterministicSlackPayload(seed = 'stage8-smoke'): SlackSmokePayload {
  return {
    token: 'redacted-shape-only',
    team_id: 'T_SMOKE',
    api_app_id: 'A_SMOKE',
    type: 'event_callback',
    event_id: `E_${seed.replace(/[^A-Za-z0-9_-]/g, '_')}`,
    event_time: 1_779_854_400,
    event: {
      type: 'app_mention',
      team: 'T_SMOKE',
      team_id: 'T_SMOKE',
      user: 'U_SMOKE_USER',
      text: '<@U_SMOKE_BOT> smoke test',
      channel: 'C_SMOKE',
      channel_type: 'channel',
      ts: '1779854400.000100',
      thread_ts: '1779854400.000100',
    },
  };
}

export function createSignedSlackPayload(args: {
  payload?: SlackSmokePayload;
  signingSecret: string;
  timestamp?: number;
}): SignedSlackPayload {
  const payload = args.payload ?? createDeterministicSlackPayload();
  const rawBody = JSON.stringify(payload);
  const timestamp = String(args.timestamp ?? Math.floor(Date.now() / 1000));
  const signature = createSlackSignature({
    rawBody,
    signingSecret: args.signingSecret,
    timestamp,
  });

  return {
    rawBody,
    timestamp,
    signature,
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': signature,
    },
  };
}

export function createSlackSignature(args: {
  rawBody: string;
  signingSecret: string;
  timestamp: string;
}): string {
  const base = `v0:${args.timestamp}:${args.rawBody}`;
  return `v0=${crypto.createHmac('sha256', args.signingSecret).update(base).digest('hex')}`;
}

export function redactSmokeOutput(value: unknown): string {
  const raw = typeof value === 'string'
    ? value
    : value instanceof Error
      ? `${value.name}: ${value.message}`
      : JSON.stringify(value);
  return redactSensitiveString(raw);
}

export function toStructuredFailure(
  code: string,
  message: string,
  extra: Omit<SmokeFailure, 'ok' | 'code' | 'message'> = {},
): SmokeFailure {
  return {
    ok: false,
    code,
    message: redactSmokeOutput(message),
    ...sanitizeFailureExtra(extra),
  };
}

function sanitizeFailureExtra(extra: Omit<SmokeFailure, 'ok' | 'code' | 'message'>): Omit<SmokeFailure, 'ok' | 'code' | 'message'> {
  return {
    ...(typeof extra.status === 'number' ? { status: extra.status } : {}),
    ...(typeof extra.durationMs === 'number' ? { durationMs: extra.durationMs } : {}),
    ...(extra.targetUrl ? { targetUrl: redactSmokeOutput(extra.targetUrl) } : {}),
    ...(extra.responsePreview ? { responsePreview: redactSmokeOutput(extra.responsePreview).slice(0, 500) } : {}),
    ...(extra.logNeedle ? { logNeedle: extra.logNeedle } : {}),
  };
}

export async function runSlackCloudSmoke(options: SmokeOptions): Promise<SmokeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!options.signingSecret.trim()) {
    return toStructuredFailure('SIGNING_SECRET_MISSING', 'Slack signing secret is required for the signed smoke payload', {
      targetUrl: options.targetUrl,
    });
  }
  const signed = createSignedSlackPayload({ signingSecret: options.signingSecret });
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(options.targetUrl, {
      method: 'POST',
      body: signed.rawBody,
      headers: signed.headers,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    return toStructuredFailure('REQUEST_FAILED', redactSmokeOutput(err), {
      targetUrl: options.targetUrl,
      durationMs: Math.max(1, Date.now() - startedAt),
    });
  }
  clearTimeout(timer);

  const durationMs = Math.max(1, Date.now() - startedAt);
  const responseText = await response.text();
  if (durationMs > timeoutMs) {
    return toStructuredFailure('ACK_TIMEOUT', `Slack smoke ack exceeded ${timeoutMs}ms`, {
      status: response.status,
      durationMs,
      targetUrl: options.targetUrl,
      responsePreview: responseText,
    });
  }
  if (response.status !== 200) {
    return toStructuredFailure('ACK_STATUS_NOT_200', `Expected 200 ack, got ${response.status}`, {
      status: response.status,
      durationMs,
      targetUrl: options.targetUrl,
      responsePreview: responseText,
    });
  }
  if (!options.logReader) {
    return toStructuredFailure('LOG_ASSERTION_UNAVAILABLE', 'Provide --log-file so the smoke can assert slack_webhook_received was emitted', {
      status: response.status,
      durationMs,
      targetUrl: options.targetUrl,
      logNeedle: LOG_NEEDLE,
    });
  }

  const logFound = await waitForLogNeedle(options.logReader, LOG_NEEDLE, timeoutMs);
  if (!logFound) {
    return toStructuredFailure('LOG_NEEDLE_MISSING', `Did not find ${LOG_NEEDLE} in logs`, {
      status: response.status,
      durationMs,
      targetUrl: options.targetUrl,
      logNeedle: LOG_NEEDLE,
    });
  }

  return {
    ok: true,
    status: response.status,
    durationMs,
    targetUrl: redactSmokeOutput(options.targetUrl),
    logNeedle: LOG_NEEDLE,
  };
}

async function waitForLogNeedle(logReader: () => string, needle: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (logReader().includes(needle)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function verifyLocalSignature(args: {
  rawBody: string;
  headers: IncomingMessage['headers'];
  signingSecret: string;
}): boolean {
  const timestamp = Array.isArray(args.headers['x-slack-request-timestamp'])
    ? args.headers['x-slack-request-timestamp'][0]
    : args.headers['x-slack-request-timestamp'];
  const signature = Array.isArray(args.headers['x-slack-signature'])
    ? args.headers['x-slack-signature'][0]
    : args.headers['x-slack-signature'];
  if (!timestamp || !signature) return false;
  const expected = createSlackSignature({ rawBody: args.rawBody, signingSecret: args.signingSecret, timestamp });
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function createSelfTestServer(signingSecret: string, logLines: string[]): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== DEFAULT_TARGET_PATH) {
      sendJson(res, 404, { ok: false });
      return;
    }
    const rawBody = await readRequestBody(req);
    if (!verifyLocalSignature({ rawBody, headers: req.headers, signingSecret })) {
      sendJson(res, 401, { ok: false });
      return;
    }
    const parsed = JSON.parse(rawBody) as SlackSmokePayload;
    const teamIdHash = crypto.createHash('sha256').update(parsed.team_id).digest('hex').slice(0, 12);
    logLines.push(JSON.stringify({
      event: LOG_NEEDLE,
      teamIdHash,
      eventType: parsed.event.type,
      payloadBytes: Buffer.byteLength(rawBody, 'utf8'),
    }));
    sendJson(res, 200, { ok: true });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Self-test server did not expose a TCP address');
  }

  return {
    url: `http://127.0.0.1:${address.port}${DEFAULT_TARGET_PATH}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    }),
  };
}

export async function runSelfTest(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<SmokeResult> {
  const logLines: string[] = [];
  const server = await createSelfTestServer(SELF_TEST_SIGNING_SECRET, logLines);
  try {
    return await runSlackCloudSmoke({
      targetUrl: server.url,
      signingSecret: SELF_TEST_SIGNING_SECRET,
      timeoutMs,
      logReader: () => logLines.join('\n'),
    });
  } finally {
    await server.close();
  }
}

export function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    selfTest: false,
    signingSecretEnv: 'SLACK_SIGNING_SECRET',
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--self-test') {
      options.selfTest = true;
      continue;
    }
    if (arg === '--target-url') {
      options.targetUrl = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--signing-secret') {
      options.signingSecret = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--signing-secret-env') {
      options.signingSecretEnv = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--log-file') {
      options.logFile = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--timeout-ms') {
      const value = Number(requireValue(argv, index, arg));
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error('--timeout-ms must be a positive number');
      }
      options.timeoutMs = value;
      index += 1;
      continue;
    }
    throw new Error(`Unexpected argument at position ${index}.`);
  }

  return options;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function logReaderFromFile(logFile: string): () => string {
  return () => {
    try {
      return fs.readFileSync(logFile, 'utf8');
    } catch (err) {
      return redactSmokeOutput(err);
    }
  };
}

function sanitizeErrorMessage(err: unknown): string {
  return redactSmokeOutput(err instanceof Error ? err.message : String(err));
}

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCliArgs(argv);
  } catch (err) {
    console.error(JSON.stringify(toStructuredFailure('INVALID_ARGS', sanitizeErrorMessage(err))));
    return 1;
  }

  const result = options.selfTest
    ? await runSelfTest(options.timeoutMs)
    : await runSlackCloudSmoke({
      targetUrl: options.targetUrl ?? process.env.SLACK_CLOUD_SMOKE_URL ?? `http://127.0.0.1:3000${DEFAULT_TARGET_PATH}`,
      signingSecret: options.signingSecret ?? process.env[options.signingSecretEnv] ?? '',
      timeoutMs: options.timeoutMs,
      logReader: options.logFile ? logReaderFromFile(options.logFile) : undefined,
    });

  if (result.ok) {
    console.log('ok');
    return 0;
  }

  console.error(JSON.stringify(result));
  return 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (invokedPath === modulePath) {
  runCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(JSON.stringify(toStructuredFailure('UNHANDLED', sanitizeErrorMessage(err))));
      process.exitCode = 1;
    });
}

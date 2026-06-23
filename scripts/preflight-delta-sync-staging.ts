import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';

const DELTA_PAYLOAD_LIMIT_BYTES = 5 * 1024 * 1024;
const DELTA_CAPABILITY = 'session-event-delta-push';

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface PreflightConfig {
  cloudUrl: string;
  token?: string;
  sessionId: string;
}

export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface PreflightReport {
  ok: boolean;
  sessionId: string;
  cursor: number | null;
  payloadBytes: number | null;
  checks: PreflightCheck[];
}

interface HttpJsonResult {
  ok: boolean;
  status: number;
  body: unknown;
  capabilitiesHeader: string[];
}

function parseCapabilities(value: string | null): string[] {
  return (value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean).sort();
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function httpJson(
  fetchFn: FetchLike,
  config: Pick<PreflightConfig, 'cloudUrl' | 'token'>,
  path: string,
  init: RequestInit = {},
): Promise<HttpJsonResult> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetchFn(new URL(path, config.cloudUrl), { ...init, headers });
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return {
    ok: response.ok,
    status: response.status,
    body,
    capabilitiesHeader: parseCapabilities(response.headers.get('X-Rebel-Capabilities')),
  };
}

export function buildDeltaPreflightBody(sessionId: string, cursor: number): { body: Record<string, unknown>; payloadBytes: number } {
  const body = {
    baseSeq: cursor,
    events: [],
    metadataPatch: { title: `delta-sync-preflight-${sessionId}` },
    idempotencyKey: `delta-sync-preflight:${sessionId}:${cursor}`,
  };
  return { body, payloadBytes: Buffer.byteLength(JSON.stringify(body), 'utf8') };
}

export async function runDeltaSyncPreflight(
  config: PreflightConfig,
  fetchFn: FetchLike = fetch,
): Promise<PreflightReport> {
  const checks: PreflightCheck[] = [];
  let cursor: number | null = null;
  let payloadBytes: number | null = null;

  const health = await httpJson(fetchFn, config, '/api/health');
  const capabilityOk = health.capabilitiesHeader.includes(DELTA_CAPABILITY);
  checks.push({
    name: 'capability advertisement',
    ok: capabilityOk,
    detail: capabilityOk ? `received ${DELTA_CAPABILITY}` : 'missing X-Rebel-Capabilities delta-push header',
  });

  const preflight = await httpJson(
    fetchFn,
    config,
    `/api/sessions/${encodeURIComponent(config.sessionId)}/events?sinceSeq=0&limit=1`,
  );
  const preflightBody = jsonObject(preflight.body);
  const serverSeq = typeof preflightBody.serverSeq === 'number' && Number.isFinite(preflightBody.serverSeq)
    ? Math.floor(preflightBody.serverSeq)
    : 0;
  cursor = preflight.ok && serverSeq > 0 ? serverSeq : null;
  checks.push({
    name: 'lean preflight',
    ok: preflight.ok,
    detail: preflight.ok ? `serverSeq=${serverSeq}` : `GET events failed with HTTP ${preflight.status}`,
  });
  checks.push({
    name: 'cursor seeded',
    ok: preflight.ok && serverSeq > 0,
    detail: serverSeq > 0 ? `cursor=${serverSeq}` : 'fixture has no server seq; seed the oversized staging session first',
  });

  if (cursor !== null) {
    const built = buildDeltaPreflightBody(config.sessionId, cursor);
    payloadBytes = built.payloadBytes;
    const delta = await httpJson(fetchFn, config, `/api/sessions/${encodeURIComponent(config.sessionId)}/events`, {
      method: 'POST',
      body: JSON.stringify(built.body),
      headers: { 'X-Rebel-Surface': 'desktop' },
    });
    checks.push({
      name: 'first delta POST',
      ok: delta.ok && payloadBytes < DELTA_PAYLOAD_LIMIT_BYTES,
      detail: delta.ok
        ? `HTTP ${delta.status}, payloadBytes=${payloadBytes}`
        : `HTTP ${delta.status}, payloadBytes=${payloadBytes}`,
    });
  } else {
    checks.push({ name: 'first delta POST', ok: false, detail: 'skipped because cursor was not seeded' });
  }

  return {
    ok: checks.every((check) => check.ok),
    sessionId: config.sessionId,
    cursor,
    payloadBytes,
    checks,
  };
}

export function formatPreflightReport(report: PreflightReport): string {
  const lines = [
    `Delta sync staging preflight: ${report.ok ? 'GREEN' : 'RED'}`,
    `sessionId: ${report.sessionId}`,
    ...report.checks.map((check) => `${check.ok ? '✓' : '✗'} ${check.name} — ${check.detail}`),
  ];
  return lines.join('\n');
}

function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): { config: PreflightConfig; json: boolean } {
  const getValue = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const cloudUrl = getValue('--cloud-url') ?? env.STAGING_CLOUD_URL;
  if (!cloudUrl) throw new Error('Set STAGING_CLOUD_URL or pass --cloud-url');
  return {
    config: {
      cloudUrl,
      token: getValue('--token') ?? env.STAGING_CLOUD_TOKEN ?? env.REBEL_CLOUD_TOKEN,
      sessionId: getValue('--session') ?? env.STAGING_DELTA_SYNC_SESSION_ID ?? 'delta-sync-preflight-oversized',
    },
    json: argv.includes('--json'),
  };
}

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  try {
    const { config, json } = parseCliArgs(argv);
    const report = await runDeltaSyncPreflight(config);
    console.log(json ? JSON.stringify(report, null, 2) : formatPreflightReport(report));
    return report.ok ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void runCli().then((code) => { process.exitCode = code; });
}

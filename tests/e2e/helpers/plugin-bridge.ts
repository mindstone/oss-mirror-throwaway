/**
 * Shared helpers for E2E tests that interact with the plugin bridge HTTP endpoint.
 *
 * The bridge is an HTTP server running inside the Electron app that exposes
 * plugin CRUD operations. It writes its state (port + auth token) to:
 *   <userData>/mcp/rebel-inbox-bridge.json
 */

import fs from 'node:fs';
import path from 'node:path';

export interface BridgeState {
  port: number;
  token: string;
}

export interface BridgeResponse {
  ok: boolean;
  status: number;
  data: Record<string, unknown>;
}

export function readBridgeState(userDataPath: string): BridgeState | null {
  const bridgePath = path.join(userDataPath, 'mcp', 'rebel-inbox-bridge.json');
  try {
    const data = JSON.parse(fs.readFileSync(bridgePath, 'utf8'));
    if (typeof data.port === 'number' && typeof data.token === 'string') return data;
  } catch { /* not yet written */ }
  return null;
}

export async function waitForBridgeState(
  userDataPath: string,
  timeoutMs = 30000,
): Promise<BridgeState> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = readBridgeState(userDataPath);
    if (state) return state;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Bridge state not found at ${path.join(userDataPath, 'mcp', 'rebel-inbox-bridge.json')} after ${timeoutMs}ms`,
  );
}

export async function callBridge(
  bridge: BridgeState,
  endpoint: string,
  options: { method?: string; body?: unknown } = {},
): Promise<BridgeResponse> {
  const { method = 'POST', body } = options;
  const response = await fetch(`http://127.0.0.1:${bridge.port}${endpoint}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bridge.token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json();
  return { ok: response.ok, status: response.status, data: json as Record<string, unknown> };
}

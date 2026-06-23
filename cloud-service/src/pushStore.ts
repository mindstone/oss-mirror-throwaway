/**
 * Push Notification Token Store
 *
 * Manages device tokens for push notification delivery (APNs/FCM).
 * Tokens are persisted to a JSON file on the Fly volume and cached in memory.
 * Uses atomic writes (write-to-temp + rename) to prevent corruption.
 */

import fs from 'node:fs';
import path from 'node:path';
import { log } from './httpUtils';

interface PushToken {
  deviceToken: string;
  platform: 'ios' | 'android';
  registeredAt: number;
}

interface PushTokenStore {
  tokens: PushToken[];
}

let cache: PushTokenStore | null = null;

function getTokenFilePath(): string {
  return path.join(process.env.REBEL_USER_DATA || '/data', 'push-tokens.json');
}

function load(): PushTokenStore {
  const tokenFile = getTokenFilePath();
  try {
    const data = fs.readFileSync(tokenFile, 'utf-8');
    return JSON.parse(data) as PushTokenStore;
  } catch {
    return { tokens: [] };
  }
}

function save(store: PushTokenStore): void {
  const tokenFile = getTokenFilePath();
  const dir = path.dirname(tokenFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${tokenFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
  fs.renameSync(tmp, tokenFile);
}

function ensureLoaded(): PushTokenStore {
  if (!cache) cache = load();
  return cache;
}

export function registerToken(deviceToken: string, platform: 'ios' | 'android'): void {
  const store = load();
  const idx = store.tokens.findIndex((t) => t.deviceToken === deviceToken && t.platform === platform);
  if (idx >= 0) {
    store.tokens[idx].registeredAt = Date.now();
  } else {
    store.tokens.push({ deviceToken, platform, registeredAt: Date.now() });
  }
  save(store);
  cache = store;
  log({ level: 'info', msg: 'Push token registered', platform, tokenCount: store.tokens.length });
}

export function unregisterToken(deviceToken: string, platform?: 'ios' | 'android'): void {
  const store = load();
  store.tokens = store.tokens.filter((t) =>
    platform ? !(t.deviceToken === deviceToken && t.platform === platform) : t.deviceToken !== deviceToken
  );
  save(store);
  cache = store;
  log({ level: 'info', msg: 'Push token unregistered', tokenCount: store.tokens.length });
}

export function getTokens(): PushToken[] {
  return ensureLoaded().tokens;
}

/** Remove an invalid token reported by APNs/FCM. */
export function pruneToken(deviceToken: string): void {
  unregisterToken(deviceToken);
}

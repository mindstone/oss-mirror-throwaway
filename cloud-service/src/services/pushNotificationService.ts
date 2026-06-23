/**
 * Push Notification Service
 *
 * Sends Expo Push notifications for turn failures and tool approval requests.
 * Uses in-memory deduplication (30s window per type+kind+sessionId) to avoid
 * notification spam. Invalid tokens are pruned on delivery failure.
 *
 * Cloud-service is single-instance per user, so in-memory dedup is sufficient.
 */

import Expo, { type ExpoPushMessage, type ExpoPushTicket } from 'expo-server-sdk';
import { getTokens, pruneToken } from '../pushStore';
import { log } from '../httpUtils';
import {
  PushNotificationDataSchema,
  buildPushDedupKey,
  type PushNotificationData,
} from '@shared/schemas/pushNotifications';

const expo = new Expo();

/** In-memory dedup: key is `${type}:${kind}:${sessionId}`, value is timestamp of last send. */
const recentlySent = new Map<string, number>();
const DEDUP_WINDOW_MS = 30_000;

/** Periodically clean expired entries to prevent memory leaks. */
let cleanupScheduled = false;
function scheduleCleanup(): void {
  if (cleanupScheduled) return;
  cleanupScheduled = true;
  setTimeout(() => {
    cleanupScheduled = false;
    const now = Date.now();
    for (const [key, ts] of recentlySent) {
      if (now - ts > DEDUP_WINDOW_MS) recentlySent.delete(key);
    }
  }, DEDUP_WINDOW_MS * 2);
}

export interface PushNotificationOptions {
  title: string;
  body: string;
  /**
   * Typed wire payload. Constructed by the builders in
   * `@shared/schemas/pushNotifications` so call sites can't drift. The
   * payload is re-validated at the boundary below; if validation fails
   * (programming error or stale builder), we log structured details and
   * abort — the existing fire-and-forget `.catch(() => {})` at every
   * call site swallows the rejection so push failures never block the
   * primary cloud-event path.
   */
  data: PushNotificationData;
}

export async function sendPushNotification(options: PushNotificationOptions): Promise<void> {
  const { title, body } = options;

  // Boundary parse: belt-and-braces. TypeScript catches builder misuse at
  // the call site; this catches anything that slips through (e.g., a test
  // mocking with a hand-rolled object). On failure we log + reject, so the
  // failure is observable but the existing `.catch(() => {})` keeps the
  // primary flow non-blocking. Matches AGENTS.md "silent failure is a bug".
  const parsed = PushNotificationDataSchema.safeParse(options.data);
  if (!parsed.success) {
    log({
      level: 'warn',
      msg: 'Invalid push notification payload — dropping send',
      issues: parsed.error.flatten(),
    });
    throw new Error('Invalid push notification payload');
  }
  const data = parsed.data;

  // 1. Dedup check: skip if same (type, kind, sessionId) sent within window
  const dedupKey = buildPushDedupKey(data);
  const lastSent = recentlySent.get(dedupKey);
  if (lastSent && Date.now() - lastSent < DEDUP_WINDOW_MS) {
    log({ level: 'debug', msg: 'Push notification deduped', dedupKey });
    return;
  }

  // 2. Get all registered tokens
  const tokens = getTokens();
  if (tokens.length === 0) {
    log({ level: 'debug', msg: 'No push tokens registered, skipping notification' });
    return;
  }

  // 3. Filter valid Expo push tokens
  const validTokens = tokens.filter((t) => Expo.isExpoPushToken(t.deviceToken));
  if (validTokens.length === 0) {
    log({ level: 'warn', msg: 'No valid Expo push tokens found', totalTokens: tokens.length });
    return;
  }

  // 4. Build messages
  const messages: ExpoPushMessage[] = validTokens.map((t) => ({
    to: t.deviceToken,
    sound: 'default' as const,
    title,
    body,
    data,
  }));

  // 5. Send in chunks via Expo Push API
  const chunks = expo.chunkPushNotifications(messages);
  const tickets: ExpoPushTicket[] = [];

  for (const chunk of chunks) {
    try {
      const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
      tickets.push(...ticketChunk);
    } catch (err) {
      log({ level: 'warn', msg: 'Failed to send push notification chunk', error: (err as Error).message });
    }
  }

  // 6. Check tickets for errors and prune invalid tokens
  for (let i = 0; i < tickets.length; i++) {
    const ticket = tickets[i];
    if (ticket.status === 'error') {
      const token = validTokens[i]?.deviceToken;
      log({
        level: 'warn',
        msg: 'Push notification delivery error',
        token: token ? `${token.slice(0, 20)}...` : 'unknown',
        errorMessage: ticket.message,
        errorDetails: ticket.details?.error,
      });
      // Prune tokens that the push service reports as invalid
      if (ticket.details?.error === 'DeviceNotRegistered' && token) {
        log({ level: 'info', msg: 'Pruning invalid push token', token: `${token.slice(0, 20)}...` });
        pruneToken(token);
      }
    }
  }

  // 7. Update dedup map
  recentlySent.set(dedupKey, Date.now());
  scheduleCleanup();

  log({
    level: 'info',
    msg: 'Push notification sent',
    title,
    type: data.type,
    sessionId: data.sessionId,
    tokenCount: validTokens.length,
    successCount: tickets.filter((t) => t.status === 'ok').length,
  });
}

/**
 * Event channel WebSocket handler — persistent event push to desktop clients.
 */

import { WebSocket } from 'ws';
import { cloudEventBroadcaster } from '../cloudEventBroadcaster';
import { log } from '../httpUtils';

export function handleEventChannelWs(ws: WebSocket): void {
  log({ level: 'info', msg: 'Event channel client connected' });
  cloudEventBroadcaster.addClient(ws);

  ws.on('message', (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }

    const event = parsed as { channel?: unknown; args?: unknown[] };
    if (event.channel !== 'tokens:provider-changed') return;
    if (!Array.isArray(event.args) || event.args.length === 0) return;
    const payload = event.args[0];
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;

    cloudEventBroadcaster.broadcast('tokens:provider-changed', payload);
  });
}

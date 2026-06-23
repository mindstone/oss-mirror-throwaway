import { getBroadcastService } from '@core/broadcastService';
import type { EventWindow } from '@core/types';
import { assertEventHasSeq, type SequencedAgentEvent } from '@shared/utils/eventIdentity';

export type SequencedAgentEventBroadcastPayload = {
  turnId: string;
  sessionId?: string;
  event: SequencedAgentEvent;
};

export function broadcastSequencedAgentEvent(
  payload: SequencedAgentEventBroadcastPayload,
): void {
  assertEventHasSeq(payload.event, 'broadcastSequencedAgentEvent');
  // eslint-disable-next-line no-restricted-syntax -- seq-stamped agent:event chokepoint; new call sites must use this helper.
  getBroadcastService().sendToAllWindows('agent:event', payload);
}

export function sendSequencedAgentEventToWindow(
  win: EventWindow | null,
  payload: SequencedAgentEventBroadcastPayload,
): void {
  if (!win || win.isDestroyed()) return;
  assertEventHasSeq(payload.event, 'sendSequencedAgentEventToWindow');
  // eslint-disable-next-line no-restricted-syntax -- seq-stamped window-specific agent:event chokepoint for dispatcher-targeted sends.
  win.webContents.send('agent:event', payload);
}

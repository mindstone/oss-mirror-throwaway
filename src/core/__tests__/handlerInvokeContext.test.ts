import { describe, it, expect } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import type { HandlerInvokeContext, HandlerInvokeEvent } from '@core/handlerRegistry';

describe('HandlerInvokeContext', () => {
  it("Electron's IpcMainInvokeEvent is assignable to HandlerInvokeContext", () => {
    type IsAssignable = IpcMainInvokeEvent extends HandlerInvokeContext ? true : never;
    const proof: IsAssignable = true;
    expect(proof).toBe(true);
  });

  it('accepts the cloud-shape null event as a HandlerInvokeEvent', () => {
    const cloudEvent: HandlerInvokeEvent = null;
    expect(cloudEvent).toBeNull();
  });

  it('accepts a desktop-shape event with sender.id as a HandlerInvokeEvent', () => {
    const desktopEvent: HandlerInvokeEvent = { sender: { id: 42 } };
    expect(desktopEvent?.sender?.id).toBe(42);
  });

  it('supports the null-guarded cancellation-key pattern used by cloud-shared handlers', () => {
    const events: HandlerInvokeEvent[] = [null, { sender: { id: 7 } }];
    const senderIds: Array<number | string> = events.map(
      (event) => event?.sender?.id ?? 'cloud-process',
    );
    expect(senderIds).toEqual(['cloud-process', 7]);
  });
});

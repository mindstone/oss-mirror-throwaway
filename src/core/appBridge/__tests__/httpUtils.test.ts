/**
 * httpUtils — `readJsonBody` abort-handling unit tests.
 *
 * Covers the resilience hardening added alongside the TOFU-vs-claim-timeout
 * fix: if a client aborts a request before the JSON body finishes
 * streaming, `readJsonBody` must reject promptly and stop leaking listeners
 * on the `IncomingMessage`. See
 * docs-private/investigations/260423_tofu_vs_claim_timeout_bug.md.
 */

import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { readJsonBody } from '@core/appBridge/server/httpUtils';

/**
 * Lightweight `IncomingMessage` stand-in. `readJsonBody` only reaches for
 * a handful of EventEmitter-style methods plus `destroy`, `destroyed`, and
 * the deprecated `aborted` property, so an EventEmitter-backed fake keeps
 * the test surface tight and deterministic (no real sockets, no timers).
 */
class FakeIncomingMessage extends EventEmitter {
  public destroyed = false;
  public aborted = false;

  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

function asIncoming(fake: FakeIncomingMessage): IncomingMessage {
  return fake as unknown as IncomingMessage;
}

describe('readJsonBody abort handling', () => {
  it('rejects immediately when the request is already destroyed', async () => {
    const fake = new FakeIncomingMessage();
    fake.destroyed = true;

    await expect(readJsonBody(asIncoming(fake))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('rejects immediately when the request is already aborted', async () => {
    const fake = new FakeIncomingMessage();
    fake.aborted = true;

    await expect(readJsonBody(asIncoming(fake))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it(
    "rejects when 'close' fires before 'end' (client aborted mid-body) " +
      'and removes every registered listener to avoid leaks',
    async () => {
      const fake = new FakeIncomingMessage();
      const pending = readJsonBody(asIncoming(fake));

      // Partial body arrives, then the socket closes before `'end'`
      // fires. Without the abort handling, this promise would never
      // settle and the listeners would stay attached forever.
      fake.emit('data', Buffer.from('{"part'));
      fake.emit('close');

      await expect(pending).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(fake.listenerCount('data')).toBe(0);
      expect(fake.listenerCount('error')).toBe(0);
      expect(fake.listenerCount('end')).toBe(0);
      expect(fake.listenerCount('close')).toBe(0);
      expect(fake.listenerCount('aborted')).toBe(0);
    },
  );

  it("rejects when 'aborted' fires before 'end'", async () => {
    const fake = new FakeIncomingMessage();
    const pending = readJsonBody(asIncoming(fake));

    fake.emit('aborted');

    await expect(pending).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(fake.listenerCount('data')).toBe(0);
    expect(fake.listenerCount('end')).toBe(0);
    expect(fake.listenerCount('close')).toBe(0);
  });

  it('still resolves normally when end fires after data (happy path)', async () => {
    const fake = new FakeIncomingMessage();
    const pending = readJsonBody(asIncoming(fake));

    fake.emit('data', Buffer.from('{"hello":"world"}'));
    fake.emit('end');
    // `'close'` fires after `'end'` on real IncomingMessage; the handler
    // must be idempotent — no second resolve/reject, and every listener
    // cleanup() attached must have dropped to zero by this point.
    fake.emit('close');

    await expect(pending).resolves.toEqual({ hello: 'world' });
    expect(fake.listenerCount('data')).toBe(0);
    expect(fake.listenerCount('error')).toBe(0);
    expect(fake.listenerCount('end')).toBe(0);
    expect(fake.listenerCount('close')).toBe(0);
    expect(fake.listenerCount('aborted')).toBe(0);
  });

  it('resolves to {} for an empty body', async () => {
    const fake = new FakeIncomingMessage();
    const pending = readJsonBody(asIncoming(fake));

    fake.emit('end');

    await expect(pending).resolves.toEqual({});
  });

  it("rejects when an 'error' event fires", async () => {
    const fake = new FakeIncomingMessage();
    const pending = readJsonBody(asIncoming(fake));

    const boom = new Error('socket blew up');
    fake.emit('error', boom);

    await expect(pending).rejects.toBe(boom);
    expect(fake.listenerCount('data')).toBe(0);
    expect(fake.listenerCount('close')).toBe(0);
  });

  it('rejects oversized bodies and destroys the request', async () => {
    const fake = new FakeIncomingMessage();
    const destroySpy = vi.spyOn(fake, 'destroy');
    const pending = readJsonBody(asIncoming(fake));

    // 500_000 is the documented cap; push 500_001 bytes in one chunk so
    // the size-check branch fires on the first `'data'` event.
    fake.emit('data', Buffer.alloc(500_001, 0x61));

    await expect(pending).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(destroySpy).toHaveBeenCalled();
    // Regression guard: the oversize branch must run the same cleanup as
    // every other rejection path — otherwise an attacker could starve the
    // process by flooding it with truncated oversize requests and
    // leaving listeners pinned to each IncomingMessage.
    expect(fake.listenerCount('data')).toBe(0);
    expect(fake.listenerCount('error')).toBe(0);
    expect(fake.listenerCount('end')).toBe(0);
    expect(fake.listenerCount('close')).toBe(0);
    expect(fake.listenerCount('aborted')).toBe(0);
  });
});

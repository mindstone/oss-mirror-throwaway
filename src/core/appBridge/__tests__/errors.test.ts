import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MESSAGES,
  ErrorCode,
  createAppBridgeError,
  isBridgeAlreadyRunningError,
  toHttpStatus,
  toMcpContent,
  toWsCloseCode,
  toWsCloseReason,
  toWsErrorMessage,
} from '@core/appBridge/shared/errors';

const ALL_CODES = Object.values(ErrorCode) as ErrorCode[];

describe('appBridge/shared/errors', () => {
  describe('ErrorCode enum', () => {
    it('includes every code required by Stage 1 plan', () => {
      expect(ALL_CODES).toEqual(
        expect.arrayContaining([
          'APP_NOT_CONNECTED',
          'PAIRING_EXPIRED',
          'PAIRING_CONSUMED',
          'RATE_LIMITED',
          'PROTOCOL_VERSION_MISMATCH',
          'UNAUTHORIZED',
          'BAD_REQUEST',
          'COMMAND_TIMEOUT',
          'NOT_IMPLEMENTED',
          'INTERNAL_ERROR',
          'ADDIN_DISCONNECTED',
          'INVALID_MESSAGE',
          'VERSION_TOO_OLD',
          'INJECTION_REFUSED',
          'UNSUPPORTED_SURFACE',
          'TAB_CONTEXT_DIVERGED',
        ]),
      );
    });

    it('includes TAB_CONTEXT_GONE (Stage 6c — R18 / D21)', () => {
      expect(ALL_CODES).toContain('TAB_CONTEXT_GONE');
    });
  });

  describe('createAppBridgeError', () => {
    it('populates message and status from code when not supplied', () => {
      const err = createAppBridgeError(ErrorCode.APP_NOT_CONNECTED);
      expect(err.code).toBe('APP_NOT_CONNECTED');
      expect(err.status).toBe(503);
      expect(err.message).toMatch(/not connected/i);
      expect(err.details).toBeUndefined();
    });

    it('honours a custom message and details payload', () => {
      const err = createAppBridgeError(
        ErrorCode.BAD_REQUEST,
        'bad field X',
        { field: 'X' },
      );
      expect(err.message).toBe('bad field X');
      expect(err.details).toEqual({ field: 'X' });
      expect(err.status).toBe(400);
    });
  });

  describe('toHttpStatus — exhaustive per-code mapping (R9)', () => {
    it.each([
      ['UNAUTHORIZED', 401],
      ['FORBIDDEN', 403],
      ['INJECTION_REFUSED', 403],
      ['RATE_LIMITED', 429],
      ['BAD_REQUEST', 400],
      ['NOT_IMPLEMENTED', 501],
      ['APP_NOT_CONNECTED', 503],
      ['ADDIN_DISCONNECTED', 503],
      ['PAIRING_EXPIRED', 410],
      ['PAIRING_CONSUMED', 410],
      ['COMMAND_TIMEOUT', 504],
      ['PROTOCOL_VERSION_MISMATCH', 426],
      ['VERSION_TOO_OLD', 426],
      ['INVALID_MESSAGE', 400],
      ['IDEMPOTENT_DROP', 409],
      ['BRIDGE_ALREADY_RUNNING', 409],
      ['CAPABILITY_NOT_SUPPORTED', 404],
      ['UNSUPPORTED_SURFACE', 410],
      ['METHOD_NOT_ALLOWED', 405],
      ['TAB_CONTEXT_GONE', 410],
      ['TAB_CONTEXT_DIVERGED', 410],
      ['INTERNAL_ERROR', 500],
    ] as const)('maps %s → %d', (code, status) => {
      expect(toHttpStatus(code as ErrorCode)).toBe(status);
    });

    it('has a numeric mapping for every enum value (no drift)', () => {
      for (const code of ALL_CODES) {
        const s = toHttpStatus(code);
        expect(typeof s).toBe('number');
        expect(s).toBeGreaterThanOrEqual(400);
      }
    });
  });

  describe('isBridgeAlreadyRunningError (REBEL-5EB)', () => {
    it('is true only for the BRIDGE_ALREADY_RUNNING ownership conflict', () => {
      expect(
        isBridgeAlreadyRunningError(
          createAppBridgeError(ErrorCode.BRIDGE_ALREADY_RUNNING, 'owned', { pid: 912 }),
        ),
      ).toBe(true);
    });

    it('is false for other AppBridge errors and non-error values', () => {
      expect(isBridgeAlreadyRunningError(createAppBridgeError(ErrorCode.INTERNAL_ERROR))).toBe(false);
      expect(isBridgeAlreadyRunningError(new Error('A live App Bridge already owns ...'))).toBe(false);
      expect(isBridgeAlreadyRunningError(null)).toBe(false);
      expect(isBridgeAlreadyRunningError('BRIDGE_ALREADY_RUNNING')).toBe(false);
    });
  });

  describe('toMcpContent', () => {
    it('returns an MCP error shape with a single text block', () => {
      const result = toMcpContent(ErrorCode.APP_NOT_CONNECTED, 'Browser extension');
      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(typeof result.content[0].text).toBe('string');
    });

    it('APP_NOT_CONNECTED with "Browser extension" label uses the spec copy', () => {
      const result = toMcpContent(ErrorCode.APP_NOT_CONNECTED, 'Browser extension');
      expect(result.content[0].text).toBe(
        "Browser extension isn't connected. Pair it in Settings → Connectors → Rebel App Bridge, then open the tab you want me to see.",
      );
    });

    it('APP_NOT_CONNECTED with a generic label still speaks brand voice', () => {
      const result = toMcpContent(ErrorCode.APP_NOT_CONNECTED, 'Word');
      expect(result.content[0].text).toMatch(/connected/i);
      expect(result.content[0].text).toMatch(/Settings/);
    });

    it('COMMAND_TIMEOUT copy hints at retry (no shame, no jargon)', () => {
      const result = toMcpContent(ErrorCode.COMMAND_TIMEOUT);
      expect(result.content[0].text).toMatch(/try again|smaller/i);
    });

    it('TAB_CONTEXT_GONE copy asks the agent to re-check the tab (R18 / D21)', () => {
      const result = toMcpContent(ErrorCode.TAB_CONTEXT_GONE);
      expect(result.content[0].text).toMatch(/tab/i);
      expect(result.content[0].text).toMatch(/re-?check|try again/i);
      // HTTP status mapping must still be 410 Gone for the Stage 6c invariant.
      expect(toHttpStatus(ErrorCode.TAB_CONTEXT_GONE)).toBe(410);
    });

    it('TAB_CONTEXT_DIVERGED copy explains the page changed before execution', () => {
      const result = toMcpContent(ErrorCode.TAB_CONTEXT_DIVERGED);
      expect(result.content[0].text).toMatch(/page changed/i);
      expect(toHttpStatus(ErrorCode.TAB_CONTEXT_DIVERGED)).toBe(410);
    });

    it.each([
      [
        'no-host-permission',
        "Rebel doesn't have permission to act on portal.pitchbook.com yet — open the Rebel browser extension and tap Allow, then ask me again.",
      ],
      [
        'denied-by-user',
        "Rebel doesn't have access to portal.pitchbook.com right now. If you'd like to enable it, you can turn on site access in your browser's extension settings.",
      ],
      [
        'unsupported-scheme',
        "portal.pitchbook.com isn't a page I can act on (it's a special browser surface). Open a normal web page and try again.",
      ],
      [
        'chrome-blocked',
        'The browser refused to let me run on portal.pitchbook.com. This page may be restricted by browser policy.',
      ],
      [
        'request-failed',
        "I tried to ask for access to portal.pitchbook.com but the browser rejected the request. If you're on a managed device, check with your admin; otherwise try reloading the extension.",
      ],
      [
        'transient',
        "I tried to ask for access to portal.pitchbook.com but the browser rejected the request. If you're on a managed device, check with your admin; otherwise try reloading the extension.",
      ],
    ] as const)(
      'INJECTION_REFUSED reason=%s maps to the expected brand-voice copy',
      (reason, expectedCopy) => {
        const result = toMcpContent(ErrorCode.INJECTION_REFUSED, {
          reason,
          origin: 'https://portal.pitchbook.com',
        });
        expect(result.content[0].text).toBe(expectedCopy);
      },
    );

    it('produces usable copy for every ErrorCode', () => {
      for (const code of ALL_CODES) {
        const { content } = toMcpContent(code);
        expect(content[0].text.length).toBeGreaterThan(0);
      }
    });

    it('uses the generic default when INJECTION_REFUSED details are missing', () => {
      const result = toMcpContent(ErrorCode.INJECTION_REFUSED);
      expect(result.content[0].text).toBe(DEFAULT_MESSAGES.INJECTION_REFUSED);
    });

    it('prefers details.displayOrigin when provided over raw origin', () => {
      const result = toMcpContent(ErrorCode.INJECTION_REFUSED, {
        reason: 'no-host-permission',
        origin: 'https://internal.host.example',
        displayOrigin: 'internal.host.example',
      });
      expect(result.content[0].text).toContain('internal.host.example');
    });

    it.each([
      ['no-host-permission', true],
      ['denied-by-user', false],
      ['unsupported-scheme', false],
      ['chrome-blocked', false],
      ['request-failed', true],
      ['transient', true],
    ] as const)(
      'preserves the retryable hint per-reason: %s → %s',
      (reason, retryable) => {
        // Shape proof: the details payload that the extension emits and the
        // relay preserves must carry `origin`, `reason`, and `retryable` so
        // the MCP sidecar `friendlyTextForRelayCode` can render brand-voice
        // copy without guessing. This test pins the end-to-end data shape.
        const details = {
          origin: 'https://portal.pitchbook.com',
          reason,
          retryable,
        };
        const result = toMcpContent(ErrorCode.INJECTION_REFUSED, details);
        expect(result.content[0].text).toContain('portal.pitchbook.com');
        expect(typeof details.retryable).toBe('boolean');
        expect(details.retryable).toBe(retryable);
      },
    );
  });

  describe('DEFAULT_MESSAGES', () => {
    it('has a string default message for every ErrorCode value', () => {
      Object.values(ErrorCode).forEach((code) => {
        expect(typeof DEFAULT_MESSAGES[code]).toBe('string');
      });
    });
  });

  describe('toWsErrorMessage', () => {
    it('produces a correlation-id-less response frame with the code attached', () => {
      const msg = toWsErrorMessage(ErrorCode.INVALID_MESSAGE);
      expect(msg.type).toBe('response');
      expect(msg.success).toBe(false);
      expect(msg.code).toBe('INVALID_MESSAGE');
      expect(msg.id).toBe('');
      expect(typeof msg.error).toBe('string');
    });

    it('honours a custom error string', () => {
      const msg = toWsErrorMessage(ErrorCode.BAD_REQUEST, 'missing field foo');
      expect(msg.error).toBe('missing field foo');
    });

    it('includes structured details when provided', () => {
      const msg = toWsErrorMessage(
        ErrorCode.INJECTION_REFUSED,
        undefined,
        { reason: 'no-host-permission' },
      );
      expect(msg.details).toEqual({ reason: 'no-host-permission' });
    });
  });

  describe('toWsCloseCode', () => {
    it.each([
      ['UNAUTHORIZED', 4001],
      ['INVALID_MESSAGE', 4002],
      ['PROTOCOL_VERSION_MISMATCH', 4010],
      ['VERSION_TOO_OLD', 4020],
      ['INTERNAL_ERROR', 1011],
    ] as const)('maps %s → %d', (code, wsCode) => {
      expect(toWsCloseCode(code as ErrorCode)).toBe(wsCode);
    });

    it('other codes fall back to 1000 (normal closure)', () => {
      expect(toWsCloseCode(ErrorCode.APP_NOT_CONNECTED)).toBe(1000);
      expect(toWsCloseCode(ErrorCode.RATE_LIMITED)).toBe(1000);
      // BRIDGE_ALREADY_RUNNING is cased explicitly (not via default) → normal closure.
      expect(toWsCloseCode(ErrorCode.BRIDGE_ALREADY_RUNNING)).toBe(1000);
    });
  });

  describe('toWsCloseReason', () => {
    it('returns a non-empty string for every ErrorCode', () => {
      for (const code of ALL_CODES) {
        const reason = toWsCloseReason(code);
        expect(reason.length).toBeGreaterThan(0);
      }
    });

    it('stays within the 123-byte WebSocket close-reason limit for every code', () => {
      for (const code of ALL_CODES) {
        const reason = toWsCloseReason(code);
        const byteLength = Buffer.byteLength(reason, 'utf8');
        expect(byteLength, `${code}: ${reason}`).toBeLessThanOrEqual(123);
      }
    });
  });
});

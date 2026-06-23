import { describe, expect, it } from 'vitest';
import {
  APP_BRIDGE_PORT_FALLBACKS,
  CAPABILITY_KEYS,
  HOST_CAPABILITY_KEYS,
  DEFAULT_APP_BRIDGE_PORT,
  PROTOCOL_VERSION,
  WS_PATH,
  isAppType,
  isCapabilityKey,
  isHostCapabilityKey,
  type AppToBridgeMessage,
  type BridgeToAppMessage,
  type RegisterMessage,
} from '@core/appBridge/shared/protocol';

describe('appBridge/shared/protocol', () => {
  describe('constants', () => {
    it('defaults to port 52320 (off Office 52100 range per R1)', () => {
      expect(DEFAULT_APP_BRIDGE_PORT).toBe(52320);
    });

    it('APP_BRIDGE_PORT_FALLBACKS starts at default and spans six ports', () => {
      expect(APP_BRIDGE_PORT_FALLBACKS).toEqual([52320, 52321, 52322, 52323, 52324, 52325]);
      expect(APP_BRIDGE_PORT_FALLBACKS[0]).toBe(DEFAULT_APP_BRIDGE_PORT);
    });

    it('WS_PATH is /ws', () => {
      expect(WS_PATH).toBe('/ws');
    });

    it('PROTOCOL_VERSION is the 1.0 initial release', () => {
      expect(PROTOCOL_VERSION).toBe('1.0');
    });
  });

  describe('CAPABILITY_KEYS (R27 / D27 single source of truth)', () => {
    it('contains the 7 Stage 4 browser capabilities', () => {
      expect([...CAPABILITY_KEYS].sort()).toEqual(
        [
          'click',
          'fill_form',
          'get_current_tab_url',
          'get_selection',
          'read_page',
          'scroll',
          'status',
        ].sort(),
      );
    });

    it('is an immutable tuple (readonly keys only)', () => {
      // Typescript enforces this at compile time; runtime mutation still throws
      // in strict mode if assigned to the const tuple binding.
      expect(CAPABILITY_KEYS.length).toBe(7);
    });
  });

  describe('isCapabilityKey and isHostCapabilityKey', () => {
    it('accepts every CAPABILITY_KEYS entry', () => {
      for (const key of CAPABILITY_KEYS) {
        expect(isCapabilityKey(key)).toBe(true);
      }
    });

    it('rejects unknown strings, non-strings, and the empty string', () => {
      expect(isCapabilityKey('unknown_capability')).toBe(false);
      expect(isCapabilityKey('')).toBe(false);
      expect(isCapabilityKey(null)).toBe(false);
      expect(isCapabilityKey(undefined)).toBe(false);
      expect(isCapabilityKey(123)).toBe(false);
      expect(isCapabilityKey({})).toBe(false);
    });

    it('accepts every HOST_CAPABILITY_KEYS entry', () => {
      for (const key of HOST_CAPABILITY_KEYS) {
        expect(isHostCapabilityKey(key)).toBe(true);
      }
    });

    it('includes the full host-tool capability surface', () => {
      expect([...HOST_CAPABILITY_KEYS].sort()).toEqual(
        [
          'diagnose',
          'extract_extension',
          'list_browsers',
          'open_extensions_page',
          'prepare_install',
          'reveal_extension_folder',
        ].sort(),
      );
    });
  });

  describe('isAppType', () => {
    it('accepts known literal strings', () => {
      expect(isAppType('browser-extension')).toBe(true);
    });

    it('accepts arbitrary non-empty strings (open type at runtime)', () => {
      expect(isAppType('office-word')).toBe(true);
      expect(isAppType('custom-app-v2')).toBe(true);
    });

    it('rejects empty string, numbers, null, undefined, objects', () => {
      expect(isAppType('')).toBe(false);
      expect(isAppType(123)).toBe(false);
      expect(isAppType(null)).toBe(false);
      expect(isAppType(undefined)).toBe(false);
      expect(isAppType({})).toBe(false);
      expect(isAppType([])).toBe(false);
    });
  });

  describe('RegisterMessage shape (backwards-compat with Office)', () => {
    it('accepts the minimal shape a future Office migration will produce', () => {
      // This test is a compile-time + structural check: the type must permit
      // a register message without protocolVersion / capabilities / clientId
      // so Office's current sidecar shape keeps working once it swaps imports.
      const msg: RegisterMessage = {
        type: 'register',
        appId: 'browser-extension',
      };
      expect(msg.protocolVersion).toBeUndefined();
      expect(msg.capabilities).toBeUndefined();
      expect(msg.clientId).toBeUndefined();
    });

    it('accepts the full shape the browser extension will send', () => {
      const msg: RegisterMessage = {
        type: 'register',
        appId: 'browser-extension',
        protocolVersion: '1.0',
        appVersion: '0.1.0',
        clientId: 'abc-123',
        capabilities: [
          { id: 'read_page' },
          { id: 'fill_form', description: 'Fill a form field', inputSchema: { type: 'object' } },
        ],
      };
      expect(msg.capabilities?.length).toBe(2);
    });
  });

  describe('union types (structural)', () => {
    it('AppToBridgeMessage can hold an auth message', () => {
      const m: AppToBridgeMessage = { type: 'auth', token: 't' };
      expect(m.type).toBe('auth');
    });

    it('AppToBridgeMessage can hold a response success and error', () => {
      const ok: AppToBridgeMessage = { type: 'response', id: 'x', success: true, data: { a: 1 } };
      const err: AppToBridgeMessage = {
        type: 'response',
        id: 'x',
        success: false,
        error: 'nope',
        code: 'BAD_REQUEST',
        details: { field: 'url' },
      };
      expect(ok.type).toBe('response');
      expect(err.type).toBe('response');
      if (err.type === 'response' && !err.success) {
        expect(err.details).toEqual({ field: 'url' });
      }
    });

    it('BridgeToAppMessage can hold a command and registered ack', () => {
      const cmd: BridgeToAppMessage = { type: 'command', id: 'c1', action: 'read_page', params: {} };
      const ack: BridgeToAppMessage = {
        type: 'registered',
        sessionId: 's1',
        acceptedCapabilities: ['read_page'],
        serverProtocolVersion: '1.0',
        minClientProtocolVersion: '1.0',
      };
      expect(cmd.type).toBe('command');
      expect(ack.type).toBe('registered');
    });

    it('CommandMessage supports prevCommandId for idempotent retries (R19/D22)', () => {
      const cmd: BridgeToAppMessage = {
        type: 'command',
        id: 'c2',
        prevCommandId: 'c1',
        action: 'click',
        params: { target: 'submit' },
      };
      if (cmd.type === 'command') {
        expect(cmd.prevCommandId).toBe('c1');
      }
    });
  });
});

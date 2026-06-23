import { describe, expect, it } from 'vitest';
import {
  createRoutedError,
  getErrorKind,
  isRoutedError,
  type AgentErrorKind,
} from '../agentErrorCatalog';

const LEGACY_SENTINEL_CASES: ReadonlyArray<readonly [string, AgentErrorKind]> = [
  ['RATE_LIMIT_RETRY: wait before retry', 'rate_limit'],
  ['SERVER_ERROR_RETRY: upstream 500', 'server_error'],
  ['API_ERROR_INTERCEPT: API Error: 400', 'invalid_request'],
  ['TOOL_NAME_CORRUPT_RETRY: name too long', 'tool_name_corrupt'],
  ['SESSION_NOT_FOUND_RETRY: stale session', 'session_not_found'],
];

const ROUTED_ERROR_SENTINEL_CASES: ReadonlyArray<readonly [AgentErrorKind, string]> = [
  ['rate_limit', 'RATE_LIMIT_RETRY'],
  ['server_error', 'SERVER_ERROR_RETRY'],
  ['invalid_request', 'API_ERROR_INTERCEPT'],
  ['tool_name_corrupt', 'TOOL_NAME_CORRUPT_RETRY'],
  ['session_not_found', 'SESSION_NOT_FOUND_RETRY'],
];

describe('agentErrorCatalog', () => {
  describe('createRoutedError', () => {
    for (const [kind, prefix] of ROUTED_ERROR_SENTINEL_CASES) {
      it(`adds legacy sentinel prefix and metadata for "${kind}"`, () => {
        const error = createRoutedError(kind, 'raw message');
        const routedError = error as Error & { __agentErrorKind?: AgentErrorKind; __rawMessage?: string };

        expect(error.message).toBe(`${prefix}: raw message`);
        expect(routedError.__agentErrorKind).toBe(kind);
        expect(routedError.__rawMessage).toBe('raw message');
      });
    }

    it('keeps raw message for kinds without a legacy sentinel', () => {
      const error = createRoutedError('auth', 'auth failed');
      const routedError = error as Error & { __agentErrorKind?: AgentErrorKind; __rawMessage?: string };

      expect(error.message).toBe('auth failed');
      expect(routedError.__agentErrorKind).toBe('auth');
      expect(routedError.__rawMessage).toBe('auth failed');
    });
  });

  describe('getErrorKind', () => {
    for (const [message, expectedKind] of LEGACY_SENTINEL_CASES) {
      it(`maps "${message.split(':')[0]}" to "${expectedKind}"`, () => {
        expect(getErrorKind(new Error(message))).toBe(expectedKind);
      });
    }

    it('prefers __agentErrorKind metadata over legacy sentinel message', () => {
      const error = new Error('RATE_LIMIT_RETRY: keep old format') as Error & {
        __agentErrorKind: AgentErrorKind;
      };
      error.__agentErrorKind = 'server_error';

      expect(getErrorKind(error)).toBe('server_error');
    });

    it('reads __agentErrorKind from non-Error objects', () => {
      expect(getErrorKind({ __agentErrorKind: 'billing' })).toBe('billing');
    });

    it("recognises 'routing' as a valid AgentErrorKind via metadata", () => {
      // F2 (plan 260422_routing_followups_mock_and_kind): 'routing' is a
      // first-class kind stamped by createDirectAnthropicClient's R2 assertion
      // and the rebelCoreQuery DiD guard. Before F2, the routing assertion
      // stamped 'invalid_request' with a __routingCause side-channel because
      // 'routing' wasn't in AGENT_ERROR_KINDS.
      const routingError = new Error('proxy-dialect leaked') as Error & {
        __agentErrorKind?: AgentErrorKind;
        __routingCause?: string;
      };
      routingError.__agentErrorKind = 'routing';
      routingError.__routingCause = 'proxy-dialect-in-direct-anthropic';
      expect(getErrorKind(routingError)).toBe('routing');
      expect(isRoutedError(routingError)).toBe(true);
    });

    it('returns unknown when metadata kind is invalid', () => {
      const invalidMetadataError = {
        __agentErrorKind: 'not-a-real-kind',
        message: 'RATE_LIMIT',
      };

      expect(getErrorKind(invalidMetadataError)).toBe('unknown');
    });

    it('returns unknown when there is no known sentinel or metadata', () => {
      expect(getErrorKind(new Error('Totally different error'))).toBe('unknown');
      expect(getErrorKind('RATE_LIMIT_RETRY: not an Error object')).toBe('unknown');
      expect(getErrorKind(null)).toBe('unknown');
    });
  });

  describe('isRoutedError', () => {
    it('returns true for legacy sentinel errors', () => {
      expect(isRoutedError(new Error('SERVER_ERROR_RETRY: temporary issue'))).toBe(true);
    });

    it('returns true for metadata-routed errors', () => {
      expect(isRoutedError({ __agentErrorKind: 'mcp_error' })).toBe(true);
    });

    it('returns false for unknown errors', () => {
      expect(isRoutedError(new Error('Unhandled random issue'))).toBe(false);
    });
  });
});

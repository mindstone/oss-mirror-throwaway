import { describe, it, expect } from 'vitest';
import { isConnectionFullyDisabled } from '../useUnifiedConnections';
import type { UnifiedConnection } from '../useUnifiedConnections';

function makeConnection(overrides: Partial<UnifiedConnection> = {}): UnifiedConnection {
  return {
    id: 'test-connection',
    name: 'Test',
    description: 'Test connector',
    icon: 'plug',
    status: 'connected',
    provider: 'bundled',
    ...overrides,
  };
}

describe('isConnectionFullyDisabled', () => {
  describe('single-instance connectors (no instances array)', () => {
    it('returns false when serverPreview is undefined', () => {
      expect(isConnectionFullyDisabled(makeConnection())).toBe(false);
    });

    it('returns false when serverPreview.disabled is undefined', () => {
      const conn = makeConnection({
        serverPreview: { name: 'test', health: 'ok' } as UnifiedConnection['serverPreview'],
      });
      expect(isConnectionFullyDisabled(conn)).toBe(false);
    });

    it('returns false when serverPreview.disabled is false', () => {
      const conn = makeConnection({
        serverPreview: { name: 'test', disabled: false } as UnifiedConnection['serverPreview'],
      });
      expect(isConnectionFullyDisabled(conn)).toBe(false);
    });

    it('returns true when serverPreview.disabled is true', () => {
      const conn = makeConnection({
        serverPreview: { name: 'test', disabled: true } as UnifiedConnection['serverPreview'],
      });
      expect(isConnectionFullyDisabled(conn)).toBe(true);
    });
  });

  describe('multi-instance connectors', () => {
    it('returns false when all instances are active', () => {
      const conn = makeConnection({
        instances: [
          { serverName: 'Notion-a', label: '[external-email]', disabled: false },
          { serverName: 'Notion-b', label: '[external-email]', disabled: false },
        ],
      });
      expect(isConnectionFullyDisabled(conn)).toBe(false);
    });

    it('returns false when some instances are disabled (partial)', () => {
      const conn = makeConnection({
        instances: [
          { serverName: 'Notion-a', label: '[external-email]', disabled: true },
          { serverName: 'Notion-b', label: '[external-email]', disabled: false },
        ],
      });
      expect(isConnectionFullyDisabled(conn)).toBe(false);
    });

    it('returns true when all instances are disabled', () => {
      const conn = makeConnection({
        instances: [
          { serverName: 'Notion-a', label: '[external-email]', disabled: true },
          { serverName: 'Notion-b', label: '[external-email]', disabled: true },
        ],
      });
      expect(isConnectionFullyDisabled(conn)).toBe(true);
    });

    it('returns true for a single disabled instance', () => {
      const conn = makeConnection({
        instances: [
          { serverName: 'Notion-a', label: '[external-email]', disabled: true },
        ],
      });
      expect(isConnectionFullyDisabled(conn)).toBe(true);
    });

    it('returns false when disabled is undefined on instances', () => {
      const conn = makeConnection({
        instances: [
          { serverName: 'Notion-a', label: '[external-email]' },
          { serverName: 'Notion-b', label: '[external-email]' },
        ],
      });
      expect(isConnectionFullyDisabled(conn)).toBe(false);
    });

    it('returns false when instances array is empty (falls through to serverPreview)', () => {
      const conn = makeConnection({
        instances: [],
        serverPreview: { name: 'test', disabled: false } as UnifiedConnection['serverPreview'],
      });
      expect(isConnectionFullyDisabled(conn)).toBe(false);
    });

    it('returns true when instances array is empty and serverPreview is disabled', () => {
      const conn = makeConnection({
        instances: [],
        serverPreview: { name: 'test', disabled: true } as UnifiedConnection['serverPreview'],
      });
      expect(isConnectionFullyDisabled(conn)).toBe(true);
    });

    it('ignores serverPreview when instances are present', () => {
      const conn = makeConnection({
        instances: [
          { serverName: 'Notion-a', label: '[external-email]', disabled: false },
        ],
        serverPreview: { name: 'test', disabled: true } as UnifiedConnection['serverPreview'],
      });
      expect(isConnectionFullyDisabled(conn)).toBe(false);
    });
  });
});

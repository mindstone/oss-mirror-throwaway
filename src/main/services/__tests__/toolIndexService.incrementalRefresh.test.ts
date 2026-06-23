import { describe, expect, it } from 'vitest';
import {
  computePackageHash,
  detectPackageChanges,
  getParamNames,
} from '../toolIndexService';

type ToolFixture = {
  tool_id: string;
  name: string;
  description: string;
  summary?: string;
  package_name: string;
  input_schema?: unknown;
};

function makeTool(overrides: Partial<ToolFixture> = {}): ToolFixture {
  return {
    tool_id: 'slack__post_message',
    name: 'post_message',
    description: 'Post a message to a channel',
    package_name: 'Slack',
    input_schema: {
      properties: {
        channel: { type: 'string' },
        text: { type: 'string' },
      },
    },
    ...overrides,
  };
}

describe('toolIndexService incremental refresh helpers', () => {
  describe('getParamNames', () => {
    it('sorts parameter names for deterministic hashing', () => {
      expect(getParamNames({
        properties: {
          zeta: { type: 'string' },
          alpha: { type: 'string' },
          beta: { type: 'string' },
        },
      })).toBe('alpha beta zeta');
    });
  });

  describe('computePackageHash', () => {
    it('produces deterministic hashes for identical input', () => {
      const tools = [makeTool(), makeTool({
        tool_id: 'slack__archive_channel',
        name: 'archive_channel',
        description: 'Archive a channel',
      })];

      expect(computePackageHash(tools)).toBe(computePackageHash(tools));
    });

    it('produces different hashes when tool content changes', () => {
      const original = [makeTool()];
      const changed = [makeTool({ description: 'Post a broadcast message to a channel' })];

      expect(computePackageHash(changed)).not.toBe(computePackageHash(original));
    });

    it('ignores tool ordering', () => {
      const first = makeTool();
      const second = makeTool({
        tool_id: 'slack__list_channels',
        name: 'list_channels',
        description: 'List available channels',
      });

      expect(computePackageHash([first, second])).toBe(computePackageHash([second, first]));
    });

    it('includes tool id so renames are detected', () => {
      const original = [makeTool()];
      const renamed = [makeTool({ tool_id: 'slack__publish_message' })];

      expect(computePackageHash(renamed)).not.toBe(computePackageHash(original));
    });

    it('produces a deterministic hash for an empty tool array', () => {
      const hash1 = computePackageHash([]);
      const hash2 = computePackageHash([]);
      expect(hash1).toBe(hash2);
      expect(hash1.length).toBeGreaterThan(0);
    });
  });

  describe('detectPackageChanges', () => {
    it('detects added packages', () => {
      const changes = detectPackageChanges(
        new Map([['slack-server', 'hash-a']]),
        new Map([
          ['slack-server', 'hash-a'],
          ['gmail-server', 'hash-b'],
        ]),
      );

      expect(changes.addedPackages).toEqual(['gmail-server']);
      expect(changes.modifiedPackages).toEqual([]);
      expect(changes.removedPackages).toEqual([]);
      expect(changes.unchangedPackages).toEqual(['slack-server']);
    });

    it('detects modified packages', () => {
      const changes = detectPackageChanges(
        new Map([['slack-server', 'hash-a']]),
        new Map([['slack-server', 'hash-b']]),
      );

      expect(changes.addedPackages).toEqual([]);
      expect(changes.modifiedPackages).toEqual(['slack-server']);
      expect(changes.removedPackages).toEqual([]);
      expect(changes.unchangedPackages).toEqual([]);
    });

    it('detects removed packages', () => {
      const changes = detectPackageChanges(
        new Map([
          ['slack-server', 'hash-a'],
          ['gmail-server', 'hash-b'],
        ]),
        new Map([['slack-server', 'hash-a']]),
      );

      expect(changes.addedPackages).toEqual([]);
      expect(changes.modifiedPackages).toEqual([]);
      expect(changes.removedPackages).toEqual(['gmail-server']);
      expect(changes.unchangedPackages).toEqual(['slack-server']);
    });

    it('skips unchanged packages', () => {
      const changes = detectPackageChanges(
        new Map([
          ['slack-server', 'hash-a'],
          ['gmail-server', 'hash-b'],
        ]),
        new Map([
          ['slack-server', 'hash-a'],
          ['gmail-server', 'hash-b'],
        ]),
      );

      expect(changes.addedPackages).toEqual([]);
      expect(changes.modifiedPackages).toEqual([]);
      expect(changes.removedPackages).toEqual([]);
      expect(changes.unchangedPackages).toEqual(['slack-server', 'gmail-server']);
    });

    it('returns all-empty arrays when both maps are empty', () => {
      const changes = detectPackageChanges(new Map(), new Map());
      expect(changes).toEqual({
        addedPackages: [],
        modifiedPackages: [],
        removedPackages: [],
        unchangedPackages: [],
      });
    });

    it('handles mixed added, modified, removed, and unchanged packages', () => {
      const changes = detectPackageChanges(
        new Map([
          ['unchanged-server', 'hash-same'],
          ['modified-server', 'hash-old'],
          ['removed-server', 'hash-remove'],
        ]),
        new Map([
          ['unchanged-server', 'hash-same'],
          ['modified-server', 'hash-new'],
          ['added-server', 'hash-add'],
        ]),
      );

      expect(changes).toEqual({
        addedPackages: ['added-server'],
        modifiedPackages: ['modified-server'],
        removedPackages: ['removed-server'],
        unchangedPackages: ['unchanged-server'],
      });
    });
  });
});

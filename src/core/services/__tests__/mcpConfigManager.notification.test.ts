/**
 * Tests for mcpConfigManager config change notification mechanism.
 *
 * Validates that `onMcpConfigChanged()` listeners fire after any config
 * mutation through `writeConfig()`, and that the unsubscribe function,
 * error isolation, and multiple-listener patterns work correctly.
 *
 * Uses real file I/O (temp directory) because `writeConfig()` is the
 * actual function that triggers notifications — mocking it would defeat
 * the purpose.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  upsertMcpServerEntry,
  removeMcpServerEntry,
  setMcpToolEnabled,
  setMcpServerDisabled,
  onMcpConfigChanged,
} from '../mcpConfigManager';

describe('onMcpConfigChanged', () => {
  let tempDir: string;
  let configPath: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-mcp-notify-test-'));
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  beforeEach(async () => {
    // Create fresh config for each test
    configPath = path.join(tempDir, `config-${Date.now()}.json`);
    const baseConfig = {
      configPaths: [],
      mcpServers: {
        'test-server-1': { command: 'node', args: ['server1.js'] },
        'test-server-2': { command: 'node', args: ['server2.js'] },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(baseConfig, null, 2), 'utf8');
  });

  it('listener fires after upsertMcpServerEntry', async () => {
    const listener = vi.fn();
    const unsubscribe = onMcpConfigChanged(listener);

    try {
      await upsertMcpServerEntry(configPath, {
        name: 'new-server',
        command: 'node',
        args: ['new.js'],
      });

      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it('listener fires after removeMcpServerEntry', async () => {
    const listener = vi.fn();
    const unsubscribe = onMcpConfigChanged(listener);

    try {
      await removeMcpServerEntry(configPath, 'test-server-1');

      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it('listener fires after setMcpToolEnabled', async () => {
    const listener = vi.fn();
    const unsubscribe = onMcpConfigChanged(listener);

    try {
      await setMcpToolEnabled(configPath, 'test-server-1', 'some-tool', false);

      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it('listener fires after setMcpServerDisabled', async () => {
    const listener = vi.fn();
    const unsubscribe = onMcpConfigChanged(listener);

    try {
      await setMcpServerDisabled(configPath, 'test-server-1', true);

      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it('unsubscribe prevents further notifications', async () => {
    const listener = vi.fn();
    const unsubscribe = onMcpConfigChanged(listener);

    // First mutation — should fire
    await upsertMcpServerEntry(configPath, {
      name: 'first',
      command: 'node',
      args: ['first.js'],
    });
    expect(listener).toHaveBeenCalledTimes(1);

    // Unsubscribe
    unsubscribe();

    // Second mutation — should NOT fire
    await upsertMcpServerEntry(configPath, {
      name: 'second',
      command: 'node',
      args: ['second.js'],
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('listener errors are caught and do not propagate to caller', async () => {
    const errorListener = vi.fn(() => {
      throw new Error('listener boom');
    });
    const unsubscribe = onMcpConfigChanged(errorListener);

    try {
      // Should not throw even though the listener throws
      await expect(
        upsertMcpServerEntry(configPath, {
          name: 'safe-write',
          command: 'node',
          args: ['safe.js'],
        })
      ).resolves.toBeDefined();

      // Listener was still called (error was caught internally)
      expect(errorListener).toHaveBeenCalledTimes(1);

      // Config was actually written despite the listener error
      const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
      expect(config.mcpServers['safe-write']).toBeDefined();
    } finally {
      unsubscribe();
    }
  });

  it('failed write (e.g. invalid config path) does NOT fire notification', async () => {
    const listener = vi.fn();
    const unsubscribe = onMcpConfigChanged(listener);

    try {
      // Attempting to upsert without a name should throw before writeConfig is called
      await expect(
        upsertMcpServerEntry(configPath, {
          name: '',
          command: 'node',
          args: ['fail.js'],
        })
      ).rejects.toThrow();

      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('multiple listeners all fire', async () => {
    const listener1 = vi.fn();
    const listener2 = vi.fn();
    const listener3 = vi.fn();
    const unsub1 = onMcpConfigChanged(listener1);
    const unsub2 = onMcpConfigChanged(listener2);
    const unsub3 = onMcpConfigChanged(listener3);

    try {
      await upsertMcpServerEntry(configPath, {
        name: 'multi-listener',
        command: 'node',
        args: ['multi.js'],
      });

      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);
      expect(listener3).toHaveBeenCalledTimes(1);
    } finally {
      unsub1();
      unsub2();
      unsub3();
    }
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

describe('settingsStore file permissions', () => {
  let tmpDir: string;
  let settingsPath: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rebel-settings-perms-'));
    settingsPath = path.join(tmpDir, 'app-settings.json');
    vi.resetModules();
    vi.doMock('electron-store', () => ({
      default: class MockStore {
        public readonly path = settingsPath;
        private readonly configFileMode?: number;
        private data: Record<string, unknown>;

        constructor(options?: { defaults?: Record<string, unknown>; configFileMode?: number }) {
          this.configFileMode = options?.configFileMode;
          this.data = options?.defaults ? JSON.parse(JSON.stringify(options.defaults)) : {};
        }

        get store(): Record<string, unknown> {
          return JSON.parse(JSON.stringify(this.data));
        }

        set store(value: Record<string, unknown>) {
          this.data = JSON.parse(JSON.stringify(value));
          fs.writeFileSync(this.path, JSON.stringify(this.data, null, 2), {
            encoding: 'utf8',
            mode: this.configFileMode ?? 0o666,
          });
        }

        set(key: string, value: unknown): void {
          this.data[key] = value;
          this.store = this.data;
        }

        get(key: string): unknown {
          return this.data[key];
        }

        delete(key: string): void {
          delete this.data[key];
          this.store = this.data;
        }

        clear(): void {
          this.data = {};
          this.store = this.data;
        }
      },
    }));
  });

  afterEach(async () => {
    vi.doUnmock('electron-store');
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes app-settings.json with 0600 permissions', async () => {
    const { settingsStore, DEFAULT_SETTINGS } = await import('../settingsStore/index');

    settingsStore.store = {
      ...DEFAULT_SETTINGS,
      providerKeys: { openai: 'fake-secret' },
    };

    if (process.platform !== 'win32') {
      expect((fs.statSync(settingsPath).mode & 0o777)).toBe(0o600);
    }
  });
});

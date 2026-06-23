import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BOOT_TOKEN_FILE_MODE,
  BOOT_TOKEN_FILENAME,
  parseBootTokenFile,
  readBootTokenFile,
  writeBootTokenFile,
  type BootTokenFile,
} from '../bootToken';

const cleanupDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'rebel-boot-token-'));
  cleanupDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

function createBootToken(): BootTokenFile {
  return {
    schemaVersion: 1,
    routerToken: 'router-token-123',
    bridgeOrigin: 'http://127.0.0.1:52320',
    port: 52320,
    startedAt: '2026-04-23T12:34:56.000Z',
    installSessionId: 'inst_123456',
  };
}

describe('bootToken', () => {
  it('writes the expected JSON shape with a trailing newline', async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, BOOT_TOKEN_FILENAME);
    const token = createBootToken();

    await writeBootTokenFile(fs, filePath, token);

    const raw = await fs.readFile(filePath, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(parseBootTokenFile(raw)).toEqual(token);
  });

  it('writes the file with mode 0o600', async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, BOOT_TOKEN_FILENAME);

    await writeBootTokenFile(fs, filePath, createBootToken());

    const stat = await fs.stat(filePath);
    expect(stat.mode & 0o777).toBe(BOOT_TOKEN_FILE_MODE);
  });

  it('rejects malformed JSON on read', async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, BOOT_TOKEN_FILENAME);
    await fs.writeFile(filePath, '{not-valid-json', 'utf8');

    await expect(readBootTokenFile((pathToRead, encoding) => fs.readFile(pathToRead, encoding), filePath)).rejects.toThrow(
      'Invalid Rebel boot token JSON',
    );
  });

  it('rejects invalid shapes on read', async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, BOOT_TOKEN_FILENAME);
    await fs.writeFile(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        routerToken: 'router-token-123',
        bridgeOrigin: 'http://127.0.0.1:52320',
        port: '52320',
        startedAt: '2026-04-23T12:34:56.000Z',
        installSessionId: 'inst_123456',
      }),
      'utf8',
    );

    await expect(readBootTokenFile((pathToRead, encoding) => fs.readFile(pathToRead, encoding), filePath)).rejects.toThrow(
      'Invalid Rebel boot token shape.',
    );
  });
});

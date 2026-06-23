import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkDirectSessionPuts, SCAN_ROOTS } from '../check-direct-session-puts';

let tmpDir: string | null = null;

function writeFixture(relativePath: string, source: string): void {
  if (!tmpDir) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-session-put-'));
  }
  const fullPath = path.join(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, source, 'utf8');
}

describe('check-direct-session-puts', () => {
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it('allows client.put inside pushFullSessionWithCapabilityGate', () => {
    writeFixture('src/main/allowed.ts', `
      export async function pushFullSessionWithCapabilityGate(client: { put(path: string, body: unknown): Promise<unknown> }) {
        return client.put('/api/sessions/s1', {});
      }
    `);

    expect(checkDirectSessionPuts({ rootDir: tmpDir! })).toEqual([]);
  });

  it('rejects client.put outside the funnel', () => {
    writeFixture('src/main/bad.ts', `
      export async function bad(client: { put(path: string, body: unknown): Promise<unknown> }) {
        return client.put('/api/sessions/s1', {});
      }
    `);

    expect(checkDirectSessionPuts({ rootDir: tmpDir! })).toEqual([
      expect.objectContaining({ file: path.join('src/main/bad.ts') }),
    ]);
  });

  it('rejects request PUT calls outside explicit allow comments', () => {
    writeFixture('cloud-client/src/bad.ts', `
      async function request(method: string, path: string, body: unknown) { return { method, path, body }; }
      export async function bad() {
        return request('PUT', '/api/sessions/s1', {});
      }
    `);

    expect(checkDirectSessionPuts({ rootDir: tmpDir! })[0]).toMatchObject({
      file: path.join('cloud-client/src/bad.ts'),
    });
  });

  it('allows explicitly commented direct PUTs', () => {
    writeFixture('src/main/migration.ts', `
      export async function migrate(client: { put(path: string, body: unknown): Promise<unknown> }) {
        /* direct-session-put -- migration bootstrap */
        return client.put('/api/sessions/s1', {});
      }
    `);

    expect(checkDirectSessionPuts({ rootDir: tmpDir! })).toEqual([]);
  });

  it('scans all required roots', () => {
    expect(SCAN_ROOTS).toEqual([
      'src/main',
      'cloud-client/src',
      'cloud-service/src',
      'mobile/src',
      'mobile/app',
      'web-companion/src',
    ]);
  });

  it.each(SCAN_ROOTS)('reports a planted violation under %s', (root) => {
    writeFixture(`${root}/bad.ts`, `
      export async function bad(client: { put(path: string, body: unknown): Promise<unknown> }) {
        return client.put(\`/api/sessions/\${'s1'}\`, {});
      }
    `);

    expect(checkDirectSessionPuts({ rootDir: tmpDir! })).toEqual([
      expect.objectContaining({ file: path.join(root, 'bad.ts') }),
    ]);
  });
});

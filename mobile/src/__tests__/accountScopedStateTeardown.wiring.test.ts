import fs from 'node:fs';
import path from 'node:path';

const mobileRoot = path.resolve(__dirname, '../..');

function readRepoFile(repoPath: string): string {
  return fs.readFileSync(path.join(mobileRoot, repoPath), 'utf8');
}

describe('account-scoped teardown wiring', () => {
  it('routes root unauthorized cleanup and Help disconnect through wipeAllAccountScopedState', () => {
    const layoutSource = readRepoFile('app/_layout.tsx');
    const helpSource = readRepoFile('app/(tabs)/help.tsx');

    expect(layoutSource).toContain("import { wipeAllAccountScopedState } from '../src/services/accountScopedStateTeardown';");
    expect(layoutSource).toContain('reason: \'unauthorized\'');
    expect(layoutSource).toContain('clearOfflineQueue: false');
    expect(helpSource).toContain("import { wipeAllAccountScopedState } from '../../src/services/accountScopedStateTeardown';");
    expect(helpSource).toContain('reason: \'explicitDisconnect\'');
    expect(helpSource).toContain('clearOfflineQueue: true');
  });
});

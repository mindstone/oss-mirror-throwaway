import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const jestBin = require.resolve('jest/bin/jest');
const result = spawnSync(
  process.execPath,
  [
    jestBin,
    '--runTestsByPath',
    'src/__tests__/e2e.integration.test.ts',
    '--testPathIgnorePatterns=[]',
    '--testTimeout=120000',
    ...process.argv.slice(2),
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      REBEL_E2E_LIVE: '1',
    },
  },
);

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);

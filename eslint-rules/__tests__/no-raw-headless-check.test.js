import { RuleTester } from 'eslint';
import tsparser from '@typescript-eslint/parser';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rule = require('../no-raw-headless-check.js');

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsparser,
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
});

ruleTester.run('no-raw-headless-check', rule, {
  valid: [
    {
      name: 'calling the SSOT is fine',
      code: `if (isHeadlessCli()) { skip(); }`,
    },
    {
      name: 'SETTING the env var (assignment) is allowed — that is how the CLI binary marks itself',
      code: `process.env.REBEL_HEADLESS_CLI = '1';`,
    },
    {
      name: 'SETTING via bracket access is allowed too',
      code: `process.env['REBEL_HEADLESS_CLI'] = '1';`,
    },
    {
      name: 'a different env var is not flagged',
      code: `if (process.env.REBEL_HEADLESS === '1') { evalOrchestrator(); }`,
    },
    {
      name: 'a different flag is not flagged',
      code: `if (process.argv.includes('--rebel-test')) { rebelTest(); }`,
    },
    {
      name: 'a different switch is not flagged',
      code: `if (app.commandLine.hasSwitch('disable-gpu')) { noGpu(); }`,
    },
    {
      name: 'filtering the flag out of argv (a !== compare, not .includes) is not flagged',
      code: `const cleaned = argv.filter((a) => a !== '--headless-cli');`,
    },
  ],
  invalid: [
    {
      name: 'reading the env via === comparison is flagged',
      code: `if (process.env.REBEL_HEADLESS_CLI === '1') { skip(); }`,
      errors: [{ messageId: 'noRawHeadlessCheck' }],
    },
    {
      name: 'a bare truthy read of the env var is flagged',
      code: `const headless = Boolean(process.env.REBEL_HEADLESS_CLI);`,
      errors: [{ messageId: 'noRawHeadlessCheck' }],
    },
    {
      name: 'reading the env via bracket access is flagged (the computed-access bypass)',
      code: `if (process.env['REBEL_HEADLESS_CLI'] === '1') { skip(); }`,
      errors: [{ messageId: 'noRawHeadlessCheck' }],
    },
    {
      name: 'argv.includes the bare flag is flagged',
      code: `if (process.argv.includes('--headless-cli')) { skip(); }`,
      errors: [{ messageId: 'noRawHeadlessCheck' }],
    },
    {
      name: 'the retired commandLine.hasSwitch belt is flagged',
      code: `if (app.commandLine.hasSwitch('headless-cli')) { skip(); }`,
      errors: [{ messageId: 'noRawHeadlessCheck' }],
    },
    {
      name: 'the classic full re-inline (env || argv) flags both halves',
      code: `const h = process.env.REBEL_HEADLESS_CLI === '1' || process.argv.includes('--headless-cli');`,
      errors: [{ messageId: 'noRawHeadlessCheck' }, { messageId: 'noRawHeadlessCheck' }],
    },
  ],
});

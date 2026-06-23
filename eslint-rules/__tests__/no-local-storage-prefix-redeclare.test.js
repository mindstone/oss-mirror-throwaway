import { RuleTester } from 'eslint';
import tsparser from '@typescript-eslint/parser';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rule = require('../no-local-storage-prefix-redeclare.js');

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsparser,
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
});

const canonicalHome = 'src/shared/utils/btsModelValueNormalization.ts';
const productionFile = 'src/renderer/features/settings/components/models/ModelChoicePicker.tsx';

ruleTester.run('no-local-storage-prefix-redeclare', rule, {
  valid: [
    {
      name: 'allows the canonical declarations in the canonical home',
      filename: canonicalHome,
      code: "export const PROFILE_PREFIX = 'profile:';\nexport const MODEL_PREFIX = 'model:';",
    },
    {
      name: 'allows importing the constant from the canonical re-export',
      filename: productionFile,
      code: "import { PROFILE_PREFIX } from '@shared/utils/modelChoiceCodec';",
    },
    {
      name: 'leaves the unrelated sub-agent label prefix (model-) alone',
      filename: 'src/renderer/features/agent-session/utils/modelAgentLabels.ts',
      code: "const MODEL_PREFIX = 'model-';",
    },
    {
      name: 'leaves an unrelated council label prefix alone',
      filename: productionFile,
      code: "const COUNCIL_PREFIX = 'council-';",
    },
    {
      name: 'does not fire on a same-name const with a non-storage value',
      filename: productionFile,
      code: "const PROFILE_PREFIX = 'profiles/';",
    },
    {
      name: 'allows the documented WS0 LEFT slash/claude gates (not a prefix const)',
      filename: 'src/shared/utils/settingsUtils.ts',
      code: "const isSlash = model.includes('/');\nconst isClaude = model.startsWith('claude-');",
    },
  ],
  invalid: [
    {
      name: 'flags a re-declared PROFILE_PREFIX storage const (the WS0-removed shape)',
      filename: productionFile,
      code: "const PROFILE_PREFIX = 'profile:';",
      errors: [{ messageId: 'noLocalRedeclare' }],
    },
    {
      name: 'flags a re-declared MODEL_PREFIX storage const',
      filename: 'src/core/services/someService.ts',
      code: "const MODEL_PREFIX = 'model:';",
      errors: [{ messageId: 'noLocalRedeclare' }],
    },
    {
      name: 'flags re-declaration via let',
      filename: productionFile,
      code: "let PROFILE_PREFIX = 'profile:';",
      errors: [{ messageId: 'noLocalRedeclare' }],
    },
    {
      name: 'flags re-declaration via var',
      filename: productionFile,
      code: "var MODEL_PREFIX = 'model:';",
      errors: [{ messageId: 'noLocalRedeclare' }],
    },
    {
      name: 'flags re-declaration inside a function scope',
      filename: productionFile,
      code: "function f() { const PROFILE_PREFIX = 'profile:'; return PROFILE_PREFIX; }",
      errors: [{ messageId: 'noLocalRedeclare' }],
    },
  ],
});

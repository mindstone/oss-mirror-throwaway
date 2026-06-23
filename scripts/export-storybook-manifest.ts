#!/usr/bin/env npx tsx

import * as fs from 'node:fs';
import * as path from 'node:path';
import { storybookManifest } from '../src/renderer/components/ui/storybookManifest';
import {
  PROJECT_ROOT,
  STORY_DIR,
  collectStoryTitles,
  formatIssues,
  validateManifestContract,
} from './storybookManifestContract';

const OUTPUT_JSON = path.join(
  PROJECT_ROOT,
  'src',
  'renderer',
  'components',
  'ui',
  'manifests',
  'storybook_component_manifest.json',
);

const stories = collectStoryTitles(STORY_DIR);
const issues = validateManifestContract({
  manifest: storybookManifest,
  stories,
  projectRoot: PROJECT_ROOT,
});

if (issues.length > 0) {
  console.error('Storybook manifest contract validation failed:');
  console.error(formatIssues(issues));
  console.error(
    '\nFix the manifest, the offending story title, or update the allowlists ' +
      'in scripts/storybookManifestContract.ts (each allowlist entry must name ' +
      'the FOX-3131 stage that will retire it).',
  );
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUTPUT_JSON), { recursive: true });
fs.writeFileSync(
  OUTPUT_JSON,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      families: storybookManifest,
    },
    null,
    2,
  ),
  'utf8',
);

console.log(`Storybook component manifest generated: ${path.relative(PROJECT_ROOT, OUTPUT_JSON)}`);

#!/usr/bin/env npx tsx
/**
 * CI Validation: settingsStore Bootstrap Safety
 *
 * Ensures src/main/settingsStore.ts uses direct `new Store()` (electron-store)
 * for its primary store construction, NOT `createStore()` from @core/storeFactory.
 *
 * settingsStore is imported at the top of src/main/index.ts via ES module
 * hoisting, BEFORE setStoreFactory() runs. Using createStore() there crashes
 * the app with "StoreFactory not initialized".
 *
 * Note: createStore() is allowed inside function bodies (e.g.,
 * detectMeetingBotUsageFromHistory) since those run lazily after bootstrap.
 * This check only flags top-level/module-scope usage.
 *
 * Run: npx tsx scripts/check-settings-store-bootstrap.ts
 * Wired into: npm run validate:fast
 *
 * @see docs-private/postmortems/260330_settings_store_factory_crash_postmortem.md
 */

import * as fs from 'fs';
import * as path from 'path';

const SETTINGS_STORE = path.join(__dirname, '..', 'src', 'main', 'settingsStore.ts');

if (!process.env.VITEST) {
  console.log('Checking settingsStore bootstrap safety...\n');

  const source = fs.readFileSync(SETTINGS_STORE, 'utf8');
  const lines = source.split('\n');

  let depth = 0;
  let inBlockComment = false;
  const violations: { line: number; text: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Track block comments
    if (inBlockComment) {
      const endIdx = line.indexOf('*/');
      if (endIdx !== -1) {
        inBlockComment = false;
        line = line.slice(endIdx + 2);
      } else {
        continue;
      }
    }

    // Strip inline block comments
    while (line.includes('/*')) {
      const startIdx = line.indexOf('/*');
      const endIdx = line.indexOf('*/', startIdx + 2);
      if (endIdx !== -1) {
        line = line.slice(0, startIdx) + line.slice(endIdx + 2);
      } else {
        line = line.slice(0, startIdx);
        inBlockComment = true;
        break;
      }
    }

    // Strip line comments
    const commentIdx = line.indexOf('//');
    if (commentIdx !== -1) {
      line = line.slice(0, commentIdx);
    }

    // Flag module-level (depth 0) createStore() calls BEFORE updating brace depth,
    // so that `createStore<T>({` on a single line is caught at the outer depth.
    if (depth === 0 && /createStore\s*[<(]/.test(line)) {
      violations.push({ line: i + 1, text: lines[i].trim() });
    }

    // Track brace depth to distinguish module-level from function-body code
    for (const ch of line) {
      if (ch === '{') depth++;
      if (ch === '}') depth--;
    }
  }

  if (violations.length > 0) {
    console.error('✗ settingsStore.ts has top-level createStore() usage:\n');
    for (const v of violations) {
      console.error(`  src/main/settingsStore.ts:${v.line}`);
      console.error(`    ${v.text}\n`);
    }
    console.error(
      'settingsStore.ts MUST use direct `new Store()` (electron-store) at module level.\n' +
      'createStore() from @core/storeFactory requires setStoreFactory() to have run first,\n' +
      'but settingsStore is imported before setStoreFactory() in src/main/index.ts.\n\n' +
      'See: docs-private/postmortems/260330_settings_store_factory_crash_postmortem.md',
    );
    process.exit(1);
  } else {
    console.log('✓ settingsStore.ts uses direct electron-store at module level — bootstrap safe');
  }
}

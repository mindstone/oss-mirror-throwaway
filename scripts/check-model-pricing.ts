#!/usr/bin/env npx tsx

import { MODEL_CATALOG } from '../src/shared/data/modelCatalog';

const PRICE_FIELDS = ['input', 'output', 'cacheRead', 'cacheCreation'] as const;

let hasErrors = false;

console.log('Checking model catalog pricing coverage...\n');

for (const entry of MODEL_CATALOG) {
  if (!entry.pricing || typeof entry.pricing !== 'object') {
    console.error(`MISSING: ${entry.id} has no pricing object`);
    hasErrors = true;
    continue;
  }

  for (const field of PRICE_FIELDS) {
    const value = entry.pricing[field];

    if (!Number.isFinite(value)) {
      console.error(`INVALID: ${entry.id} pricing.${field} must be finite, received ${String(value)}`);
      hasErrors = true;
      continue;
    }

    if (value < 0) {
      console.error(`INVALID: ${entry.id} pricing.${field} must be non-negative, received ${value}`);
      hasErrors = true;
    }
  }
}

console.log(`Entries checked: ${MODEL_CATALOG.length}`);

if (hasErrors) {
  console.error('\nFAILED: MODEL_CATALOG contains missing or invalid pricing.');
  process.exit(1);
}

// Second pass: warn (but don't fail) on zero input/output pricing
const WARN_ZERO_FIELDS = ['input', 'output'] as const;
let hasWarnings = false;

for (const entry of MODEL_CATALOG) {
  if (!entry.pricing) continue;
  for (const field of WARN_ZERO_FIELDS) {
    if (entry.pricing[field] === 0) {
      console.warn(`WARNING: ${entry.id} pricing.${field} is zero — is this intentional?`);
      hasWarnings = true;
    }
  }
}

if (hasWarnings) {
  console.warn('\nNote: Zero pricing values were detected. These are allowed but unusual for commercial models.');
}

console.log('\nPASSED: Every MODEL_CATALOG entry has finite, non-negative pricing.');

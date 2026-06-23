import { describe, expect, it } from 'vitest';
import { USE_CASE_JSON_SCHEMA } from '../useCaseGeneratorService';

/**
 * Regression guard for REBEL-66V / FOX-3478.
 *
 * The use-case schema is sent verbatim to Anthropic's structured-outputs beta
 * (`output_config.format.schema`). Anthropic rejects `maxItems` on array fields
 * with a 400 ("property 'maxItems' is not supported"), which made every
 * Workflow/Use-Case Refresh run fail. The exact count is enforced via the
 * prompt instead, so `maxItems` must never reappear anywhere in this schema.
 */
function collectKeys(node: unknown, found: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectKeys(item, found);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      found.add(key);
      collectKeys(value, found);
    }
  }
}

describe('USE_CASE_JSON_SCHEMA — Anthropic structured-output compatibility', () => {
  it('contains no maxItems anywhere (rejected by Anthropic structured outputs)', () => {
    const keys = new Set<string>();
    collectKeys(USE_CASE_JSON_SCHEMA, keys);
    expect(keys.has('maxItems')).toBe(false);
  });
});

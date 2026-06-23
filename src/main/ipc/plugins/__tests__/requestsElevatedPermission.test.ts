import { describe, it, expect } from 'vitest';
import { requestsElevatedPermission } from '../shared';

// Stage 3A security-review gate classifier.
// See docs/plans/260527_plugin_agent_experience_overhaul.md — Stage 3A.
describe('requestsElevatedPermission', () => {
  it('returns false for undefined (legacy plugins inherit standard read defaults)', () => {
    expect(requestsElevatedPermission(undefined)).toBe(false);
  });

  it('returns false for an empty permission set', () => {
    expect(requestsElevatedPermission([])).toBe(false);
  });

  it('returns false when only standard read permissions are requested', () => {
    expect(
      requestsElevatedPermission([
        'conversations:read',
        'memory:read',
        'skills:read',
        'entities:read',
      ]),
    ).toBe(false);
  });

  it('returns true for external-fetch', () => {
    expect(requestsElevatedPermission(['external-fetch'])).toBe(true);
  });

  it('returns true for conversations:write', () => {
    expect(requestsElevatedPermission(['conversations:write'])).toBe(true);
  });

  it('returns true for conversations:transcript', () => {
    expect(requestsElevatedPermission(['conversations:transcript'])).toBe(true);
  });

  it('returns true for skills:write', () => {
    expect(requestsElevatedPermission(['skills:write'])).toBe(true);
  });

  it('returns true for automations:create', () => {
    expect(requestsElevatedPermission(['automations:create'])).toBe(true);
  });

  it('returns true when an elevated permission is mixed in with standard reads', () => {
    expect(
      requestsElevatedPermission(['conversations:read', 'memory:read', 'external-fetch']),
    ).toBe(true);
  });

  it('returns true for an unknown/forward-compatible permission string (fail-elevated)', () => {
    // Anything not explicitly in the standard read set is treated as elevated —
    // a new permission added later defaults to requiring review, which is the
    // safe direction.
    expect(requestsElevatedPermission(['some:future-permission'])).toBe(true);
  });
});

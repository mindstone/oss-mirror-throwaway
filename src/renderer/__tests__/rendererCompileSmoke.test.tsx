import { describe, it, expect } from 'vitest';
import { SettingsSurface } from '@renderer/features/settings/components/SettingsSurface';
// Smoke test for the @rebel/cloud-client alias (added in Stage 0 of
// docs/plans/260416_centralize_approval_and_diff_viewing_ux.md). Proves the
// renderer process can resolve and load cloud-client modules end-to-end.
import type { ApprovalTransport } from '@rebel/cloud-client';
import { isConfigured } from '@rebel/cloud-client';

describe('renderer compile smoke', () => {
  it('can import SettingsSurface without crashing', () => {
    expect(typeof SettingsSurface).toBe('function');
  });

  it('can import from @rebel/cloud-client', () => {
    expect(typeof isConfigured).toBe('function');
    // TypeScript type-level check (compiles if the type is present).
    const _check: ApprovalTransport | undefined = undefined;
    expect(_check).toBeUndefined();
  });
});

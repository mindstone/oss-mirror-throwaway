import { describe, expect, it, vi } from 'vitest';

import {
  buildDashboardSeedDraft,
  dashboardShareErrorCopy,
  redeemDashboardShareToken,
} from '../seedChatFromDashboard';

describe('seedChatFromDashboard', () => {
  it('builds a seeded draft with source context and table rows', () => {
    const draft = buildDashboardSeedDraft({
      version: 1,
      source: {
        tableId: 'inactive-users',
        organizationId: 'org-1',
        organizationName: 'Test Company',
        windowDays: 30,
        snapshotAt: '2026-05-28T10:00:00.000Z',
      },
      rows: [
        { email: 'inactive@example.com', name: 'Inactive User', totalEvents: 0 },
      ],
      starterPrompt: 'Help me draft thoughtful outreach.',
      mcpHints: { scopedToolHint: 'Use list_inactive_users.' },
    });

    expect(draft).toContain('Help me draft thoughtful outreach.');
    expect(draft).toContain('Company: Test Company');
    expect(draft).toContain('| email | name | totalEvents |');
    expect(draft).toContain('inactive@example.com');
    expect(draft).toContain(
      'Dashboard follow-up available when the matching key is configured: Use list_inactive_users.',
    );
  });

  it('maps forbidden-scope errors to fail-closed copy', () => {
    expect(dashboardShareErrorCopy('FORBIDDEN_SCOPE')).toEqual({
      title: "Can't open that dashboard context",
      description: 'It belongs to a different account or you no longer have access.',
    });
  });

  it('maps missing and unsupported payload versions to typed recovery copy', () => {
    expect(dashboardShareErrorCopy('TOKEN_NOT_FOUND').title).toBe("Couldn't find that dashboard context");
    expect(dashboardShareErrorCopy('UNSUPPORTED_PAYLOAD_VERSION').title).toBe(
      'Update Rebel to open this dashboard context',
    );
  });

  it('includes a scoped MCP key nudge in the seeded draft', () => {
    const draft = buildDashboardSeedDraft({
      version: 1,
      source: {
        tableId: 'active-users',
        organizationId: 'org-1',
        organizationName: 'Test Company',
        windowDays: 30,
        snapshotAt: '2026-05-28T10:00:00.000Z',
      },
      rows: [{ email: 'active@example.com' }],
      starterPrompt: 'Help me understand these users.',
    });

    expect(draft).toContain('matching Rebel Platform MCP key');
    expect(draft).toContain('Test Company');
  });

  it('redeems through the dashboard IPC bridge', async () => {
    const redeemShareToken = vi.fn().mockResolvedValue({ success: false, errorCode: 'TOKEN_EXPIRED', message: 'expired' });
    vi.stubGlobal('window', {
      dashboardApi: { redeemShareToken },
    });

    await expect(redeemDashboardShareToken('abc')).resolves.toEqual({
      success: false,
      errorCode: 'TOKEN_EXPIRED',
      message: 'expired',
    });
    expect(redeemShareToken).toHaveBeenCalledWith({ token: 'abc' });
  });
});

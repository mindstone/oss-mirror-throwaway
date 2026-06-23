import { describe, expect, it } from 'vitest';
import {
  buildAnalyticsAttributionProperties,
  buildDesktopAnalyticsContext,
  extractMcpServer,
  hashSessionId,
  sanitizeServerIdForAnalytics,
} from '../trackingTypes';

describe('extractMcpServer', () => {
  // Direct HTTP MCP format: mcp__server__tool
  it.each([
    ['mcp__notion__search_pages', 'notion'],
    ['mcp__linear__search_issues', 'linear'],
    ['mcp__github__search_repos', 'github'],
    ['mcp__sentry__list_issues', 'sentry'],
  ])('handles direct HTTP MCP format: "%s" → "%s"', (toolName, expected) => {
    expect(extractMcpServer(toolName)).toBe(expected);
  });

  // Router/infra exclusion for mcp__ format
  it.each([
    ['mcp__super-mcp-router__list_tools', null],
    ['mcp__mcp__some_tool', null],
  ])('excludes router/infra from mcp__ format: "%s" → %s', (toolName, expected) => {
    expect(extractMcpServer(toolName)).toBe(expected);
  });

  // mcp__toolname with no tool segment (only 2 parts) returns null
  it.each([
    ['mcp__toolname', null],
    ['mcp__notion', null],
  ])('returns null for mcp__ with no tool segment: "%s" → %s', (toolName, expected) => {
    expect(extractMcpServer(toolName)).toBe(expected);
  });

  // Namespaced tools with mcp__ prefix and / skip the mcp__ branch,
  // but fall through to the / fallback (pre-existing behavior)
  it('handles mcp__delegation/Task via / fallback', () => {
    expect(extractMcpServer('mcp__delegation/Task')).toBe('mcp__delegation');
  });

  // Malformed mcp__ with no server segment
  it('returns null for bare mcp__ prefix', () => {
    expect(extractMcpServer('mcp__')).toBe(null);
  });

  // Existing substring matching (the original 7 servers)
  it.each([
    ['GoogleWorkspace/gmail_read_email', 'gmail'],
    ['GoogleWorkspace/google_calendar_list_events', 'google-calendar'],
    ['bundled-google/gcal_create_event', 'google-calendar'],
    ['bundled-microsoft-mail/outlook_send_email', 'outlook'],
    ['bundled-microsoft-calendar/outlook_calendar_list_events', 'outlook-calendar'],
    ['bundled-slack/slack_send_message', 'slack'],
    ['some-server/notion_search', 'notion'],
    ['bundled-microsoft-teams/teams_list_channels', 'teams'],
  ])('matches known server substrings: "%s" → "%s"', (toolName, expected) => {
    expect(extractMcpServer(toolName)).toBe(expected);
  });

  // Fallback: package_id/tool_id for unknown MCPs
  it.each([
    ['HubSpot/hubspot_search_contacts', 'hubspot'],
    ['Salesforce/salesforce_query', 'salesforce'],
    ['bundled-zendesk/zendesk_search', 'bundled-zendesk'],
    ['Fathom/fathom_get_transcript', 'fathom'],
    ['metabase/execute_query', 'metabase'],
  ])('falls back to lowercased package_id: "%s" → "%s"', (toolName, expected) => {
    expect(extractMcpServer(toolName)).toBe(expected);
  });

  // Router exclusion for / format
  it.each([
    ['super-mcp-router/list_tools', null],
    ['mcp/some_tool', null],
  ])('excludes router names from / fallback: "%s" → %s', (toolName, expected) => {
    expect(extractMcpServer(toolName)).toBe(expected);
  });

  // Built-in tools → null
  it.each([
    ['Read', null],
    ['Bash', null],
    ['Task', null],
    ['Write', null],
  ])('returns null for built-in tools: "%s"', (toolName) => {
    expect(extractMcpServer(toolName)).toBeNull();
  });
});

describe('sanitizeServerIdForAnalytics', () => {
  it.each([
    ['googleworkspace-greg-work-com', 'googleworkspace'],
    ['GoogleWorkspace-user-example-io', 'googleworkspace'],
    ['server-jane-company-org', 'server'],
  ])('strips email-derived suffixes: "%s" → "%s"', (input, expected) => {
    expect(sanitizeServerIdForAnalytics(input)).toBe(expected);
  });

  it.each([
    ['bundled-zendesk', 'bundled-zendesk'],
    ['hubspot', 'hubspot'],
    ['notion', 'notion'],
    ['bundled-microsoft-mail', 'bundled-microsoft-mail'],
  ])('preserves clean server IDs: "%s" → "%s"', (input, expected) => {
    expect(sanitizeServerIdForAnalytics(input)).toBe(expected);
  });

  it('strips embedded email addresses', () => {
    expect(sanitizeServerIdForAnalytics('[external-email]')).toBe('server');
  });

  it('lowercases output', () => {
    expect(sanitizeServerIdForAnalytics('HubSpot')).toBe('hubspot');
  });
});

describe('buildAnalyticsAttributionProperties', () => {
  it('emits Platform-compatible snake_case fields alongside legacy camelCase fields', () => {
    const props = buildAnalyticsAttributionProperties({
      companyName: 'Acme Ltd',
      accountName: 'Acme Account',
      source: 'settings.companyName',
      licenseTier: 'enterprise',
    });

    expect(props).toMatchObject({
      companyId: hashSessionId('acme ltd'),
      companyName: 'Acme Ltd',
      company_id: hashSessionId('acme ltd'),
      company_name: 'Acme Ltd',
      company_slug: 'acme-ltd',
      accountId: hashSessionId('acme account'),
      accountName: 'Acme Account',
      account_id: hashSessionId('acme account'),
      account_name: 'Acme Account',
      account_slug: 'acme-account',
      accountAttributionSource: 'settings.companyName',
      account_attribution_source: 'settings.companyName',
      licenseTier: 'enterprise',
    });
  });

  it('uses company name as the account fallback for account-level dashboard matching', () => {
    const props = buildAnalyticsAttributionProperties({
      companyName: 'Mindstone Rebel',
    });

    expect(props.accountName).toBe('Mindstone Rebel');
    expect(props.account_name).toBe('Mindstone Rebel');
    expect(props.account_slug).toBe('mindstone-rebel');
    expect(props.account_id).toBe(hashSessionId('mindstone rebel'));
  });

  it('omits empty attribution fields', () => {
    expect(buildAnalyticsAttributionProperties({
      companyName: '   ',
      accountName: '',
      source: null,
    })).toEqual({});
  });

  it('includes organization and team fields from platform analytics identity', () => {
    const props = buildAnalyticsAttributionProperties({
      organizationId: 'org-123',
      organizationSlug: 'acme-corp',
      organizationName: 'Acme Corp',
      teamId: 'team-456',
      teamName: 'Sales',
    });

    expect(props).toMatchObject({
      organization_id: 'org-123',
      organization_slug: 'acme-corp',
      organization_name: 'Acme Corp',
      team_id: 'team-456',
      team_name: 'Sales',
    });
  });

  it('omits team fields when team is unassigned', () => {
    expect(buildAnalyticsAttributionProperties({
      organizationId: 'org-123',
      organizationSlug: 'acme-corp',
      organizationName: 'Acme Corp',
      teamId: null,
      teamName: null,
    })).toMatchObject({
      organization_id: 'org-123',
      organization_slug: 'acme-corp',
      organization_name: 'Acme Corp',
    });
    expect(buildAnalyticsAttributionProperties({
      organizationId: 'org-123',
      organizationSlug: 'acme-corp',
      organizationName: 'Acme Corp',
      teamId: null,
      teamName: null,
    })).not.toHaveProperty('team_id');
  });
});

describe('buildDesktopAnalyticsContext', () => {
  // Mirrors the cloud bootstrap.analyticsWiring.test.ts R2 assertion pattern:
  // the desktop context provider (src/main/index.ts) tags every event with
  // client_surface:'desktop' (the cross-surface dimension), and must NOT set the
  // colliding per-event `surface` key.
  it('tags client_surface:"desktop" and never sets the colliding `surface` key', () => {
    const context = buildDesktopAnalyticsContext({ companyName: null, source: null });
    expect(context.client_surface).toBe('desktop');
    expect(context).not.toHaveProperty('surface');
  });

  it('defaults licenseTier to "free" and carries it through when provided', () => {
    expect(buildDesktopAnalyticsContext().licenseTier).toBe('free');
    expect(
      buildDesktopAnalyticsContext({ licenseTier: 'teams' }).licenseTier,
    ).toBe('teams');
  });

  it('merges attribution fields while keeping client_surface:"desktop"', () => {
    const context = buildDesktopAnalyticsContext({
      companyName: 'Acme Ltd',
      source: 'settings.companyName',
      licenseTier: 'enterprise',
    });
    expect(context.client_surface).toBe('desktop');
    expect(context).toMatchObject({
      company_name: 'Acme Ltd',
      account_attribution_source: 'settings.companyName',
      licenseTier: 'enterprise',
    });
    expect(context).not.toHaveProperty('surface');
  });
});

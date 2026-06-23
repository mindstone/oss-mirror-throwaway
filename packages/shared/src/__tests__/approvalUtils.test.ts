import { describe, it, expect } from 'vitest';
import {
  TOOL_DISPLAY_CONFIG,
  JARGON_TOOL_NAMES,
  SERVICE_PATTERNS,
  getToolDisplayConfig,
  getFriendlyToolName,
  getToolHeader,
  getToolFallbackSubtitle,
  isJargonToolName,
  isGenericReason,
  extractServiceFromReason,
} from '../approvalUtils';

// =============================================================================
// getToolDisplayConfig
// =============================================================================

describe('getToolDisplayConfig', () => {
  it.each([
    // Built-in tools with specific config
    ['Bash', 'Rebel wants to work on your computer', 'Local task'],
    ['Computer', 'Rebel wants to interact with your screen', 'Screen interaction'],
    ['TextEditor', 'Rebel wants to edit a file', 'File edit'],
    ['str_replace_editor', 'Rebel wants to edit a file', 'File edit'],
    ['text_editor', 'Rebel wants to edit a file', 'File edit'],
    ['Task', 'Rebel is working in the background', 'Background task'],
    ['Agent', 'Rebel is working in the background', 'Background task'],
    ['Execute', 'Rebel wants to work on your computer', 'Local task'],
  ])('returns config for known tool %s', (input, expectedHeader, expectedFriendly) => {
    const config = getToolDisplayConfig(input);
    expect(config).not.toBeNull();
    expect(config?.header).toBe(expectedHeader);
    expect(config?.friendlyName).toBe(expectedFriendly);
  });

  it.each([
    // Case-insensitivity: lower-case form still hits the lookup
    ['bash'],
    ['BASH'],
    ['task'],
    ['TASK'],
    ['texteditor'],
    ['TEXTEDITOR'],
    ['text_editor'],
    ['TEXT_EDITOR'],
  ])('is case-insensitive for %s', (input) => {
    expect(getToolDisplayConfig(input)).not.toBeNull();
  });

  it.each([
    // Non-jargon / unknown tools have no config
    ['Read'],
    ['Write'],
    ['Edit'],
    ['Gmail'],
    ['mcp__gmail__sendMessage'],
    ['mcp__slack__postMessage'],
    ['someUnknownTool'],
    [''],
  ])('returns null for unknown tool %s', (input) => {
    expect(getToolDisplayConfig(input)).toBeNull();
  });
});

// =============================================================================
// getFriendlyToolName
// =============================================================================

describe('getFriendlyToolName', () => {
  it.each([
    ['Bash', 'Local task'],
    ['Execute', 'Local task'],
    ['Computer', 'Screen interaction'],
    ['TextEditor', 'File edit'],
    ['str_replace_editor', 'File edit'],
    ['text_editor', 'File edit'],
    ['Task', 'Background task'],
    ['Agent', 'Background task'],
  ])('returns friendly name for known tool %s', (input, expected) => {
    expect(getFriendlyToolName(input)).toBe(expected);
  });

  it.each([
    // Case insensitive
    ['bash', 'Local task'],
    ['BASH', 'Local task'],
    ['Task', 'Background task'],
    ['TASK', 'Background task'],
  ])('is case-insensitive for %s', (input, expected) => {
    expect(getFriendlyToolName(input)).toBe(expected);
  });

  it.each([
    // Non-jargon / unknown tools return null (caller picks fallback)
    ['Read'],
    ['Write'],
    ['Edit'],
    ['Gmail'],
    ['mcp__gmail__sendMessage'],
    ['someUnknownTool'],
    [''],
  ])('returns null for unknown tool %s', (input) => {
    expect(getFriendlyToolName(input)).toBeNull();
  });
});

// =============================================================================
// getToolHeader
// =============================================================================

describe('getToolHeader', () => {
  it.each([
    ['Bash', 'Rebel wants to work on your computer'],
    ['Execute', 'Rebel wants to work on your computer'],
    ['Computer', 'Rebel wants to interact with your screen'],
    ['TextEditor', 'Rebel wants to edit a file'],
    ['str_replace_editor', 'Rebel wants to edit a file'],
    ['text_editor', 'Rebel wants to edit a file'],
    ['Task', 'Rebel is working in the background'],
    ['Agent', 'Rebel is working in the background'],
  ])('returns header for known tool %s', (input, expected) => {
    expect(getToolHeader(input)).toBe(expected);
  });

  it.each([
    ['bash', 'Rebel wants to work on your computer'],
    ['BASH', 'Rebel wants to work on your computer'],
  ])('is case-insensitive for %s', (input, expected) => {
    expect(getToolHeader(input)).toBe(expected);
  });

  it.each([
    ['Read'],
    ['Write'],
    ['Edit'],
    ['Gmail'],
    ['mcp__gmail__sendMessage'],
    [''],
  ])('returns null for unknown tool %s', (input) => {
    expect(getToolHeader(input)).toBeNull();
  });
});

// =============================================================================
// getToolFallbackSubtitle
// =============================================================================

describe('getToolFallbackSubtitle', () => {
  it.each([
    // Tools with their own display config get their specific subtitle
    ['Bash', 'Part of completing what you asked — runs on your device'],
    ['Execute', 'Part of completing what you asked — runs on your device'],
    ['Computer', 'Rebel needs to view or click on something on your screen'],
    ['TextEditor', 'Rebel needs to make changes to a file on your computer'],
    ['str_replace_editor', 'Rebel needs to make changes to a file on your computer'],
    ['text_editor', 'Rebel needs to make changes to a file on your computer'],
    ['Task', 'A step is running behind the scenes to help with your request'],
    ['Agent', 'A step is running behind the scenes to help with your request'],
  ])('returns configured subtitle for %s', (input, expected) => {
    expect(getToolFallbackSubtitle(input)).toBe(expected);
  });

  it.each([
    // Jargon tools without specific config get the generic jargon subtitle
    ['shell', 'Part of completing what you asked — runs on your device'],
    ['cmd', 'Part of completing what you asked — runs on your device'],
    ['powershell', 'Part of completing what you asked — runs on your device'],
    ['terminal', 'Part of completing what you asked — runs on your device'],
    ['subprocess', 'Part of completing what you asked — runs on your device'],
    ['exec', 'Part of completing what you asked — runs on your device'],
    ['run', 'Part of completing what you asked — runs on your device'],
    ['spawn', 'Part of completing what you asked — runs on your device'],
  ])('returns generic jargon subtitle for jargon-only tool %s', (input, expected) => {
    expect(getToolFallbackSubtitle(input)).toBe(expected);
  });

  it.each([
    // Non-jargon tools return null — they have their own display name
    ['Read'],
    ['Write'],
    ['Edit'],
    ['Gmail'],
    ['mcp__gmail__sendMessage'],
    [''],
  ])('returns null for non-jargon tool %s', (input) => {
    expect(getToolFallbackSubtitle(input)).toBeNull();
  });
});

// =============================================================================
// isJargonToolName
// =============================================================================

describe('isJargonToolName', () => {
  it.each([
    // Jargon set members (all lowercase keys)
    ['bash'],
    ['computer'],
    ['texteditor'],
    ['text_editor'],
    ['str_replace_editor'],
    ['execute'],
    ['task'],
    ['agent'],
    ['shell'],
    ['cmd'],
    ['powershell'],
    ['terminal'],
    ['subprocess'],
    ['exec'],
    ['run'],
    ['spawn'],
  ])('returns true for jargon %s', (input) => {
    expect(isJargonToolName(input)).toBe(true);
  });

  it.each([
    // Case-insensitive
    ['BASH'],
    ['Bash'],
    ['TASK'],
    ['Task'],
    ['TextEditor'],
    ['STR_REPLACE_EDITOR'],
  ])('is case-insensitive for jargon %s', (input) => {
    expect(isJargonToolName(input)).toBe(true);
  });

  it.each([
    // Known friendly tools (non-jargon)
    ['Read'],
    ['Write'],
    ['Edit'],
    ['Gmail'],
    ['mcp__gmail__sendMessage'],
    ['mcp__slack__postMessage'],
    ['someUnknownTool'],
    [''],
  ])('returns false for non-jargon %s', (input) => {
    expect(isJargonToolName(input)).toBe(false);
  });
});

// =============================================================================
// isGenericReason
// =============================================================================

describe('isGenericReason', () => {
  it.each([
    // Undefined / empty are treated as generic (no information to show)
    [undefined],
    [''],
  ])('returns true for empty reason %s', (input) => {
    expect(isGenericReason(input)).toBe(true);
  });

  it.each([
    // Exact-match generic reasons (case-insensitive in the lower() path)
    ['requires your approval to continue'],
    ['Requires your approval to continue'],
    ['REQUIRES YOUR APPROVAL TO CONTINUE'],
    ['needs your ok to continue'],
    ['Needs your OK to continue'],
    ['action needs your ok'],
    ['Action needs your OK'],
    ['risk assessment complete'],
    ['Risk Assessment Complete'],
    ['rebel needs your ok before proceeding'],
    ['Rebel needs your OK before proceeding'],
    ['rebel needs you to review this before proceeding'],
    ['Rebel needs you to review this before proceeding'],
  ])('returns true for exact-match generic reason %s', (input) => {
    expect(isGenericReason(input)).toBe(true);
  });

  it.each([
    // startsWith("unable to verify safety") family
    ['Unable to verify safety'],
    ['unable to verify safety of this action'],
    ['Unable to verify safety — falling back to prompt'],
  ])('returns true for "Unable to verify safety" prefix %s', (input) => {
    expect(isGenericReason(input)).toBe(true);
  });

  it.each([
    // startsWith("safety evaluation unavailable") family (REBEL-147 — legacy copy)
    ['Safety evaluation unavailable — please try again or approve one-time'],
    ['safety evaluation unavailable'],
    ['Safety evaluation unavailable — staged for review'],
    // With "Safety Rules blocked:" prefix (raw form from mapper)
    ['Safety Rules blocked: Safety evaluation unavailable — please try again or approve one-time'],
    ['Safety Rules blocked: unable to verify safety of this action'],
  ])('returns true for "Safety evaluation unavailable" prefix %s', (input) => {
    expect(isGenericReason(input)).toBe(true);
  });

  it.each([
    // startsWith("rebel can't complete the safety check") family (REBEL-5G8 follow-up — current copy)
    ["Rebel can't complete the safety check (provider error). This often clears on its own — if it keeps happening, restart Rebel or raise a bug and we'll look into it."],
    ["rebel can't complete the safety check (provider error)"],
    // With "Safety Rules blocked:" prefix (raw form from mapper)
    ["Safety Rules blocked: Rebel can't complete the safety check (provider error). This often clears on its own — if it keeps happening, restart Rebel or raise a bug and we'll look into it."],
  ])('returns true for "Rebel can\'t complete the safety check" prefix %s', (input) => {
    expect(isGenericReason(input)).toBe(true);
  });

  it.each([
    // startsWith("matched explicit safety rule") family (deterministic fallback)
    ['Matched explicit Safety Rule (LLM unavailable): Protect sensitive content: Do not share names'],
    ['Matched explicit Safety Rule (rate limited): Some rule text here'],
    ['Matched explicit Safety Rule (eval queued too long): Another rule text'],
    // With "Safety Rules blocked:" prefix
    ['Safety Rules blocked: Matched explicit Safety Rule (LLM unavailable): rule text'],
  ])('returns true for "Matched explicit Safety Rule" prefix %s', (input) => {
    expect(isGenericReason(input)).toBe(true);
  });

  it.each([
    // Meaningful, tool-specific reasons
    ['Sending an email to contoso.com'],
    ['Posting a message to #general in Slack'],
    ['Reading meeting-notes.md for summary'],
    ['Rebel wants to write 3 files'],
    ['Rebel wants to update your calendar'],
  ])('returns false for specific reason %s', (input) => {
    expect(isGenericReason(input)).toBe(false);
  });
});

// =============================================================================
// extractServiceFromReason
// =============================================================================

describe('extractServiceFromReason', () => {
  it.each([
    // Specific-service patterns come first (ordered by specificity)
    ['Send an email via Gmail', 'Gmail'],
    ['using gmail', 'Gmail'],
    ['Upload to Google Drive', 'Google Workspace'],
    ['Create a Google Docs file', 'Google Workspace'],
    ['Open google sheets', 'Google Workspace'],
    ['Schedule in google calendar', 'Google Workspace'],
    ['Post in Slack', 'Slack'],
    ['Create a Notion page', 'Notion'],
    ['File a Linear ticket', 'Linear'],
    ['Open GitHub pull request', 'GitHub'],
    ['Update HubSpot contact', 'HubSpot'],
    ['Handle a zendesk ticket', 'Zendesk'],
    ['Add to Todoist', 'Todoist'],
    ['Move a Jira issue', 'Jira'],
    ['Update Asana task', 'Asana'],
    ['Trello card', 'Trello'],
    ['Salesforce lead', 'Salesforce'],
    ['Send via Intercom', 'Intercom'],
    ['Update Confluence page', 'Confluence'],
    ['Share via Dropbox', 'Dropbox'],
    ['Open Figma file', 'Figma'],
    ['Update an Airtable row', 'Airtable'],
    ['Post to Microsoft Teams', 'Microsoft Teams'],
    ['Send via Outlook', 'Outlook'],
    ['Upload to OneDrive', 'OneDrive'],
  ])('extracts specific service from %s', (input, expected) => {
    expect(extractServiceFromReason(input)).toBe(expected);
  });

  it.each([
    // Generic fallbacks (apply only when no specific pattern matched)
    ['Schedule on your calendar', 'Calendar'],
    ['Send an email', 'Email'],
  ])('falls back to generic %s', (input, expected) => {
    expect(extractServiceFromReason(input)).toBe(expected);
  });

  it('prefers specific service over generic fallback (Gmail > Email)', () => {
    // "Gmail" pattern is listed BEFORE "email", so it must win.
    expect(extractServiceFromReason('Send an email via Gmail')).toBe('Gmail');
  });

  it('prefers specific service over generic fallback (Google Workspace > Calendar)', () => {
    // "google calendar" matches "Google Workspace" first; generic "calendar" never reached.
    expect(extractServiceFromReason('Schedule in google calendar')).toBe('Google Workspace');
  });

  it.each([
    // No match → null
    [undefined],
    [''],
    ['Some generic approval reason'],
    ['Writing a file'],
    ['Running bash command'],
  ])('returns null for reason %s', (input) => {
    expect(extractServiceFromReason(input)).toBeNull();
  });
});

// =============================================================================
// Constants integrity checks
// =============================================================================

describe('exported constants', () => {
  it('TOOL_DISPLAY_CONFIG has non-empty entries with all three fields', () => {
    for (const [key, cfg] of Object.entries(TOOL_DISPLAY_CONFIG)) {
      expect(cfg.header, `header missing for ${key}`).toBeTruthy();
      expect(cfg.subtitle, `subtitle missing for ${key}`).toBeTruthy();
      expect(cfg.friendlyName, `friendlyName missing for ${key}`).toBeTruthy();
    }
  });

  it('JARGON_TOOL_NAMES is a non-empty Set of lowercase strings', () => {
    expect(JARGON_TOOL_NAMES.size).toBeGreaterThan(0);
    for (const name of JARGON_TOOL_NAMES) {
      expect(name).toBe(name.toLowerCase());
    }
  });

  it('SERVICE_PATTERNS is a non-empty readonly array of {pattern, name}', () => {
    expect(SERVICE_PATTERNS.length).toBeGreaterThan(0);
    for (const entry of SERVICE_PATTERNS) {
      expect(entry.pattern).toBeInstanceOf(RegExp);
      expect(entry.name).toBeTruthy();
    }
  });

  it('every TOOL_DISPLAY_CONFIG entry is also in JARGON_TOOL_NAMES', () => {
    // All configured tool keys represent jargon — they're shown with a friendly
    // name precisely because they'd otherwise confuse users.
    for (const key of Object.keys(TOOL_DISPLAY_CONFIG)) {
      expect(
        JARGON_TOOL_NAMES.has(key.toLowerCase()),
        `${key} has display config but is missing from JARGON_TOOL_NAMES`,
      ).toBe(true);
    }
  });
});

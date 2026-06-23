/**
 * Prompt-contract test for calendar-sync.md.
 *
 * Guards against REBEL-13Y regression: the calendar-sync prompt MUST instruct
 * provider-correct argument names so models do not emit camelCase to Google
 * (which expects snake_case) or vice-versa.
 *
 * Loads the real prompt via getPrompt(PROMPT_IDS.INTELLIGENCE_CALENDAR_SYNC)
 * — same path the live calendarSyncService uses — so this test stays in sync
 * with the .md source-of-truth file automatically.
 *
 * IMPORTANT — provider→convention binding (REBEL-13Y review F1):
 *   Whole-prompt token presence is NOT enough; it would pass even if Google
 *   and Microsoft conventions were swapped (each token would still appear
 *   somewhere in the document). The assertions below extract a per-provider
 *   section first, then check that the right convention appears (and the
 *   wrong one is absent) in that section.
 *
 * See:
 *   - rebel-system/prompts/intelligence/calendar-sync.md (the prompt)
 *   - src/core/services/calendarSyncService.ts (live consumer)
 *   - docs-private/investigations/260530_rebel-13y_mcp_arg_validation.md (root-cause doc)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { getPrompt, PROMPT_IDS } from '@core/services/promptFileService';
import { setupPromptService, teardownPromptService } from './helpers/promptTestSetup';

// ---------------------------------------------------------------------------
// Section extractors — fail loudly if the prompt structure changes
// ---------------------------------------------------------------------------

function findLine(prompt: string, marker: string): string {
  const line = prompt.split('\n').find((l) => l.includes(marker));
  if (!line) {
    throw new Error(`Prompt-contract test: expected a line containing "${marker}", got none`);
  }
  return line;
}

/**
 * The shared timezone bullet has the form
 *   "...Google calendar tools use `device_timezone` (...); Microsoft calendar tools use `deviceTimezone` (...)"
 * Split it at "; Microsoft" so each provider's half can be asserted in isolation.
 */
function extractTimezoneRegions(prompt: string): { google: string; microsoft: string } {
  const line = findLine(prompt, 'Google calendar tools use');
  const splitIdx = line.indexOf('; Microsoft');
  if (splitIdx === -1) {
    throw new Error(
      'Prompt-contract test: expected "Google ...; Microsoft ..." in the timezone bullet',
    );
  }
  return { google: line.slice(0, splitIdx), microsoft: line.slice(splitIdx + 1) };
}

/** All Google-specific instruction text: the Google tool line + the Google half of the timezone bullet. */
function googleSection(prompt: string): string {
  const toolLine = findLine(prompt, 'list_workspace_calendar_events');
  const { google } = extractTimezoneRegions(prompt);
  return `${toolLine}\n${google}`;
}

/** All Microsoft-specific instruction text: the Microsoft tool line + the Microsoft half of the timezone bullet. */
function microsoftSection(prompt: string): string {
  // Anchor on "Microsoft 365" (the connector phrasing) to avoid grabbing
  // "Microsoft365Calendar" from the example syncWarnings list.
  const toolLine = findLine(prompt, 'Microsoft 365');
  const { microsoft } = extractTimezoneRegions(prompt);
  return `${toolLine}\n${microsoft}`;
}

describe('calendar-sync prompt — provider arg-name contract (REBEL-13Y)', () => {
  beforeEach(() => setupPromptService());
  afterEach(() => teardownPromptService());

  const renderPrompt = (): string => getPrompt(PROMPT_IDS.INTELLIGENCE_CALENDAR_SYNC);

  // -------------------------------------------------------------------------
  // Google section: snake_case canonical
  // -------------------------------------------------------------------------

  it('Google section contains the snake_case canonical arg names', () => {
    const section = googleSection(renderPrompt());
    expect(section).toMatch(/return_json/);
    expect(section).toMatch(/device_timezone/);
  });

  it('Google section does NOT contain the camelCase Microsoft conventions (swap-detection)', () => {
    const section = googleSection(renderPrompt());
    // \b word-boundaries ensure we match the exact identifiers, not substrings.
    expect(section).not.toMatch(/\breturnJson\b/);
    expect(section).not.toMatch(/\bdeviceTimezone\b/);
  });

  // -------------------------------------------------------------------------
  // Microsoft section: camelCase canonical
  // -------------------------------------------------------------------------

  it('Microsoft section contains the camelCase canonical arg names', () => {
    const section = microsoftSection(renderPrompt());
    expect(section).toMatch(/returnText/);
    expect(section).toMatch(/deviceTimezone/);
  });

  it('Microsoft section does NOT contain the snake_case Google conventions (swap-detection)', () => {
    const section = microsoftSection(renderPrompt());
    expect(section).not.toMatch(/\breturn_text\b/);
    expect(section).not.toMatch(/\bdevice_timezone\b/);
  });

  // -------------------------------------------------------------------------
  // Tool-name guards (cheap structural assertions)
  // -------------------------------------------------------------------------

  it('mentions the Google calendar list tool (list_workspace_calendar_events)', () => {
    expect(renderPrompt()).toMatch(/list_workspace_calendar_events/);
  });

  it('mentions the Microsoft calendar list tool (list_events)', () => {
    expect(renderPrompt()).toMatch(/list_events/);
  });
});

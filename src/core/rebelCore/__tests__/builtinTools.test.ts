import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppSettings } from '@shared/types';
import { resetAssetStoreForTesting, setAssetStore } from '@core/assetStore';
import type { AssetStore } from '@core/assetStore';
import { setSettingsStoreAdapter } from '@core/services/settingsStore';
import {
  executeBuiltinTool,
  getBuiltinToolDefinitions,
  isBuiltinToolName,
} from '../builtinTools';

const makeAppSettings = (partial: Partial<AppSettings> = {}): AppSettings => ({
  coreDirectory: null,
  mcpConfigFile: null,
  onboardingCompleted: false,
  userEmail: null,
  onboardingFirstCompletedAt: null,
  voice: {},
  models: {},
  diagnostics: {},
  ...partial,
} as AppSettings);

function createMockAssetStore(): AssetStore {
  return {
    writeAsset: vi.fn(async ({ assetId, mimeType, bytes }) => ({
      ref: { assetId, mimeType, byteSize: bytes.byteLength },
    })),
    writeThumbnail: vi.fn(async () => undefined),
    generateThumbnail: vi.fn(async () => ({
      bytes: Buffer.from('thumb'),
      mimeType: 'image/png' as const,
    })),
    readAsset: vi.fn(async () => ({ reason: 'not-found' as const })),
    hasAsset: vi.fn(async () => ({ has: false })),
    listSessionAssets: vi.fn(async () => []),
    deleteSession: vi.fn(async () => undefined),
    moveSessionAssetsToDeleted: vi.fn(async () => undefined),
    restoreSessionAssetsFromDeleted: vi.fn(async () => undefined),
  };
}

describe('builtin tools', () => {
  let mockSettings: AppSettings;
  const updateSettingsMock = vi.fn<(partial: Partial<AppSettings>) => void>();

  beforeEach(() => {
    mockSettings = makeAppSettings();
    updateSettingsMock.mockReset();
    setSettingsStoreAdapter({
      getSettings: () => mockSettings,
      updateSettings: updateSettingsMock,
      updateSettingsAtomic: (updater) => {
        const partial = updater(mockSettings);
        updateSettingsMock(partial);
      },
    });
  });

  afterEach(() => {
    resetAssetStoreForTesting();
  });

  it('includes suggest_connector_setup in built-in tool definitions', () => {
    const setupSignalTool = getBuiltinToolDefinitions().find((tool) => tool.name === 'suggest_connector_setup');

    expect(setupSignalTool).toMatchObject({
      name: 'suggest_connector_setup',
      input_schema: {
        required: ['connectorName'],
      },
    });
  });

  it('includes Glob in built-in tool definitions', () => {
    const globTool = getBuiltinToolDefinitions().find((tool) => tool.name === 'Glob');
    expect(globTool).toMatchObject({
      name: 'Glob',
      input_schema: {
        required: ['pattern'],
      },
    });
    expect(isBuiltinToolName('Glob')).toBe(true);
  });

  it('includes LS in built-in tool definitions', () => {
    const lsTool = getBuiltinToolDefinitions().find((tool) => tool.name === 'LS');
    expect(lsTool).toMatchObject({
      name: 'LS',
      input_schema: {
        required: ['path'],
      },
    });
    expect(isBuiltinToolName('LS')).toBe(true);
  });

  it('describes suggest_connector_setup as the catalog-miss offramp', () => {
    const setupSignalTool = getBuiltinToolDefinitions().find((tool) => tool.name === 'suggest_connector_setup');

    expect(setupSignalTool?.description).toContain(
      'user wants to use, connect, or set up a service that is not in Rebel\'s built-in connector catalog',
    );
    expect(setupSignalTool?.description).toContain(
      'OSS/custom connector flow instead of only explaining the catalog miss in prose',
    );
    expect(setupSignalTool?.description).toContain(
      'Do not use this for ordinary built-in connector installation or other built-in catalog connectors Rebel already supports.',
    );
  });

  it('includes AskUserQuestion in built-in tool definitions', () => {
    const askUserQuestionTool = getBuiltinToolDefinitions().find((tool) => tool.name === 'AskUserQuestion');

    expect(askUserQuestionTool).toMatchObject({
      name: 'AskUserQuestion',
      input_schema: {
        required: ['questions'],
      },
    });
  });

  it('allows zero-option AskUserQuestion prompts for direct text entry', () => {
    const askUserQuestionTool = getBuiltinToolDefinitions().find((tool) => tool.name === 'AskUserQuestion');
    const questions = askUserQuestionTool?.input_schema.properties?.questions as {
      items?: { properties?: { options?: { minItems?: number } } };
    } | undefined;

    expect(questions?.items?.properties?.options?.minItems).toBe(0);
  });

  it('teaches AskUserQuestion to prefer options over text fields', () => {
    const askUserQuestionTool = getBuiltinToolDefinitions().find((tool) => tool.name === 'AskUserQuestion');
    const description = askUserQuestionTool?.description ?? '';

    expect(description).toMatch(/Default to 2-4 concrete options/);
    expect(description).toMatch(/clicking is easier than typing/);
    expect(description).toMatch(/Use `options: \[\]` only/);
    expect(description).toMatch(/author or paste an exact value/);
  });

  it('teaches AskUserQuestion to batch distinct missing decisions separately', () => {
    const askUserQuestionTool = getBuiltinToolDefinitions().find((tool) => tool.name === 'AskUserQuestion');
    const description = askUserQuestionTool?.description ?? '';

    expect(description).toMatch(/multiple distinct decisions/);
    expect(description).toMatch(/multiple questions in the same batch/);
    expect(description).toMatch(/what should I send, and where\?/i);
  });

  it('teaches AskUserQuestion that edited message text is not a stopping point', () => {
    const askUserQuestionTool = getBuiltinToolDefinitions().find((tool) => tool.name === 'AskUserQuestion');
    const description = askUserQuestionTool?.description ?? '';

    expect(description).toMatch(/edit first/);
    expect(description).toMatch(/Slack vs email vs something else/);
    expect(description).toMatch(/normal send\/post tool path/);
    expect(description).toMatch(/Do not stop at a chat-only/i);
  });

  it('mandates the API-key URL pattern for AskUserQuestion (MUST pair url + requiresInput)', () => {
    const askUserQuestionTool = getBuiltinToolDefinitions().find((tool) => tool.name === 'AskUserQuestion');
    const description = askUserQuestionTool?.description ?? '';

    // Assert the mandate, not the preference — guards against future softening regressions.
    // See docs-private/investigations/260420_ask_user_question_credential_collection_dead_end.md.
    expect(description).toContain('MUST');
    expect(description).toContain('requiresInput');
    expect(description).toContain('url');
    expect(description).toContain('strands the user');
  });

  // ─── Pre-approval clarification guidance ────────────────────
  // Background: docs/plans/260518_reduce_approval_clarification_branch_scope.md (Stage 1).
  // These tests anchor the agent-facing wording that teaches the difference
  // between clarification (resolves intent) and approval (grants permission).
  // The wording must encode three invariants:
  //   1. Ask BEFORE approval when there is a NAMED MISSING DECISION.
  //   2. Clarification answers are NOT approval, but once the action is
  //      fully specified the agent must still use the action-tool path so
  //      the host safety layer can stage/review it — including after
  //      emphatic free-text answers like "yes, send it now" / "approve it".
  //   3. Clarification answers are NOT persisted as Safety Rules / preferences.
  // Plus negative guidance:
  //   - clear-but-sensitive actions skip clarification and go to approval;
  //   - vague uncertainty without a concrete missing decision should not
  //     trigger a question.

  it('teaches AskUserQuestion to ask a concrete clarification BEFORE approval for named missing decisions', () => {
    const askUserQuestionTool = getBuiltinToolDefinitions().find((tool) => tool.name === 'AskUserQuestion');
    const description = askUserQuestionTool?.description ?? '';

    expect(description).toMatch(/PRE-APPROVAL CLARIFICATION/);
    // Must instruct asking BEFORE the sensitive action proposal.
    expect(description).toMatch(/before proposing the action|before the action|before the approval/i);
    // Must require a NAMED MISSING DECISION (not vague uncertainty).
    expect(description).toMatch(/NAMED MISSING DECISION/);
    // Must enumerate the representative concrete-branch scenarios so the
    // agent has examples without overfitting to any single one.
    expect(description).toMatch(/calendar/i);
    expect(description).toMatch(/account/i);
    expect(description).toMatch(/save destination|destination/i);
    expect(description).toMatch(/memory boundary|private vs shared/i);
  });

  it('teaches AskUserQuestion not to default the delivery channel for send-note requests', () => {
    const askUserQuestionTool = getBuiltinToolDefinitions().find((tool) => tool.name === 'AskUserQuestion');
    const description = askUserQuestionTool?.description ?? '';

    expect(description).toMatch(/send a note\/message to <person>/i);
    expect(description).toMatch(/delivery channel is a named missing decision/i);
    expect(description).toMatch(/Slack DM vs email/i);
    expect(description).toMatch(/Do not silently default to email or Slack/i);
    expect(description).toMatch(/channel\/content clarification together/i);
  });

  it('requires approval clarification questions to carry the semantic purpose', () => {
    const askUserQuestionTool = getBuiltinToolDefinitions().find((tool) => tool.name === 'AskUserQuestion');
    const description = askUserQuestionTool?.description ?? '';
    const questionsSchema = askUserQuestionTool?.input_schema.properties?.questions as
      | { items?: { properties?: { purpose?: unknown } } }
      | undefined;
    const purposeSchema = questionsSchema?.items?.properties?.purpose;

    expect(description).toMatch(/MUST.*purpose: "approval_clarification"/);
    expect(purposeSchema).toMatchObject({
      type: 'string',
      enum: ['approval_clarification'],
    });
  });

  it('teaches AskUserQuestion that clarification is NOT approval (and does NOT create Safety Rules)', () => {
    const askUserQuestionTool = getBuiltinToolDefinitions().find((tool) => tool.name === 'AskUserQuestion');
    const description = askUserQuestionTool?.description ?? '';

    // The single highest-risk regression: an answer being treated as
    // permission to execute. Must be stated explicitly.
    expect(description).toMatch(/clarification is NOT approval/i);
    expect(description).toMatch(/does NOT authorise|does not authori[sz]e/i);
    expect(description).toMatch(/does NOT bypass any later approval|does not bypass any later approval/i);

    // Adversarial free-text guard: emphatic phrases the user might type
    // must be treated as clarification data, not permission.
    expect(description).toMatch(/send it now/i);
    expect(description).toMatch(/approve it/i);
    expect(description).toMatch(/go ahead/i);
    expect(description).toMatch(/clarification data/i);

    // Per-case only — no Safety Rule / preference persistence.
    expect(description).toMatch(/Safety Rule/);
    expect(description).toMatch(/per-case/i);
    expect(description).toMatch(/do NOT save|do not save|not.*persistent permission/i);
  });

  it('teaches AskUserQuestion when NOT to ask: clear-but-sensitive goes to approval; vague uncertainty does not ask', () => {
    const askUserQuestionTool = getBuiltinToolDefinitions().find((tool) => tool.name === 'AskUserQuestion');
    const description = askUserQuestionTool?.description ?? '';

    expect(description).toMatch(/DO NOT use this tool|do not use this tool/);
    // Clear-but-sensitive: skip clarification and enter the action-tool path directly.
    expect(description).toMatch(/clear and just sensitive|action is clear/i);
    expect(description).toMatch(/normal action-tool path directly/i);
    // Vague uncertainty without a named branch must not trigger a question.
    expect(description).toMatch(/vague uncertainty|cannot name a specific missing decision/i);
  });

  it('teaches AskUserQuestion to resume via the action-tool approval path after the answer', () => {
    const askUserQuestionTool = getBuiltinToolDefinitions().find((tool) => tool.name === 'AskUserQuestion');
    const description = askUserQuestionTool?.description ?? '';

    // After the answer arrives, the agent must propose the resolved
    // sensitive action through the host approval layer by using the tool path,
    // not by inventing a second chat-confirmation step.
    expect(description).toMatch(/normal action-tool path/i);
    expect(description).toMatch(/Safety Rules \/ approval layer/i);
    expect(description).toMatch(/Do NOT ask the user to type|do not ask the user to type/i);
    expect(description).toMatch(/reply.*send|reply.*approve/i);
  });

  it('recognizes AskUserQuestion as a built-in tool name', () => {
    expect(isBuiltinToolName('AskUserQuestion')).toBe(true);
  });

  it('recognizes suggest_connector_setup as a built-in tool name', () => {
    expect(isBuiltinToolName('suggest_connector_setup')).toBe(true);
  });

  it('includes UpdateModelProfileNotes in built-in tool definitions', () => {
    const updateNotesTool = getBuiltinToolDefinitions().find((tool) => tool.name === 'UpdateModelProfileNotes');

    expect(updateNotesTool).toMatchObject({
      name: 'UpdateModelProfileNotes',
      input_schema: {
        required: ['profile_id', 'notes'],
      },
    });
    expect(updateNotesTool?.description).toContain('adaptive routing decisions');
  });

  it('recognizes UpdateModelProfileNotes as a built-in tool name', () => {
    expect(isBuiltinToolName('UpdateModelProfileNotes')).toBe(true);
  });

  it('updates modelNotes for the requested profile', async () => {
    mockSettings = makeAppSettings({
      localModel: {
        activeProfileId: 'profile-1',
        profiles: [
          {
            id: 'profile-1',
            name: 'Fast Model',
            serverUrl: 'https://example.com/v1',
            model: 'fast-model',
            createdAt: 1,
          },
          {
            id: 'profile-2',
            name: 'Careful Model',
            serverUrl: 'https://example.com/v1',
            model: 'careful-model',
            modelNotes: 'Keep this note.',
            createdAt: 2,
          },
        ],
      },
    });

    const result = await executeBuiltinTool('UpdateModelProfileNotes', {
      profile_id: 'profile-1',
      notes: 'Fast for routine routing. Avoid deep synthesis.',
    });

    expect(result).toEqual({
      output: "Updated notes for profile 'Fast Model' (ID: profile-1).",
      isError: false,
    });
    expect(updateSettingsMock).toHaveBeenCalledWith({
      localModel: {
        activeProfileId: 'profile-1',
        profiles: [
          expect.objectContaining({
            id: 'profile-1',
            modelNotes: 'Fast for routine routing. Avoid deep synthesis.',
          }),
          expect.objectContaining({
            id: 'profile-2',
            modelNotes: 'Keep this note.',
          }),
        ],
      },
    });
  });

  it('returns an error when UpdateModelProfileNotes cannot find the profile', async () => {
    mockSettings = makeAppSettings({
      localModel: {
        activeProfileId: null,
        profiles: [],
      },
    });

    const result = await executeBuiltinTool('UpdateModelProfileNotes', {
      profile_id: 'missing-profile',
      notes: 'No-op.',
    });

    expect(result).toEqual({
      output: "UpdateModelProfileNotes failed: profile 'missing-profile' was not found.",
      isError: true,
    });
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });

  it('returns structured JSON when suggest_connector_setup executes', async () => {
    const result = await executeBuiltinTool('suggest_connector_setup', {
      connectorName: 'Zendesk',
      intent: 'extend',
      connectorId: 'catalog:bundled-zendesk',
      reason: 'User wants more tools',
    });

    expect(result).toEqual({
      output: JSON.stringify({
        connectorName: 'Zendesk',
        intent: 'extend',
        connectorId: 'catalog:bundled-zendesk',
        reason: 'User wants more tools',
      }, null, 2),
      isError: false,
    });
  });

  it('fails closed with sensitive-clarification guidance when AskUserQuestion is unsupported in this session', async () => {
    // Per docs/plans/260518_reduce_approval_clarification_branch_scope.md (Stage 1):
    // when the question tool is unavailable in the current session type, the
    // fallback message MUST NOT tell the agent to "proceed using your best
    // judgment" for sensitive actions — that turns a missed clarification
    // into a guessed sensitive action. It must fail closed for sensitive
    // clarification while still allowing best-judgment fallback for
    // non-sensitive read/draft/explore work.
    const result = await executeBuiltinTool('AskUserQuestion', {
      questions: [
        {
          question: 'Which path should I take?',
          header: 'Approach',
          options: [
            { label: 'Option A', description: 'Take the first option.' },
            { label: 'Option B', description: 'Take the second option.' },
          ],
        },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('AskUserQuestion is not available in this session type.');

    // Fail-closed for sensitive clarification: must explicitly tell the
    // agent to STOP, not guess, and not execute. This is the critical
    // anti-regression assertion.
    expect(result.output).toContain('STOP');
    expect(result.output).toMatch(/do not guess/i);
    expect(result.output).toMatch(/do not execute/i);
    expect(result.output).toMatch(/sensitive/i);
    expect(result.output).toMatch(/explain to the user|ask them to clarify/i);

    // Non-sensitive fallback path is still allowed (so we don't strand
    // read-only research / drafting work behind missing UI). This guards
    // the carve-out and prevents the next agent from over-correcting.
    expect(result.output).toMatch(/non-sensitive/i);
    expect(result.output).toMatch(/best judgment/i);
  });


  describe('Bash materialisation', () => {
    const originalKillSwitch = process.env.REBEL_DISABLE_BASH_MATERIALIZATION;
    let workspaceRoot: string;

    beforeEach(async () => {
      delete process.env.REBEL_DISABLE_BASH_MATERIALIZATION;
      workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-bash-materialization-'));
    });

    afterEach(async () => {
      if (originalKillSwitch == null) {
        delete process.env.REBEL_DISABLE_BASH_MATERIALIZATION;
      } else {
        process.env.REBEL_DISABLE_BASH_MATERIALIZATION = originalKillSwitch;
      }
      if (workspaceRoot && fsSync.existsSync(workspaceRoot)) {
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      }
    });

    const nodeCommand = (script: string): string => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;

    it('materialises stdout-only large output and reports the original outputChars', async () => {
      const stdoutLength = 20_001;

      const result = await executeBuiltinTool(
        'Bash',
        { command: nodeCommand(`process.stdout.write('x'.repeat(${stdoutLength}))`) },
        { cwd: workspaceRoot },
      );

      expect(result.isError).toBe(false);
      expect(result.outputChars).toBe(stdoutLength);
      expect(result.output).toContain('Command exited with status 0. Stdout (first 2048 chars):');
      expect(result.output).toContain('.rebel');
      expect(result.output).toContain('tool-outputs');
      expect(result.output).toContain(`full ${stdoutLength} chars saved`);
      // Stage 1: Bash signals it already produced a bounded preview so the
      // universal output cap in executeToolUse does not re-wrap it.
      expect(result.materialized).toBe(true);
    });

    it('keeps below-threshold Bash output in the existing flat format', async () => {
      const result = await executeBuiltinTool(
        'Bash',
        { command: nodeCommand("process.stdout.write('small')") },
        { cwd: workspaceRoot },
      );

      expect(result).toMatchObject({
        output: 'stdout:\nsmall\n\nexit_code: 0',
        isError: false,
        outputChars: 5,
      });
    });

    it('falls back to inline truncation when materialisation cannot write safely', async () => {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-bash-materialization-outside-'));
      try {
        await fs.mkdir(path.join(workspaceRoot, '.rebel'), { recursive: true });
        await fs.symlink(outside, path.join(workspaceRoot, '.rebel', 'tool-outputs'), 'dir');
      } catch (error) {
        await fs.rm(outside, { recursive: true, force: true });
        if ((error as NodeJS.ErrnoException).code === 'EPERM') {
          return;
        }
        throw error;
      }

      try {
        const stdoutLength = 20_001;
        const result = await executeBuiltinTool(
          'Bash',
          {
            command: nodeCommand(`process.stdout.write('x'.repeat(${stdoutLength}))`),
          },
          { cwd: workspaceRoot, maxOutputChars: 100 },
        );

        expect(result.isError).toBe(false);
        expect(result.outputChars).toBe(stdoutLength);
        expect(result.output).toContain('[output truncated:');
        // Materialisation failed → inline fallback is NOT marked materialised,
        // so the Stage 1 universal cap remains free to bound it if needed.
        expect(result.materialized).not.toBe(true);
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });
  });
  it('includes rebel_get_app_screenshot in built-in tool definitions', () => {
    const screenshotTool = getBuiltinToolDefinitions().find((tool) => tool.name === 'rebel_get_app_screenshot');

    expect(screenshotTool).toMatchObject({
      name: 'rebel_get_app_screenshot',
      input_schema: {
        required: ['theme'],
      },
    });
    expect(screenshotTool?.input_schema.properties).toMatchObject({
      capture_mode: {
        enum: ['viewport', 'scroll'],
      },
    });
  });

  it('recognizes rebel_get_app_screenshot as a built-in tool name', () => {
    expect(isBuiltinToolName('rebel_get_app_screenshot')).toBe(true);
  });

  it('includes rebel_navigate_app in built-in tool definitions', () => {
    const navigateTool = getBuiltinToolDefinitions().find((tool) => tool.name === 'rebel_navigate_app');

    expect(navigateTool).toMatchObject({
      name: 'rebel_navigate_app',
      input_schema: {
        required: ['destination'],
      },
    });
    expect(navigateTool?.input_schema.properties).toMatchObject({
      settings_tab: {
        enum: expect.arrayContaining(['meetings']),
      },
    });
  });

  it('recognizes rebel_navigate_app as a built-in tool name', () => {
    expect(isBuiltinToolName('rebel_navigate_app')).toBe(true);
  });

  it('navigates to a supported app destination when capability is present', async () => {
    const navigateApp = vi.fn().mockResolvedValue({
      kind: 'ok',
      destination: 'actions',
    });

    const result = await executeBuiltinTool(
      'rebel_navigate_app',
      { destination: 'actions' },
      { navigateApp },
    );

    expect(navigateApp).toHaveBeenCalledWith({ destination: 'actions' });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.output)).toEqual({ destination: 'actions' });
  });

  it('normalizes natural language app destination aliases before navigation', async () => {
    const navigateApp = vi.fn().mockResolvedValue({
      kind: 'ok',
      destination: 'actions',
    });

    for (const destination of ['Actions', 'Actions page', 'tasks', 'action-page']) {
      const result = await executeBuiltinTool(
        'rebel_navigate_app',
        { destination },
        { navigateApp },
      );

      expect(result.isError).toBe(false);
      expect(JSON.parse(result.output)).toEqual({ destination: 'actions' });
    }

    expect(navigateApp).toHaveBeenCalledTimes(4);
    expect(navigateApp).toHaveBeenCalledWith({ destination: 'actions' });
  });

  it('passes settings tab and section through app navigation', async () => {
    const navigateApp = vi.fn().mockResolvedValue({
      kind: 'ok',
      destination: 'settings',
      settingsTab: 'meetings',
      settingsSection: 'advanced',
    });

    const result = await executeBuiltinTool(
      'rebel_navigate_app',
      {
        destination: 'settings',
        settings_tab: 'meetings',
        settings_section: 'advanced',
      },
      { navigateApp },
    );

    expect(navigateApp).toHaveBeenCalledWith({
      destination: 'settings',
      settingsTab: 'meetings',
      settingsSection: 'advanced',
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.output)).toEqual({
      destination: 'settings',
      settings_tab: 'meetings',
      settings_section: 'advanced',
    });
  });

  it('rejects invalid settings tabs before navigation', async () => {
    const navigateApp = vi.fn();

    const result = await executeBuiltinTool(
      'rebel_navigate_app',
      { destination: 'settings', settings_tab: 'meetingz' },
      { navigateApp },
    );

    expect(navigateApp).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output)).toMatchObject({
      errorCode: 'invalid-destination',
      detail: { settings_tab: 'meetingz' },
    });
  });

  it('rejects settings tab options for non-settings destinations', async () => {
    const navigateApp = vi.fn();

    const result = await executeBuiltinTool(
      'rebel_navigate_app',
      { destination: 'actions', settings_tab: 'meetings' },
      { navigateApp },
    );

    expect(navigateApp).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output)).toMatchObject({
      errorCode: 'invalid-destination-modifiers',
      detail: {
        reason: 'settings_tab and settings_section can only be used when destination is settings',
        destination: 'actions',
        settings_tab: 'meetings',
      },
    });
  });

  it('returns typed not-supported error when app navigation capability is missing', async () => {
    const result = await executeBuiltinTool('rebel_navigate_app', {
      destination: 'actions',
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output)).toEqual({
      errorCode: 'navigation-not-supported-on-this-surface',
    });
  });

  it('returns typed not-supported error when screenshot capture capability is missing', async () => {
    const result = await executeBuiltinTool('rebel_get_app_screenshot', {
      theme: 'current',
    });

    expect(result.isError).toBe(true);
    expect(result.imageContent).toBeUndefined();
    expect(JSON.parse(result.output)).toEqual({
      errorCode: 'screenshot-not-supported-on-this-surface',
    });
  });

  it('returns imageContent and JSON metadata when screenshot capture succeeds', async () => {
    const captureRebelWindow = vi.fn().mockResolvedValue({
      kind: 'ok',
      path: '.rebel/screenshots/260430_091212_light_home_abc123.png',
      width: 1200,
      height: 800,
      theme: 'light',
      bytes: 54321,
      label: 'home',
      currentSurface: 'home',
      base64Data: 'ZmFrZS1pbWFnZS1kYXRh',
      mimeType: 'image/png',
    });

    const result = await executeBuiltinTool(
      'rebel_get_app_screenshot',
      { theme: 'light', label: 'home' },
      { captureRebelWindow },
    );

    expect(captureRebelWindow).toHaveBeenCalledWith({ theme: 'light', label: 'home', captureMode: 'scroll' });
    expect(result.isError).toBe(false);
    expect(result.imageContent).toEqual([{
      type: 'image',
      data: 'ZmFrZS1pbWFnZS1kYXRh',
      mimeType: 'image/png',
    }]);
    expect(JSON.parse(result.output)).toEqual({
      path: '.rebel/screenshots/260430_091212_light_home_abc123.png',
      width: 1200,
      height: 800,
      theme: 'light',
      bytes: 54321,
      current_surface: 'home',
      capture_mode: 'scroll',
      label: 'home',
    });
  });

  it('attaches imageRef when screenshot captures are materialized at the built-in producer boundary', async () => {
    const captureRebelWindow = vi.fn().mockResolvedValue({
      kind: 'ok',
      path: '.rebel/screenshots/260430_091212_light_home_abc123.png',
      width: 1200,
      height: 800,
      theme: 'light',
      bytes: 54321,
      label: 'home',
      currentSurface: 'home',
      base64Data: 'ZmFrZS1pbWFnZS1kYXRh',
      mimeType: 'image/png',
    });
    setAssetStore(createMockAssetStore());

    const result = await executeBuiltinTool(
      'rebel_get_app_screenshot',
      { theme: 'light', label: 'home' },
      {
        captureRebelWindow,
        imageAssetContext: {
          sessionId: 'session-1',
          turnId: 'turn-1',
          nextToolResultEventSeq: () => 21,
          surface: 'desktop',
        },
      },
    );

    expect(result.isError).toBe(false);
    expect(result.imageContent).toEqual([{
      type: 'image',
      data: 'ZmFrZS1pbWFnZS1kYXRh',
      mimeType: 'image/png',
    }]);
    expect(result.imageRef).toEqual([
      {
        assetId: 'turn-1-21-0',
        mimeType: 'image/png',
        byteSize: Buffer.from('ZmFrZS1pbWFnZS1kYXRh', 'base64').byteLength,
        thumbnailAssetId: 'turn-1-21-0_thumb',
        uploadStatus: 'pending',
      },
    ]);
  });

  it('defaults app screenshots to scroll mode so visual reviews do not miss below-the-fold content', async () => {
    const captureRebelWindow = vi.fn().mockResolvedValue({
      kind: 'ok',
      path: '.rebel/screenshots/260430_091212_light_actions-p01_abc123.png',
      width: 1200,
      height: 800,
      theme: 'light',
      bytes: 54321,
      label: 'actions',
      currentSurface: 'tasks',
      base64Data: 'ZmFrZS1pbWFnZS1kYXRh',
      mimeType: 'image/png',
    });

    const result = await executeBuiltinTool(
      'rebel_get_app_screenshot',
      { theme: 'light', label: 'actions' },
      { captureRebelWindow },
    );

    expect(captureRebelWindow).toHaveBeenCalledWith({ theme: 'light', label: 'actions', captureMode: 'scroll' });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.output)).toMatchObject({
      current_surface: 'tasks',
      capture_mode: 'scroll',
      label: 'actions',
    });
  });

  it('fails closed without image content when screenshot surface does not match the last app navigation', async () => {
    const captureRebelWindow = vi.fn().mockResolvedValue({
      kind: 'ok',
      path: '.rebel/screenshots/260430_091212_light_settings_abc123.png',
      width: 1200,
      height: 800,
      theme: 'light',
      bytes: 54321,
      label: 'actions',
      currentSurface: 'settings',
      base64Data: 'd3Jvbmctc3VyZmFjZS1pbWFnZQ==',
      mimeType: 'image/png',
    });
    const context = {
      captureRebelWindow,
      visualVerificationNavigation: {
        destination: 'actions' as const,
        expectedSurface: 'tasks',
      },
    };

    const result = await executeBuiltinTool(
      'rebel_get_app_screenshot',
      { theme: 'light', label: 'actions' },
      context,
    );

    expect(captureRebelWindow).toHaveBeenCalledWith({ theme: 'light', label: 'actions', captureMode: 'scroll' });
    expect(result.isError).toBe(true);
    expect(result.imageContent).toBeUndefined();
    expect(JSON.parse(result.output)).toEqual({
      errorCode: 'surface-mismatch',
      detail: {
        current_surface: 'settings',
        expected_surface: 'tasks',
        destination: 'actions',
      },
    });
  });

  it('shares navigation provenance through the per-turn state object', async () => {
    const navigateApp = vi.fn().mockResolvedValue({
      kind: 'ok',
      destination: 'actions',
    });
    const captureRebelWindow = vi.fn().mockResolvedValue({
      kind: 'ok',
      path: '.rebel/screenshots/260430_091212_light_settings_abc123.png',
      width: 1200,
      height: 800,
      theme: 'light',
      bytes: 54321,
      currentSurface: 'settings',
      base64Data: 'd3Jvbmctc3VyZmFjZS1pbWFnZQ==',
      mimeType: 'image/png',
    });
    const visualVerificationNavigationState = {};
    const navigateContext = {
      navigateApp,
      visualVerificationNavigationState,
    };
    const screenshotContext = {
      captureRebelWindow,
      visualVerificationNavigationState,
    };

    await executeBuiltinTool('rebel_navigate_app', { destination: 'actions' }, navigateContext);
    const result = await executeBuiltinTool(
      'rebel_get_app_screenshot',
      { theme: 'light' },
      screenshotContext,
    );

    expect(result.isError).toBe(true);
    expect(result.imageContent).toBeUndefined();
    expect(JSON.parse(result.output)).toMatchObject({
      errorCode: 'surface-mismatch',
      detail: {
        current_surface: 'settings',
        expected_surface: 'tasks',
        destination: 'actions',
      },
    });
  });

  it('returns multiple imageContent entries and capture metadata for scroll screenshots', async () => {
    const captureRebelWindow = vi.fn().mockResolvedValue({
      kind: 'ok',
      path: '.rebel/screenshots/260430_091212_light_settings-p01_abc123.png',
      width: 1200,
      height: 800,
      theme: 'light',
      bytes: 54321,
      label: 'settings',
      currentSurface: 'settings',
      base64Data: 'Zmlyc3Q=',
      mimeType: 'image/png',
      captures: [
        {
          path: '.rebel/screenshots/260430_091212_light_settings-p01_abc123.png',
          width: 1200,
          height: 800,
          bytes: 54321,
          base64Data: 'Zmlyc3Q=',
          mimeType: 'image/png',
          index: 0,
          scrollTop: 0,
        },
        {
          path: '.rebel/screenshots/260430_091212_light_settings-p02_def456.png',
          width: 1200,
          height: 800,
          bytes: 54322,
          base64Data: 'c2Vjb25k',
          mimeType: 'image/png',
          index: 1,
          scrollTop: 780,
        },
      ],
    });

    const result = await executeBuiltinTool(
      'rebel_get_app_screenshot',
      { theme: 'light', label: 'settings', capture_mode: 'scroll', max_screenshots: 2 },
      { captureRebelWindow },
    );

    expect(captureRebelWindow).toHaveBeenCalledWith({
      theme: 'light',
      label: 'settings',
      captureMode: 'scroll',
      maxScreenshots: 2,
    });
    expect(result.isError).toBe(false);
    expect(result.imageContent).toEqual([
      {
        type: 'image',
        data: 'Zmlyc3Q=',
        mimeType: 'image/png',
      },
      {
        type: 'image',
        data: 'c2Vjb25k',
        mimeType: 'image/png',
      },
    ]);
    expect(JSON.parse(result.output)).toEqual({
      path: '.rebel/screenshots/260430_091212_light_settings-p01_abc123.png',
      width: 1200,
      height: 800,
      theme: 'light',
      bytes: 54321,
      current_surface: 'settings',
      capture_mode: 'scroll',
      label: 'settings',
      captures: [
        {
          path: '.rebel/screenshots/260430_091212_light_settings-p01_abc123.png',
          width: 1200,
          height: 800,
          bytes: 54321,
          index: 0,
          scroll_top: 0,
        },
        {
          path: '.rebel/screenshots/260430_091212_light_settings-p02_def456.png',
          width: 1200,
          height: 800,
          bytes: 54322,
          index: 1,
          scroll_top: 780,
        },
      ],
    });
  });

  it('returns typed capture errors from the screenshot capability', async () => {
    const captureRebelWindow = vi.fn().mockResolvedValue({
      kind: 'error',
      errorCode: 'window-not-capturable',
      detail: { minimized: true },
    });

    const result = await executeBuiltinTool(
      'rebel_get_app_screenshot',
      { theme: 'dark' },
      { captureRebelWindow },
    );

    expect(result.isError).toBe(true);
    expect(result.imageContent).toBeUndefined();
    expect(JSON.parse(result.output)).toEqual({
      errorCode: 'window-not-capturable',
      detail: { minimized: true },
    });
  });

  it('rejects unsupported screenshot theme values', async () => {
    const captureRebelWindow = vi.fn();

    const result = await executeBuiltinTool(
      'rebel_get_app_screenshot',
      { theme: 'auto' },
      { captureRebelWindow },
    );

    expect(result.isError).toBe(true);
    expect(captureRebelWindow).not.toHaveBeenCalled();
    expect(JSON.parse(result.output)).toEqual({
      errorCode: 'capture-failed',
      detail: 'theme must be one of: current, light, dark',
    });
  });
});

/**
 * Integration tests for the Read / Write / Edit built-ins against the new
 * MCP-project sandbox exception. These exercise the full path-validation →
 * fs-call loop, not just the pure resolver.
 *
 * Strategy: build a throwaway "home" directory under the OS tmpdir and point
 * both `cwd` (workspace root) and `~/mcp-servers/` inside it, so no real
 * user files are ever touched.
 */
describe('builtin Read/Write/Edit — MCP sandbox exception (integration)', () => {
  let fakeHome: string;
  let workspaceRoot: string;
  let mcpProjectDir: string;

  beforeEach(async () => {
    fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-core-sandbox-'));
    workspaceRoot = path.join(fakeHome, 'Documents', 'Rebel');
    mcpProjectDir = path.join(fakeHome, 'mcp-servers', 'hello-world-mcp');
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.mkdir(path.join(mcpProjectDir, 'src'), { recursive: true });
  });

  afterEach(async () => {
    if (fakeHome && fsSync.existsSync(fakeHome)) {
      await fs.rm(fakeHome, { recursive: true, force: true });
    }
  });

  const ctx = () => ({ cwd: workspaceRoot, homePath: fakeHome });

  it('Write succeeds for package.json inside the MCP project (allowlisted root file)', async () => {
    const target = path.join(mcpProjectDir, 'package.json');
    const result = await executeBuiltinTool(
      'Write',
      { file_path: target, content: '{"name":"hello-world-mcp"}' },
      ctx(),
    );
    expect(result.isError).toBe(false);
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('{"name":"hello-world-mcp"}');
  });

  it('Write succeeds for src/index.ts (allowlisted subdir)', async () => {
    const target = path.join(mcpProjectDir, 'src', 'index.ts');
    const result = await executeBuiltinTool(
      'Write',
      { file_path: target, content: 'export {};' },
      ctx(),
    );
    expect(result.isError).toBe(false);
  });

  it('Write rejects .env at MCP project root (not in allowlist)', async () => {
    const target = path.join(mcpProjectDir, '.env');
    const result = await executeBuiltinTool(
      'Write',
      { file_path: target, content: 'SECRET=shh' },
      ctx(),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/allowed shape/i);
    expect(fsSync.existsSync(target)).toBe(false);
  });

  it('Write rejects paths outside both workspace and mcp-servers zones', async () => {
    const target = path.join(fakeHome, 'random.txt');
    const result = await executeBuiltinTool(
      'Write',
      { file_path: target, content: 'x' },
      ctx(),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/outside allowed zones/i);
    expect(fsSync.existsSync(target)).toBe(false);
  });

  it('Read succeeds for any file inside the MCP project (no allowlist on Read)', async () => {
    const envPath = path.join(mcpProjectDir, '.env');
    await fs.writeFile(envPath, 'SECRET=from-user', 'utf8');
    const result = await executeBuiltinTool('Read', { file_path: envPath }, ctx());
    expect(result.isError).toBe(false);
    expect(result.output).toContain('SECRET=from-user');
  });

  it('Edit succeeds for src/index.ts (allowlist not applied to Edit)', async () => {
    const target = path.join(mcpProjectDir, 'src', 'index.ts');
    await fs.writeFile(target, 'export const v = 1;', 'utf8');
    const result = await executeBuiltinTool(
      'Edit',
      { file_path: target, old_str: 'v = 1', new_str: 'v = 2' },
      ctx(),
    );
    expect(result.isError).toBe(false);
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('export const v = 2;');
  });

  it('Write under workspace still works (backwards compatibility)', async () => {
    const target = path.join(workspaceRoot, 'notes.md');
    const result = await executeBuiltinTool(
      'Write',
      { file_path: target, content: 'notes' },
      ctx(),
    );
    expect(result.isError).toBe(false);
  });

  it('Write reports whether it created or updated the target file', async () => {
    const target = path.join(workspaceRoot, 'write-status.md');

    const created = await executeBuiltinTool(
      'Write',
      { file_path: target, content: 'first draft' },
      ctx(),
    );
    expect(created).toMatchObject({
      isError: false,
      output: `Created 11 characters to ${target}`,
    });

    const updated = await executeBuiltinTool(
      'Write',
      { file_path: target, content: 'second draft' },
      ctx(),
    );
    expect(updated).toMatchObject({
      isError: false,
      output: `Updated 12 characters to ${target}`,
    });
  });

  it('Write rejects absolute paths outside cwd when homePath is unset (pre-fix behaviour preserved)', async () => {
    const target = path.join(mcpProjectDir, 'package.json');
    const result = await executeBuiltinTool(
      'Write',
      { file_path: target, content: '{}' },
      { cwd: workspaceRoot }, // no homePath
    );
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/outside allowed zones/i);
  });

  it('Write rejects paths at `~/mcp-servers/` root itself (no project segment)', async () => {
    const target = path.join(fakeHome, 'mcp-servers', 'readme-at-root.md');
    const result = await executeBuiltinTool(
      'Write',
      { file_path: target, content: 'x' },
      ctx(),
    );
    expect(result.isError).toBe(true);
  });

  it('Write rejects traversal attempts escaping mcp-servers', async () => {
    // Agent tries to write "~/mcp-servers/foo-mcp/../../Documents/evil.txt"
    // which after resolution is outside both zones.
    const target = path.join(mcpProjectDir, '..', '..', 'evil.txt');
    const result = await executeBuiltinTool(
      'Write',
      { file_path: target, content: 'x' },
      ctx(),
    );
    expect(result.isError).toBe(true);
  });

  it('Write rejects writes through a symlinked directory escaping the MCP project', async () => {
    const srcDir = path.join(mcpProjectDir, 'src');
    await fs.rm(srcDir, { recursive: true, force: true });
    const evilTarget = await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-escape-target-'));
    try {
      await fs.symlink(evilTarget, srcDir, 'dir');
      const target = path.join(srcDir, 'pwned.ts');
      const result = await executeBuiltinTool(
        'Write',
        { file_path: target, content: 'leak' },
        ctx(),
      );
      expect(result.isError).toBe(true);
      expect(result.output).toMatch(/symbolic link|outside allowed zones|realpath/i);
      expect(fsSync.existsSync(path.join(evilTarget, 'pwned.ts'))).toBe(false);
    } finally {
      await fs.rm(evilTarget, { recursive: true, force: true });
    }
  });

  it('Read rejects reads through a symlinked file escaping the MCP project', async () => {
    const secretDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-secret-'));
    const secretFile = path.join(secretDir, 'secret.txt');
    await fs.writeFile(secretFile, 'TOP_SECRET', 'utf8');
    const innocentLooking = path.join(mcpProjectDir, 'README.md');
    try {
      await fs.symlink(secretFile, innocentLooking, 'file');
      const result = await executeBuiltinTool(
        'Read',
        { file_path: innocentLooking },
        ctx(),
      );
      expect(result.isError).toBe(true);
      expect(result.output).not.toContain('TOP_SECRET');
    } finally {
      await fs.rm(secretDir, { recursive: true, force: true });
    }
  });
});

/**
 * Space symlink tests — verifies that reads/writes through Space symlinks
 * (which point to folders outside the workspace, e.g. Google Drive) succeed
 * when the Space sourcePath is listed in allowedSymlinkTargets.
 */
describe('builtin Read/Write/Edit — Space symlink targets', () => {
  let fakeHome: string;
  let workspaceRoot: string;
  let externalSpaceDir: string;
  let spaceSymlink: string;

  beforeEach(async () => {
    fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-space-symlink-'));
    workspaceRoot = path.join(fakeHome, 'Documents', 'Rebel');
    // External folder (e.g. Google Drive location) — outside the workspace
    externalSpaceDir = path.join(fakeHome, 'CloudStorage', 'GoogleDrive', 'General');
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.mkdir(externalSpaceDir, { recursive: true });
    // Symlink inside workspace pointing to external folder
    const workSpacesDir = path.join(workspaceRoot, 'work', 'Acme');
    await fs.mkdir(workSpacesDir, { recursive: true });
    spaceSymlink = path.join(workSpacesDir, 'General');
    await fs.symlink(externalSpaceDir, spaceSymlink, 'dir');
  });

  afterEach(async () => {
    if (fakeHome && fsSync.existsSync(fakeHome)) {
      await fs.rm(fakeHome, { recursive: true, force: true });
    }
  });

  const ctxWithSpaceTargets = () => ({
    cwd: workspaceRoot,
    homePath: fakeHome,
    allowedSymlinkTargets: [externalSpaceDir],
  });

  const ctxWithoutSpaceTargets = () => ({
    cwd: workspaceRoot,
    homePath: fakeHome,
  });

  it('Write succeeds through a Space symlink when sourcePath is in allowedSymlinkTargets', async () => {
    const target = path.join(spaceSymlink, 'notes.md');
    const result = await executeBuiltinTool(
      'Write',
      { file_path: target, content: 'Hello from Rebel' },
      ctxWithSpaceTargets(),
    );
    expect(result.isError).toBe(false);
    const written = await fs.readFile(path.join(externalSpaceDir, 'notes.md'), 'utf8');
    expect(written).toBe('Hello from Rebel');
  });

  it('Read succeeds through a Space symlink when sourcePath is in allowedSymlinkTargets', async () => {
    await fs.writeFile(path.join(externalSpaceDir, 'readme.md'), 'Space content', 'utf8');
    const result = await executeBuiltinTool(
      'Read',
      { file_path: path.join(spaceSymlink, 'readme.md') },
      ctxWithSpaceTargets(),
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContain('Space content');
  });

  it('Edit succeeds through a Space symlink when sourcePath is in allowedSymlinkTargets', async () => {
    await fs.writeFile(path.join(externalSpaceDir, 'doc.md'), 'old text', 'utf8');
    const result = await executeBuiltinTool(
      'Edit',
      { file_path: path.join(spaceSymlink, 'doc.md'), old_str: 'old text', new_str: 'new text' },
      ctxWithSpaceTargets(),
    );
    expect(result.isError).toBe(false);
    const updated = await fs.readFile(path.join(externalSpaceDir, 'doc.md'), 'utf8');
    expect(updated).toBe('new text');
  });

  it('Write is REJECTED through a Space symlink when allowedSymlinkTargets is not set', async () => {
    const target = path.join(spaceSymlink, 'blocked.md');
    const result = await executeBuiltinTool(
      'Write',
      { file_path: target, content: 'should fail' },
      ctxWithoutSpaceTargets(),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/symbolic link|outside allowed zones|realpath/i);
    expect(fsSync.existsSync(path.join(externalSpaceDir, 'blocked.md'))).toBe(false);
  });

  it('Space symlink targets do not grant access to unrelated external paths', async () => {
    // Create a symlink to a completely different external dir
    const unrelatedDir = path.join(fakeHome, 'SensitiveData');
    await fs.mkdir(unrelatedDir, { recursive: true });
    await fs.writeFile(path.join(unrelatedDir, 'secret.txt'), 'TOP_SECRET', 'utf8');
    const evilLink = path.join(workspaceRoot, 'evil-space');
    await fs.symlink(unrelatedDir, evilLink, 'dir');

    const result = await executeBuiltinTool(
      'Read',
      { file_path: path.join(evilLink, 'secret.txt') },
      ctxWithSpaceTargets(), // allowedSymlinkTargets only has externalSpaceDir
    );
    expect(result.isError).toBe(true);
    expect(result.output).not.toContain('TOP_SECRET');
  });
});

/**
 * rebel-system workspace symlink tests — verifies that Read/Edit through
 * the system-installed `<workspace>/rebel-system/` symlink succeed when the
 * bundled rebel-system path is included in allowedSymlinkTargets, and fail
 * (i.e. the broader symlink-escape protection still works) when it is not.
 *
 * The real Rebel app populates allowedSymlinkTargets with:
 * - User-configured Space sourcePaths
 * - The bundled rebel-system root from getSystemSettingsPath()
 *
 * This block proves the second entry actually unlocks Read/Edit through
 * `<workspace>/rebel-system/` while leaving the protection intact for any
 * other symlink that points outside the workspace.
 *
 * Regression for: 260420 build-custom-mcp-server self-block follow-up.
 * Bug introduced 2026-04-20 in commit b86fdba81; see
 * docs-private/postmortems/260420_mcp_write_sandbox_mismatch_postmortem.md.
 */
describe('builtin Read/Edit — rebel-system workspace symlink', () => {
  let fakeHome: string;
  let workspaceRoot: string;
  let bundledRebelSystemDir: string;
  let workspaceRebelSystemLink: string;
  let bundledSkillPath: string;

  beforeEach(async () => {
    fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-system-symlink-'));
    workspaceRoot = path.join(fakeHome, 'Documents', 'Rebel');
    // Bundled rebel-system: in dev a submodule clone, in prod
    // process.resourcesPath/rebel-system. Both live OUTSIDE the workspace.
    bundledRebelSystemDir = path.join(fakeHome, 'app-resources', 'rebel-system');
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.mkdir(
      path.join(bundledRebelSystemDir, 'skills', 'coding', 'build-custom-mcp-server'),
      { recursive: true },
    );
    bundledSkillPath = path.join(
      bundledRebelSystemDir,
      'skills',
      'coding',
      'build-custom-mcp-server',
      'SKILL.md',
    );
    await fs.writeFile(bundledSkillPath, '# SKILL — bundled body', 'utf8');

    // System-managed symlink mirroring the one createLibrarySymlink installs.
    workspaceRebelSystemLink = path.join(workspaceRoot, 'rebel-system');
    await fs.symlink(bundledRebelSystemDir, workspaceRebelSystemLink, 'dir');
  });

  afterEach(async () => {
    if (fakeHome && fsSync.existsSync(fakeHome)) {
      await fs.rm(fakeHome, { recursive: true, force: true });
    }
  });

  const ctxWithRebelSystemRoot = () => ({
    cwd: workspaceRoot,
    homePath: fakeHome,
    allowedSymlinkTargets: [bundledRebelSystemDir],
  });

  const ctxWithoutRebelSystemRoot = () => ({
    cwd: workspaceRoot,
    homePath: fakeHome,
  });

  it('Read SUCCEEDS through the rebel-system symlink when bundled root is in allowedSymlinkTargets', async () => {
    const target = path.join(
      workspaceRebelSystemLink,
      'skills',
      'coding',
      'build-custom-mcp-server',
      'SKILL.md',
    );
    const result = await executeBuiltinTool(
      'Read',
      { file_path: target },
      ctxWithRebelSystemRoot(),
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContain('SKILL — bundled body');
  });

  it('Read FAILS through the rebel-system symlink when bundled root is NOT in allowedSymlinkTargets', async () => {
    const target = path.join(
      workspaceRebelSystemLink,
      'skills',
      'coding',
      'build-custom-mcp-server',
      'SKILL.md',
    );
    const result = await executeBuiltinTool(
      'Read',
      { file_path: target },
      ctxWithoutRebelSystemRoot(),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/outside allowed zones|symbolic link|realpath/i);
  });

  it('Edit SUCCEEDS through the rebel-system symlink when bundled root is in allowedSymlinkTargets', async () => {
    const target = path.join(
      workspaceRebelSystemLink,
      'skills',
      'coding',
      'build-custom-mcp-server',
      'SKILL.md',
    );
    const result = await executeBuiltinTool(
      'Edit',
      { file_path: target, old_str: 'bundled body', new_str: 'edited body' },
      ctxWithRebelSystemRoot(),
    );
    expect(result.isError).toBe(false);
    const updated = await fs.readFile(bundledSkillPath, 'utf8');
    expect(updated).toBe('# SKILL — edited body');
  });

  it('Write through the rebel-system symlink succeeds when bundled root is in allowedSymlinkTargets', async () => {
    // Because `<workspace>/rebel-system/` is lexically inside cwd, resolveToolPath
    // (which only enforces the MCP-project filename allowlist for paths under
    // ~/mcp-servers/) accepts the path. verifyNoSymlinkEscape then accepts the
    // realpath because the bundled root is in allowedSymlinkTargets. This
    // mirrors how Space symlinks behave today and is intentional — skill
    // authoring and agent self-edits to bundled files require Write through
    // this symlink.
    const target = path.join(workspaceRebelSystemLink, 'authored-note.md');
    const result = await executeBuiltinTool(
      'Write',
      { file_path: target, content: 'agent-authored note' },
      ctxWithRebelSystemRoot(),
    );
    expect(result.isError).toBe(false);
    const written = await fs.readFile(
      path.join(bundledRebelSystemDir, 'authored-note.md'),
      'utf8',
    );
    expect(written).toBe('agent-authored note');
  });

  it('Write through the rebel-system symlink is REJECTED when bundled root is NOT in allowedSymlinkTargets', async () => {
    // Without the bundled root in allowedSymlinkTargets, verifyNoSymlinkEscape
    // catches the realpath escape and blocks the Write. Confirms the protection
    // still holds for foreign symlinks that happen to live inside cwd.
    const target = path.join(workspaceRebelSystemLink, 'blocked.md');
    const result = await executeBuiltinTool(
      'Write',
      { file_path: target, content: 'should not write' },
      ctxWithoutRebelSystemRoot(),
    );
    expect(result.isError).toBe(true);
    expect(fsSync.existsSync(path.join(bundledRebelSystemDir, 'blocked.md'))).toBe(false);
  });

  it('Adding the rebel-system root to allowedSymlinkTargets does not grant access to unrelated external paths', async () => {
    // Even when the rebel-system bundled root is trusted, an unrelated
    // symlink pointing somewhere else must still be rejected.
    const sensitiveDir = path.join(fakeHome, 'SensitiveData');
    await fs.mkdir(sensitiveDir, { recursive: true });
    await fs.writeFile(path.join(sensitiveDir, 'secret.txt'), 'TOP_SECRET', 'utf8');
    const evilLink = path.join(workspaceRoot, 'evil');
    await fs.symlink(sensitiveDir, evilLink, 'dir');

    const result = await executeBuiltinTool(
      'Read',
      { file_path: path.join(evilLink, 'secret.txt') },
      ctxWithRebelSystemRoot(), // only bundledRebelSystemDir is trusted
    );
    expect(result.isError).toBe(true);
    expect(result.output).not.toContain('TOP_SECRET');
  });
});

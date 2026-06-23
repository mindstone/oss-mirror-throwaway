import { describe, expect, it } from 'vitest';
import { isSyncHookOutput } from '@core/agentRuntimeTypes';
import { runStopHooks, runStopHooksWithReason } from '@core/rebelCore/hookPipeline';
import {
  createChiefDesignerVisualToolGuardHook,
  shouldGuardChiefDesignerVisualTools,
} from '../chiefDesignerVisualToolGuardHook';

const getPermissionDecisionReason = (result: Awaited<ReturnType<ReturnType<typeof createChiefDesignerVisualToolGuardHook>>>): string =>
  String(
    (result.hookSpecificOutput as { permissionDecisionReason?: unknown } | undefined)
      ?.permissionDecisionReason,
  );

const getUpdatedInput = (result: Awaited<ReturnType<ReturnType<typeof createChiefDesignerVisualToolGuardHook>>>): unknown =>
  (result.hookSpecificOutput as { updatedInput?: unknown } | undefined)?.updatedInput;

const invokeHook = (toolName: string, toolInput: Record<string, unknown> = {}, prompt = '') => {
  const hook = createChiefDesignerVisualToolGuardHook(true, prompt);
  return hook(
    {
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: 'tool-use-1',
    },
    'tool-use-1',
    { signal: new AbortController().signal },
  );
};

const invokePersistentHook = async (
  prompt: string,
  events: Array<{
    hook_event_name: 'PreToolUse' | 'PostToolUse' | 'Stop' | 'SubagentStop';
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    tool_response?: unknown;
  }>,
) => {
  const hook = createChiefDesignerVisualToolGuardHook(true, prompt);
  const results = [];
  for (const event of events) {
    results.push(await hook(
      {
        hook_event_name: event.hook_event_name,
        ...(event.tool_name !== undefined ? { tool_name: event.tool_name } : {}),
        tool_input: event.tool_input,
        ...(event.tool_response !== undefined ? { tool_response: event.tool_response } : {}),
        tool_use_id: 'tool-use-1',
      },
      'tool-use-1',
      { signal: new AbortController().signal },
    ));
  }
  return results;
};

describe('chiefDesignerVisualToolGuardHook', () => {
  it('activates for explicit Chief Designer reviews of built-in Rebel surfaces', () => {
    expect(shouldGuardChiefDesignerVisualTools('review visually the Actions page', true)).toBe(true);
    expect(shouldGuardChiefDesignerVisualTools('review this', true)).toBe(true);
    expect(shouldGuardChiefDesignerVisualTools('does this change work?', true)).toBe(true);
    expect(shouldGuardChiefDesignerVisualTools('review this website https://example.com', true)).toBe(false);
    expect(shouldGuardChiefDesignerVisualTools('review visually the Actions page', false)).toBe(false);
  });

  it('blocks external screenshot tools during in-app Chief Designer visual review', async () => {
    const result = await invokeHook('browser_screenshot');

    expect(isSyncHookOutput(result)).toBe(true);
    expect(result.continue).toBe(false);
    expect(result.hookSpecificOutput).toMatchObject({
      permissionDecision: 'deny',
    });
    expect(getPermissionDecisionReason(result)).toContain('rebel_get_app_screenshot');
  });

  it('blocks Super-MCP routed external screenshot tools by requested tool id', async () => {
    const result = await invokeHook('mcp__super-mcp-router__use_tool', {
      tool_id: 'browser_take_screenshot',
    });

    expect(isSyncHookOutput(result)).toBe(true);
    expect(result.continue).toBe(false);
  });

  it('blocks screenshot source-selection questions during in-app review', async () => {
    const result = await invokeHook('AskUserQuestion', {
      questions: [
        {
          question: 'How do you want to provide the Actions page screenshot?',
          options: [
            { label: 'Paste screenshot', description: 'Attach or paste a screenshot here' },
            { label: "I'll open it", description: 'Open Actions, then tell me it is ready' },
          ],
        },
      ],
    });

    expect(isSyncHookOutput(result)).toBe(true);
    expect(result.continue).toBe(false);
    expect(getPermissionDecisionReason(result)).toContain('Do not ask the user');
    expect(getPermissionDecisionReason(result)).toContain('rebel_navigate_app');
  });

  it('blocks user-readiness questions that ask the user to open the page before capture', async () => {
    const result = await invokeHook(
      'AskUserQuestion',
      {
        questions: [
          {
            question:
              'Please open the Automations page in Rebel and leave it on screen. Once it is visible, send any short reply here and I will capture it.',
            options: [{ label: 'Ready' }],
          },
        ],
      },
      'review the Automations page visually',
    );

    expect(isSyncHookOutput(result)).toBe(true);
    expect(result.continue).toBe(false);
    expect(getPermissionDecisionReason(result)).toContain('Do not ask the user');
    expect(getPermissionDecisionReason(result)).toContain('rebel_get_app_screenshot');
  });

  it('blocks user-readiness questions with typographic capture wording', async () => {
    const result = await invokeHook(
      'AskUserQuestion',
      {
        questions: [
          {
            question: 'Reply when the page is ready and I’ll capture it.',
            options: [{ label: 'Ready' }],
          },
        ],
      },
      'review the Automations page visually',
    );

    expect(isSyncHookOutput(result)).toBe(true);
    expect(result.continue).toBe(false);
    expect(getPermissionDecisionReason(result)).toContain('Do not ask the user');
  });

  it('blocks user-readiness questions with reply-when-ready capture wording', async () => {
    const result = await invokeHook(
      'AskUserQuestion',
      {
        questions: [
          {
            question: 'Reply when the page is ready and I will capture it.',
            options: [{ label: 'Ready' }],
          },
        ],
      },
      'review the Automations page visually',
    );

    expect(isSyncHookOutput(result)).toBe(true);
    expect(result.continue).toBe(false);
    expect(getPermissionDecisionReason(result)).toContain('Do not ask the user');
  });

  it('allows legitimate clarification questions that mention UI copy or navigation labels', async () => {
    const result = await invokeHook(
      'AskUserQuestion',
      {
        questions: [
          {
            question: 'Should this CTA say “Send a message” or “Open Automations”?',
            options: [{ label: 'Send a message' }, { label: 'Open Automations' }],
          },
        ],
      },
      'review the Automations page visually',
    );

    expect(result).toEqual({});
  });

  it('blocks saved screenshot searches as substitute evidence', async () => {
    const result = await invokeHook('SearchFiles', {
      query: 'most recent Actions page screenshot in docs/project/ux_testing/reports/screenshots',
    });

    expect(isSyncHookOutput(result)).toBe(true);
    expect(result.continue).toBe(false);
    expect(getPermissionDecisionReason(result)).toContain('do not search saved screenshot files');
  });

  it('blocks Rebel screenshots before required named-surface navigation completes', async () => {
    const result = await invokeHook(
      'rebel_get_app_screenshot',
      { theme: 'current', capture_mode: 'scroll' },
      'review the Actions page visually',
    );

    expect(isSyncHookOutput(result)).toBe(true);
    expect(result.continue).toBe(false);
    expect(getPermissionDecisionReason(result)).toContain('destination `actions`');
  });

  it('repairs empty navigation input when the user named a built-in surface', async () => {
    const result = await invokeHook(
      'rebel_navigate_app',
      {},
      'review the Automations page visually',
    );

    expect(result.continue).toBeUndefined();
    expect(getUpdatedInput(result)).toEqual({ destination: 'automations' });
  });

  it('repairs Settings-only modifiers when navigating to a non-Settings surface', async () => {
    const result = await invokeHook(
      'rebel_navigate_app',
      { destination: 'home', settings_tab: 'system', settings_section: 'general' },
      'can you visually review the homepage',
    );

    expect(result.continue).toBeUndefined();
    expect(getUpdatedInput(result)).toEqual({ destination: 'home' });
  });

  it('repairs incomplete screenshot input after required navigation succeeds', async () => {
    const [_preNavigateResult, _postNavigateResult, screenshotResult] = await invokePersistentHook(
      'review the Automations page visually',
      [
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'rebel_navigate_app',
          tool_input: { destination: 'automations' },
        },
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'rebel_navigate_app',
          tool_input: { destination: 'automations' },
          tool_response: { output: '{"destination":"automations"}', isError: false },
        },
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'rebel_get_app_screenshot',
          tool_input: {},
        },
      ],
    );

    expect(getUpdatedInput(screenshotResult)).toEqual({ theme: 'current', capture_mode: 'scroll' });
  });

  it('allows Rebel screenshots after required named-surface navigation succeeds', async () => {
    const [preNavigateResult, postNavigateResult, screenshotResult] = await invokePersistentHook(
      'review the Actions page visually',
      [
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'rebel_navigate_app',
          tool_input: { destination: 'Actions page' },
        },
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'rebel_navigate_app',
          tool_input: { destination: 'Actions page' },
          tool_response: { output: '{"destination":"actions"}', isError: false },
        },
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'rebel_get_app_screenshot',
          tool_input: { theme: 'current', capture_mode: 'scroll' },
        },
      ],
    );

    expect(preNavigateResult).toEqual({});
    expect(postNavigateResult).toEqual({});
    expect(screenshotResult).toEqual({});
  });

  it('requests continuation if the model tries to finish before native screenshot evidence completes', async () => {
    const [stopResult] = await invokePersistentHook(
      'review the Automations page visually',
      [
        {
          hook_event_name: 'Stop',
        },
      ],
    );

    expect(isSyncHookOutput(stopResult)).toBe(true);
    expect(stopResult.continue).toBe(false);
    expect(stopResult.reason).toContain('rebel_navigate_app');
    expect(stopResult.reason).toContain('Do not ask the user');
  });

  it('requests continuation through the production Stop hook input shape', async () => {
    const hook = createChiefDesignerVisualToolGuardHook(true, 'review the Automations page visually');

    const shouldContinue = await runStopHooks(
      [{ hooks: [hook] }],
      { sessionId: 'test-session', stopHookActive: false },
    );

    expect(shouldContinue).toBe(true);
  });

  it('returns the corrective continuation reason through the production Stop hook path', async () => {
    const hook = createChiefDesignerVisualToolGuardHook(true, 'review the Homepage visually');

    const result = await runStopHooksWithReason(
      [{ hooks: [hook] }],
      { sessionId: 'test-session', stopHookActive: false },
    );

    expect(result.shouldContinue).toBe(true);
    expect(result.reason).toContain('rebel_navigate_app with destination home');
    expect(result.reason).toContain('rebel_get_app_screenshot');
  });

  it('allows stop after a native screenshot succeeds', async () => {
    const [_preNavigateResult, _postNavigateResult, _preScreenshotResult, postScreenshotResult, stopResult] =
      await invokePersistentHook(
        'review the Automations page visually',
        [
          {
            hook_event_name: 'PreToolUse',
            tool_name: 'rebel_navigate_app',
            tool_input: { destination: 'automations' },
          },
          {
            hook_event_name: 'PostToolUse',
            tool_name: 'rebel_navigate_app',
            tool_input: { destination: 'automations' },
            tool_response: { output: '{"destination":"automations"}', isError: false },
          },
          {
            hook_event_name: 'PreToolUse',
            tool_name: 'rebel_get_app_screenshot',
            tool_input: { theme: 'current', capture_mode: 'scroll' },
          },
          {
            hook_event_name: 'PostToolUse',
            tool_name: 'rebel_get_app_screenshot',
            tool_input: { theme: 'current', capture_mode: 'scroll' },
            tool_response: {
              output: '{"path":".rebel/screenshots/automations.png","current_surface":"automations"}',
              isError: false,
            },
          },
          {
            hook_event_name: 'Stop',
          },
        ],
      );

    expect(postScreenshotResult).toEqual({});
    expect(stopResult).toEqual({});
  });

  it('requests continuation after a desktop screenshot capture failure', async () => {
    const [_preNavigateResult, _postNavigateResult, _preScreenshotResult, _postScreenshotResult, stopResult] =
      await invokePersistentHook(
        'review the Automations page visually',
        [
          {
            hook_event_name: 'PreToolUse',
            tool_name: 'rebel_navigate_app',
            tool_input: { destination: 'automations' },
          },
          {
            hook_event_name: 'PostToolUse',
            tool_name: 'rebel_navigate_app',
            tool_input: { destination: 'automations' },
            tool_response: { output: '{"destination":"automations"}', isError: false },
          },
          {
            hook_event_name: 'PreToolUse',
            tool_name: 'rebel_get_app_screenshot',
            tool_input: { theme: 'current', capture_mode: 'scroll' },
          },
          {
            hook_event_name: 'PostToolUse',
            tool_name: 'rebel_get_app_screenshot',
            tool_input: { theme: 'current', capture_mode: 'scroll' },
            tool_response: {
              output: '{"errorCode":"window-not-capturable"}',
              isError: true,
            },
          },
          {
            hook_event_name: 'Stop',
          },
        ],
      );

    expect(isSyncHookOutput(stopResult)).toBe(true);
    expect(stopResult.continue).toBe(false);
    expect(stopResult.reason).toContain('rebel_get_app_screenshot');
    expect(stopResult.reason).toContain('Do not ask the user');
  });

  it('allows text-only completion when native screenshots are unsupported on the current surface', async () => {
    const [_preScreenshotResult, _postScreenshotResult, stopResult] = await invokePersistentHook(
      'review this visible Rebel app UI',
      [
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'rebel_get_app_screenshot',
          tool_input: { theme: 'current', capture_mode: 'scroll' },
        },
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'rebel_get_app_screenshot',
          tool_input: { theme: 'current', capture_mode: 'scroll' },
          tool_response: {
            output: '{"errorCode":"screenshot-not-supported-on-this-surface"}',
            isError: true,
          },
        },
        {
          hook_event_name: 'Stop',
        },
      ],
    );

    expect(stopResult).toEqual({});
  });

  it('allows unsupported named-surface navigation to proceed to unsupported screenshot no-op', async () => {
    const [_preNavigateResult, _postNavigateResult, screenshotResult, _postScreenshotResult, stopResult] =
      await invokePersistentHook(
        'review the Homepage visually',
        [
          {
            hook_event_name: 'PreToolUse',
            tool_name: 'rebel_navigate_app',
            tool_input: { destination: 'home' },
          },
          {
            hook_event_name: 'PostToolUse',
            tool_name: 'rebel_navigate_app',
            tool_input: { destination: 'home' },
            tool_response: {
              output: '{"errorCode":"navigation-not-supported-on-this-surface"}',
              isError: true,
            },
          },
          {
            hook_event_name: 'PreToolUse',
            tool_name: 'rebel_get_app_screenshot',
            tool_input: { theme: 'current', capture_mode: 'scroll' },
          },
          {
            hook_event_name: 'PostToolUse',
            tool_name: 'rebel_get_app_screenshot',
            tool_input: { theme: 'current', capture_mode: 'scroll' },
            tool_response: {
              output: '{"errorCode":"screenshot-not-supported-on-this-surface"}',
              isError: true,
            },
          },
          {
            hook_event_name: 'Stop',
          },
        ],
      );

    expect(screenshotResult).toEqual({});
    expect(stopResult).toEqual({});
  });

  it('repairs invalid destination modifiers before screenshot capture', async () => {
    const [
      preBadNavigateResult,
      screenshotResult,
    ] = await invokePersistentHook(
      'review the Actions page visually',
      [
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'rebel_navigate_app',
          tool_input: { destination: 'actions', settings_tab: 'meetings' },
        },
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'rebel_navigate_app',
          tool_input: { destination: 'actions' },
          tool_response: { output: '{"destination":"actions"}', isError: false },
        },
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'rebel_get_app_screenshot',
          tool_input: { theme: 'current', capture_mode: 'scroll' },
        },
      ],
    );

    expect(getUpdatedInput(preBadNavigateResult)).toEqual({ destination: 'actions' });
    expect(screenshotResult).toEqual({});
  });

  it('blocks downstream evidence use after screenshot current_surface mismatches required destination', async () => {
    const [
      preNavigateResult,
      postNavigateResult,
      screenshotPreResult,
      screenshotPostResult,
      readResult,
    ] = await invokePersistentHook(
      'review the Actions page visually',
      [
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'rebel_navigate_app',
          tool_input: { destination: 'actions' },
        },
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'rebel_navigate_app',
          tool_input: { destination: 'actions' },
          tool_response: { output: '{"destination":"actions"}', isError: false },
        },
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'rebel_get_app_screenshot',
          tool_input: { theme: 'current', capture_mode: 'scroll' },
        },
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'rebel_get_app_screenshot',
          tool_input: { theme: 'current', capture_mode: 'scroll' },
          tool_response: {
            output: '{"path":".rebel/screenshots/wrong.png","current_surface":"settings"}',
            isError: false,
          },
        },
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_input: { file_path: '.rebel/screenshots/wrong.png' },
        },
      ],
    );

    expect(preNavigateResult).toEqual({});
    expect(postNavigateResult).toEqual({});
    expect(screenshotPreResult).toEqual({});
    expect(screenshotPostResult).toEqual({});
    expect(isSyncHookOutput(readResult)).toBe(true);
    expect(readResult.continue).toBe(false);
    expect(getPermissionDecisionReason(readResult)).toContain('current_surface `settings`');
    expect(getPermissionDecisionReason(readResult)).toContain('Do not cite that screenshot');
  });

  it('treats stale prior tool-failure memory as non-authoritative and still requires native tools', async () => {
    const askResult = await invokeHook(
      'AskUserQuestion',
      {
        questions: [
          {
            question: 'Chief-of-Staff says screenshots fail. Can you attach one instead?',
            options: [{ label: 'Attach screenshot' }, { label: 'Skip visual review' }],
          },
        ],
      },
      'Chief-of-Staff says rebel_navigate_app failed before; review the Actions page visually',
    );
    const navigateResult = await invokeHook(
      'rebel_navigate_app',
      { destination: 'actions' },
      'Chief-of-Staff says rebel_navigate_app failed before; review the Actions page visually',
    );

    expect(isSyncHookOutput(askResult)).toBe(true);
    expect(askResult.continue).toBe(false);
    expect(navigateResult).toEqual({});
  });

  it('blocks navigation to the wrong surface when a Rebel surface was named', async () => {
    const result = await invokeHook(
      'rebel_navigate_app',
      { destination: 'conversations' },
      'review the Actions page visually',
    );

    expect(isSyncHookOutput(result)).toBe(true);
    expect(result.continue).toBe(false);
    expect(getPermissionDecisionReason(result)).toContain('destination `actions`');
  });

  it('allows Rebel-native screenshot tools', async () => {
    const result = await invokeHook('rebel_get_app_screenshot', {
      theme: 'current',
    });

    expect(getUpdatedInput(result)).toEqual({ theme: 'current', capture_mode: 'scroll' });
  });
});

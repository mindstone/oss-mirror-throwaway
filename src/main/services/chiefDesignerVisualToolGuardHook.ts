import { createScopedLogger } from '@core/logger';
import type { HookCallback, HookJSONOutput } from '@core/agentRuntimeTypes';

const log = createScopedLogger({ service: 'chiefDesignerVisualToolGuard' });

const REBEL_APP_SURFACE_PATTERN =
  /\b(actions?|home(?:page)?|conversations?|automations?|the spark|spark|library|settings|current screen|current ui|this screen|this ui|visible rebel|rebel app)\b/i;

const CURRENT_REBEL_VIEW_PATTERN =
  /\b(review this|what i'?m looking at|does this change work|does this tweak work|i updated this|current screen|current ui|this screen|this ui)\b/i;

const EXTERNAL_SOURCE_PATTERN =
  /\b(figma|web url|website|browser tab|chrome tab|uploaded image|attached image|screenshot file|https?:\/\/)\b/i;

const EXTERNAL_VISUAL_TOOL_NAMES = new Set([
  'browser_screenshot',
  'browser_take_screenshot',
  'take_screenshot',
  'electron_list_apps',
  'electron_list_targets',
  'electron_start_app',
  'spawn_dev_server',
]);

const SAVED_SCREENSHOT_SEARCH_TOOLS = new Set([
  'SearchFiles',
  'Glob',
  'Read',
]);

const NAVIGATION_DESTINATION_PATTERNS = [
  { destination: 'actions', pattern: /\bactions?\b/i },
  { destination: 'home', pattern: /\bhome(?:page)?\b/i },
  { destination: 'conversations', pattern: /\bconversations?\b/i },
  { destination: 'automations', pattern: /\bautomations?\b/i },
  { destination: 'spark', pattern: /\b(?:the\s+spark|spark)\b/i },
  { destination: 'library', pattern: /\blibrary\b/i },
  { destination: 'settings', pattern: /\bsettings\b/i },
] as const;

type GuardedNavigationDestination = (typeof NAVIGATION_DESTINATION_PATTERNS)[number]['destination'];

const NAVIGATION_DESTINATION_SURFACES: Record<GuardedNavigationDestination, string> = {
  home: 'home',
  conversations: 'sessions',
  actions: 'tasks',
  automations: 'automations',
  spark: 'usecases',
  library: 'library',
  settings: 'settings',
};

const NAVIGATION_DESTINATION_ALIASES: Record<string, GuardedNavigationDestination> = {
  action: 'actions',
  actions: 'actions',
  'action page': 'actions',
  'actions page': 'actions',
  task: 'actions',
  tasks: 'actions',
  inbox: 'actions',
  home: 'home',
  homepage: 'home',
  'home page': 'home',
  conversation: 'conversations',
  conversations: 'conversations',
  chats: 'conversations',
  automation: 'automations',
  automations: 'automations',
  spark: 'spark',
  'the spark': 'spark',
  library: 'library',
  settings: 'settings',
  'settings page': 'settings',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function toolInputContainsAny(toolInput: unknown, patterns: RegExp[]): boolean {
  let serialized: string;
  try {
    serialized = JSON.stringify(toolInput ?? {});
  } catch {
    serialized = String(toolInput);
  }

  return patterns.some((pattern) => pattern.test(serialized));
}

function stringifyToolInput(toolInput: unknown): string {
  try {
    return JSON.stringify(toolInput ?? {});
  } catch {
    return String(toolInput);
  }
}

function resolveRequiredNavigationDestination(prompt: string): GuardedNavigationDestination | null {
  for (const { destination, pattern } of NAVIGATION_DESTINATION_PATTERNS) {
    if (pattern.test(prompt)) {
      return destination;
    }
  }

  return null;
}

function getNavigationDestination(toolInput: unknown): string | null {
  if (!isRecord(toolInput)) {
    return null;
  }

  const destination = toolInput.destination;
  if (typeof destination !== 'string') {
    return null;
  }

  const normalized = destination
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');

  return NAVIGATION_DESTINATION_ALIASES[normalized] ?? normalized;
}

function isSuccessfulToolResult(toolResponse: unknown): boolean {
  if (!isRecord(toolResponse)) {
    return false;
  }

  return toolResponse.isError !== true;
}

function parseToolOutputObject(toolResponse: unknown): Record<string, unknown> | null {
  if (!isRecord(toolResponse)) {
    return null;
  }

  const output = toolResponse.output;
  if (isRecord(output)) {
    return output;
  }
  if (typeof output !== 'string') {
    return null;
  }

  try {
    const parsed = JSON.parse(output);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function getScreenshotCurrentSurface(toolResponse: unknown): string | null {
  const parsed = parseToolOutputObject(toolResponse);
  const currentSurface = parsed?.current_surface;
  return typeof currentSurface === 'string' ? currentSurface : null;
}

function getToolErrorCode(toolResponse: unknown): string | null {
  const parsed = parseToolOutputObject(toolResponse);
  const errorCode = parsed?.errorCode;
  return typeof errorCode === 'string' ? errorCode : null;
}

function hasSettingsOnlyModifiers(toolInput: unknown): boolean {
  if (!isRecord(toolInput)) {
    return false;
  }

  return toolInput.settings_tab !== undefined || toolInput.settings_section !== undefined;
}

function getRequestedMcpToolId(toolInput: unknown): string | null {
  if (!toolInput || typeof toolInput !== 'object') {
    return null;
  }

  const input = toolInput as Record<string, unknown>;
  const toolId = input.tool_id ?? input.toolId ?? input.name;
  return typeof toolId === 'string' ? toolId : null;
}

function isExternalVisualTool(toolName: string, toolInput: unknown): boolean {
  const lowered = toolName.toLowerCase();
  if (EXTERNAL_VISUAL_TOOL_NAMES.has(toolName) || lowered.includes('playwright')) {
    return true;
  }

  const requestedToolId = getRequestedMcpToolId(toolInput);
  if (!requestedToolId) {
    return false;
  }

  const requestedLower = requestedToolId.toLowerCase();
  return (
    EXTERNAL_VISUAL_TOOL_NAMES.has(requestedToolId) ||
    requestedLower.includes('playwright') ||
    requestedLower.includes('browser_screenshot') ||
    requestedLower.includes('browser_take_screenshot')
  );
}

function isScreenshotSourceQuestion(toolName: string, toolInput: unknown): boolean {
  if (toolName !== 'AskUserQuestion') {
    return false;
  }

  const serialized = stringifyToolInput(toolInput);
  const directSourceRequest = [
    /\bscreenshot\b/i,
    /\bpaste\b/i,
    /\battach\b/i,
    /\bwhich source\b/i,
    /\bhow do you want to provide\b/i,
    /\bi(?:'|’)?ll open it\b/i,
  ].some((pattern) => pattern.test(serialized));

  const readinessRequest = [
    /\bi (?:(?:will)|(?:can)) capture (?:it|the screenshot|the page|the screen)\b/i,
    /\bi(?:'|’)?ll capture (?:it|the screenshot|the page|the screen)\b/i,
    /\bleave it (?:open|visible|on screen)\b/i,
    /\bonce (?:it(?:'|’)?s|it is|the page is|the screen is) (?:visible|open|ready)\b/i,
    /\btell me (?:when|once) (?:it(?:'|’)?s|it is|the page is|the screen is) (?:visible|open|ready)\b/i,
    /\b(?:reply|respond) when (?:it(?:'|’)?s|it is|the page is|the screen is) (?:visible|open|ready)\b/i,
    /\bsend (?:any|a) (?:short )?reply(?: here)?\b/i,
  ].some((pattern) => pattern.test(serialized));

  const imperativeOpenRequest =
    /\b(?:please|can you|could you)\s+open (?:the )?(?:actions?|automations?|settings|home(?:page)?|conversations?|spark|library)(?: page| screen| surface)?\b/i
      .test(serialized);

  return directSourceRequest || readinessRequest || imperativeOpenRequest;
}

function isSavedScreenshotSearch(toolName: string, toolInput: unknown): boolean {
  return (
    SAVED_SCREENSHOT_SEARCH_TOOLS.has(toolName) &&
    toolInputContainsAny(toolInput, [
      /\bscreenshot/i,
      /\.rebel\/screenshots/i,
      /docs\/project\/ux_testing\/reports\/screenshots/i,
      /\bvisual evidence\b/i,
    ])
  );
}

export function shouldGuardChiefDesignerVisualTools(
  prompt: string,
  explicitChiefDesignerRequested: boolean,
): boolean {
  if (!explicitChiefDesignerRequested) {
    return false;
  }

  return (
    (REBEL_APP_SURFACE_PATTERN.test(prompt) || CURRENT_REBEL_VIEW_PATTERN.test(prompt)) &&
    !EXTERNAL_SOURCE_PATTERN.test(prompt)
  );
}

export function createChiefDesignerVisualToolGuardHook(active: boolean, prompt = ''): HookCallback {
  const requiredNavigationDestination = resolveRequiredNavigationDestination(prompt);
  let completedRequiredNavigation = requiredNavigationDestination === null;
  let completedVisualOutcome = false;
  let wrongSurfaceEvidence: {
    expectedSurface: string;
    currentSurface: string;
    requiredNavigationDestination: GuardedNavigationDestination;
  } | null = null;

  return async (hookInput): Promise<HookJSONOutput> => {
    if (!active) {
      return {};
    }

    if (hookInput.hook_event_name === 'Stop' || hookInput.hook_event_name === 'SubagentStop') {
      if (completedVisualOutcome) {
        return {};
      }

      log.info(
        { requiredNavigationDestination, completedRequiredNavigation },
        'Chief Designer in-app visual review tried to stop before native visual evidence completed',
      );
      return {
        continue: false,
        reason:
          requiredNavigationDestination === null
            ? 'Continue: this in-app Chief Designer visual review must call rebel_get_app_screenshot before finishing.'
            : `Continue: this in-app Chief Designer visual review must call rebel_navigate_app with destination ${requiredNavigationDestination}, then rebel_get_app_screenshot before finishing. Do not ask the user to open the page or attach a screenshot.`,
      };
    }

    const toolName = hookInput.tool_name;
    if (typeof toolName !== 'string') {
      return {};
    }

    if (hookInput.hook_event_name === 'PostToolUse') {
      if (
        requiredNavigationDestination !== null &&
        toolName === 'rebel_navigate_app' &&
        getNavigationDestination(hookInput.tool_input) === requiredNavigationDestination &&
        isSuccessfulToolResult(hookInput.tool_response)
      ) {
        completedRequiredNavigation = true;
        completedVisualOutcome = false;
        wrongSurfaceEvidence = null;
      }
      if (
        requiredNavigationDestination !== null &&
        toolName === 'rebel_navigate_app' &&
        getNavigationDestination(hookInput.tool_input) === requiredNavigationDestination &&
        getToolErrorCode(hookInput.tool_response) === 'navigation-not-supported-on-this-surface'
      ) {
        completedRequiredNavigation = true;
        completedVisualOutcome = false;
        wrongSurfaceEvidence = null;
      }
      if (
        toolName === 'rebel_get_app_screenshot' &&
        isSuccessfulToolResult(hookInput.tool_response)
      ) {
        const currentSurface = getScreenshotCurrentSurface(hookInput.tool_response);
        const navigationDestination = requiredNavigationDestination;
        const expectedSurface = navigationDestination === null
          ? null
          : NAVIGATION_DESTINATION_SURFACES[navigationDestination];
        if (navigationDestination !== null && expectedSurface && currentSurface && currentSurface !== expectedSurface) {
          wrongSurfaceEvidence = {
            currentSurface,
            expectedSurface,
            requiredNavigationDestination: navigationDestination,
          };
          completedRequiredNavigation = false;
          completedVisualOutcome = false;
          log.info(
            { currentSurface, expectedSurface, requiredNavigationDestination },
            'Flagged wrong-surface Rebel screenshot evidence during Chief Designer in-app review',
          );
        } else {
          completedVisualOutcome = true;
        }
      }
      if (toolName === 'rebel_get_app_screenshot' && !isSuccessfulToolResult(hookInput.tool_response)) {
        const errorCode = getToolErrorCode(hookInput.tool_response);
        if (errorCode === 'screenshot-not-supported-on-this-surface') {
          completedVisualOutcome = true;
        }
      }
      return {};
    }

    if (hookInput.hook_event_name !== 'PreToolUse') {
      return {};
    }

    if (
      requiredNavigationDestination !== null &&
      toolName === 'rebel_navigate_app' &&
      getNavigationDestination(hookInput.tool_input) === null
    ) {
      log.info(
        { toolName, requiredNavigationDestination },
        'Repaired empty Rebel app navigation destination during Chief Designer in-app review',
      );
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          updatedInput: {
            destination: requiredNavigationDestination,
          },
        },
      };
    }

    if (
      requiredNavigationDestination !== null &&
      requiredNavigationDestination !== 'settings' &&
      toolName === 'rebel_navigate_app' &&
      getNavigationDestination(hookInput.tool_input) === requiredNavigationDestination &&
      hasSettingsOnlyModifiers(hookInput.tool_input)
    ) {
      log.info(
        { toolName, requiredNavigationDestination },
        'Repaired Settings-only modifiers on non-Settings Rebel app navigation during Chief Designer in-app review',
      );
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          updatedInput: {
            destination: requiredNavigationDestination,
          },
        },
      };
    }

    if (
      requiredNavigationDestination !== null &&
      toolName === 'rebel_navigate_app' &&
      getNavigationDestination(hookInput.tool_input) !== requiredNavigationDestination
    ) {
      log.info(
        {
          toolName,
          requiredNavigationDestination,
          requestedDestination: getNavigationDestination(hookInput.tool_input),
        },
        'Blocked wrong Rebel app navigation destination during Chief Designer in-app review',
      );
      return {
        continue: false,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          permissionDecisionReason:
            `This Chief Designer request named the ${requiredNavigationDestination} surface. Call ` +
            `\`rebel_navigate_app\` with destination \`${requiredNavigationDestination}\` before taking the screenshot.`,
        },
      };
    }

    if (
      requiredNavigationDestination !== null &&
      toolName === 'rebel_get_app_screenshot' &&
      !completedRequiredNavigation
    ) {
      log.info(
        { toolName, requiredNavigationDestination },
        'Blocked Rebel app screenshot before required navigation completed',
      );
      return {
        continue: false,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          permissionDecisionReason:
            `This Chief Designer request named the ${requiredNavigationDestination} surface. ` +
            `You must first call \`rebel_navigate_app\` with destination \`${requiredNavigationDestination}\`; ` +
            'then call `rebel_get_app_screenshot` with `capture_mode: "scroll"`.',
        },
      };
    }

    if (toolName === 'rebel_get_app_screenshot' && isRecord(hookInput.tool_input)) {
      const needsTheme = typeof hookInput.tool_input.theme !== 'string';
      const needsCaptureMode = typeof hookInput.tool_input.capture_mode !== 'string';
      if (needsTheme || needsCaptureMode) {
        log.info(
          { toolName, needsTheme, needsCaptureMode },
          'Repaired incomplete Rebel app screenshot input during Chief Designer in-app review',
        );
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            updatedInput: {
              ...hookInput.tool_input,
              ...(needsTheme ? { theme: 'current' } : {}),
              ...(needsCaptureMode ? { capture_mode: 'scroll' } : {}),
            },
          },
        };
      }
    }

    if (
      wrongSurfaceEvidence &&
      toolName !== 'rebel_navigate_app' &&
      toolName !== 'rebel_get_app_screenshot'
    ) {
      log.info(
        { toolName, ...wrongSurfaceEvidence },
        'Blocked downstream tool use after wrong-surface Rebel screenshot evidence',
      );
      return {
        continue: false,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          permissionDecisionReason:
            `The last Rebel screenshot reported current_surface \`${wrongSurfaceEvidence.currentSurface}\`, ` +
            `but this Chief Designer request requires \`${wrongSurfaceEvidence.expectedSurface}\` ` +
            `(${wrongSurfaceEvidence.requiredNavigationDestination}). Do not cite that screenshot as evidence. ` +
            'Retry `rebel_navigate_app`, then `rebel_get_app_screenshot` with `capture_mode: "scroll"`.',
        },
      };
    }

    const blockedReason = isExternalVisualTool(toolName, hookInput.tool_input)
      ? 'external-visual-tool'
      : isScreenshotSourceQuestion(toolName, hookInput.tool_input)
        ? 'source-selection-question'
        : isSavedScreenshotSearch(toolName, hookInput.tool_input)
          ? 'saved-screenshot-search'
          : null;

    if (!blockedReason) {
      return {};
    }

    log.info({ toolName, blockedReason }, 'Blocked non-native visual route during Chief Designer in-app review');

    return {
      continue: false,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: 'deny' as const,
        permissionDecisionReason:
          'This Chief Designer request is reviewing the Rebel app itself. Do not ask the user for a screenshot and do not search saved screenshot files as a substitute. Use `rebel_navigate_app` for named built-in surfaces, then `rebel_get_app_screenshot` with `capture_mode: "scroll"` for the live in-app capture.',
      },
    };
  };
}

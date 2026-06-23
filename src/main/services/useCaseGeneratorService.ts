import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import type { AgentEvent, AppSettings, PersonalizedUseCase } from '@shared/types';
import { getErrorKind, type AgentErrorKind } from '@shared/utils/agentErrorCatalog';
import { CODEX_CONNECTIVITY_UNKNOWN } from '@core/rebelCore/codexConnectivity';
import { ENV_EXECUTION_MODEL, resolveModelConfig, planModeTargetFromThinkingModel } from '@shared/utils/modelNormalization';
import { createScopedLogger, createTurnSessionLogger } from '@core/logger';
import { getSystemSettingsPath } from './systemSettingsSync';
import { getAuthForDirectUse, hasValidAuth, isDirectAnthropicConfig } from '@core/utils/authEnvUtils';
import { callBehindTheScenesWithAuth } from './behindTheScenesClient';
import {
  addUseCase,
  forceAddUseCase,
  importFromSettings,
  needsMigration,
  type UseCaseCandidate
} from './useCaseLibraryStore';
import { calculateCostOrWarn } from '@shared/utils/pricingCalculator';
import { appendCostEntry } from './costLedgerService';
import { humanizeAgentError } from '@rebel/shared';
import { ModelError } from '@core/rebelCore/modelErrors';
import { createAnthropicSdkClientForDirectPlan } from '@core/rebelCore/clients/anthropicClient';
import { ensureDirectAnthropicCapable } from '@core/rebelCore/ensureDirectAnthropicCapable';
import { resolveProviderRoutePlan, type ProviderRouteSettings } from '@core/rebelCore/providerRouting';
import { getApiKey, getCurrentModel, getExtendedContext, getThinkingModel } from '@core/rebelCore/settingsAccessors';
import { getDefaultModelForProvider } from '@shared/utils/getDefaultModelForProvider';

const log = createScopedLogger({ service: 'useCaseGenerator' });

// =============================================================================
// Dependency Injection (similar to memoryUpdateService)
// =============================================================================

export type UseCaseGeneratorDeps = {
  executeAgentTurn: (
    turnId: string,
    prompt: string,
    options: { sessionId: string; onEvent: (event: AgentEvent) => void }
  ) => Promise<void>;
  getActiveTurnController: (turnId: string) => AbortController | undefined;
  getSettings: () => AppSettings;
};

let deps: UseCaseGeneratorDeps | null = null;

export const initializeUseCaseGeneratorService = (dependencies: UseCaseGeneratorDeps): void => {
  deps = dependencies;
  log.info('Use case generator service initialized');
};

// Phase 1: Agentic data crawling with sub-agents (needs more time for MCP calls)
const AGENTIC_PHASE_TIMEOUT_MS = 600000; // 10 minutes
// Phase 2: Simple text-to-JSON formatting (quick)
const FORMATTING_PHASE_TIMEOUT_MS = 30000; // 30 seconds
const SKILL_PATH = 'rebel-system/skills/operations/rebel-os-use-case-finder/SKILL.md';

// Note: Anthropic API requires additionalProperties: false on all object types
export const USE_CASE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    user_first_name: {
      type: 'string',
      description: "The user's first name as discovered from their email 'From' field, signature, or profile. If not found, use null."
    },
    user_email: {
      type: 'string',
      description: "The user's email address as discovered from their sent email 'From' field. If not found, use null."
    },
    use_cases: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Clear, action-oriented title (5-8 words). Specific names optional.'
          },
          description: {
            type: 'string',
            description:
              'One sentence (max 30 words) using "like" before 2-3 specific examples (e.g., "deals like Acme, BigCorp") and mentioning data sources used.'
          },
          prompt: {
            type: 'string',
            description: 'The full prompt the user would send to start this use case'
          },
          icon: {
            type: 'string',
            description: 'Single emoji that represents this use case'
          }
        },
        required: ['title', 'description', 'prompt', 'icon'],
        additionalProperties: false
      },
      // Anthropic structured output only supports minItems 0 or 1, and rejects
      // maxItems on array fields entirely (400: "property 'maxItems' is not
      // supported"). The exact count is enforced via the prompt instead. (REBEL-66V)
      minItems: 1
    }
  },
  required: ['use_cases'],
  additionalProperties: false
};

export interface UseCaseGenerationResult {
  success: boolean;
  useCases?: PersonalizedUseCase[];
  userFirstName?: string;
  userEmail?: string;
  error?: string;
  errorKind?: AgentErrorKind;
}

async function readSkillFile(coreDirectory: string): Promise<string> {
  const workspacePath = path.join(coreDirectory, SKILL_PATH);
  
  // Try workspace path first (when symlink exists)
  try {
    const realPath = await fs.realpath(workspacePath);
    const content = await fs.readFile(realPath, 'utf-8');
    return content;
  } catch {
    // Fallback to bundled system settings path (for fresh installs before symlink exists)
    const bundledPath = path.join(getSystemSettingsPath(), 'skills/operations/rebel-os-use-case-finder/SKILL.md');
    try {
      const content = await fs.readFile(bundledPath, 'utf-8');
      log.debug({ bundledPath }, 'Read skill file from bundled path (workspace symlink not yet created)');
      return content;
    } catch (error) {
      log.warn({ workspacePath, bundledPath, error }, 'Failed to read use case skill file from both paths');
      throw new Error(`Could not read skill file at ${SKILL_PATH}`);
    }
  }
}

export interface GenerateUseCasesOptions {
  /** If provided, skip Phase 1 (agentic discovery) and use this output directly for Phase 2 parsing */
  existingSessionOutput?: string;
}

export async function generatePersonalizedUseCases(
  settings?: AppSettings,
  options?: GenerateUseCasesOptions
): Promise<UseCaseGenerationResult> {
  // Use injected settings if available, otherwise use passed settings
  const effectiveSettings = settings ?? deps?.getSettings();
  
  if (!effectiveSettings) {
    return { success: false, error: 'Settings not available' };
  }

  if (!effectiveSettings.coreDirectory) {
    return { success: false, error: 'Workspace directory not configured' };
  }

  if (!hasValidAuth(effectiveSettings)) {
    return { success: false, error: 'Claude API key not configured' };
  }

  let skillContent: string;
  try {
    skillContent = await readSkillFile(effectiveSettings.coreDirectory);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to read skill file'
    };
  }

  // =========================================================================
  // PHASE 1: Agentic data crawling via full agent turn loop
  // Benefits: full system prompt, MCP servers, session logging, event dispatching
  // Can be skipped if existingSessionOutput is provided (e.g., from visible onboarding session)
  // =========================================================================
  
  let agentOutput = options?.existingSessionOutput ?? '';
  
  // Skip Phase 1 if we already have output from an existing session
  if (agentOutput) {
    log.info({ outputLength: agentOutput.length }, 'Phase 1: Skipped - using existing session output');
  } else if (deps) {
    // Use the full agent turn infrastructure — capture deps locally so TS narrows through async
    const localDeps = deps;
    const turnId = randomUUID();
    const sessionId = `use-case-discovery-${turnId}`;
    
    log.info({ turnId }, 'Phase 1: Starting agentic use case discovery via executeAgentTurn');
    
    // Set up timeout to abort the turn
    const phase1Timeout = setTimeout(() => {
      log.warn({ turnId }, 'Phase 1: Timeout reached, aborting turn');
      deps?.getActiveTurnController(turnId)?.abort();
    }, AGENTIC_PHASE_TIMEOUT_MS);
    
    // Collect result via Promise wrapper around event callback
    const phase1Result = await new Promise<{ success: boolean; output?: string; error?: string }>((resolve) => {
      let resultText = '';
      let errorMessage = '';
      
      const onEvent = (event: AgentEvent) => {
        if (event.type === 'assistant' && 'text' in event) {
          resultText = event.text;
        } else if (event.type === 'result') {
          resultText = event.text || resultText;
          clearTimeout(phase1Timeout);
          resolve({ success: true, output: resultText });
        } else if (event.type === 'error') {
          errorMessage = event.error;
          clearTimeout(phase1Timeout);
          resolve({ success: false, error: errorMessage });
        }
      };
      
      localDeps.executeAgentTurn(turnId, skillContent, { sessionId, onEvent })
        .catch((error) => {
          clearTimeout(phase1Timeout);
          const errMsg = error instanceof Error ? error.message : 'Use case discovery failed';
          // Check if it was a timeout abort
          if (errMsg.includes('abort') || errMsg.includes('cancel')) {
            resolve({ success: false, error: 'Use case discovery timed out' });
          } else {
            resolve({ success: false, error: errMsg });
          }
        });
    });
    
    if (!phase1Result.success) {
      log.warn({ error: phase1Result.error }, 'Phase 1: Use case discovery failed');
      return { success: false, error: phase1Result.error ?? 'Use case discovery failed' };
    }
    
    agentOutput = phase1Result.output ?? '';
    log.info({ outputLength: agentOutput.length }, 'Phase 1: Agentic discovery completed via executeAgentTurn');
    
  } else {
    // Fallback: behind-the-scenes call (for backwards compatibility or if deps not initialized)
    log.warn('Phase 1: Running without executeAgentTurn (deps not initialized) - session logging will be limited');

    const phase1AbortController = new AbortController();
    const phase1Timeout = setTimeout(() => phase1AbortController.abort(), AGENTIC_PHASE_TIMEOUT_MS);

    try {
      log.info('Phase 1: Starting agentic use case discovery (fallback mode)');

      const response = await callBehindTheScenesWithAuth(
        effectiveSettings,
        {
          messages: [{ role: 'user', content: skillContent }],
          maxTokens: 4096,
          timeout: AGENTIC_PHASE_TIMEOUT_MS,
          signal: phase1AbortController.signal,
        },
        { category: 'useCaseDiscovery' }
      );

      agentOutput = response.content
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text?.trim() ?? '')
        .filter(Boolean)
        .join('\n');
    } catch (error) {
      if (phase1AbortController.signal.aborted) {
        log.warn('Phase 1: Use case discovery timed out');
        return { success: false, error: 'Use case discovery timed out' };
      }

      log.error({ error }, 'Phase 1: Use case discovery failed');
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Use case discovery failed'
      };
    } finally {
      clearTimeout(phase1Timeout);
    }
    
    log.info({ outputLength: agentOutput.length }, 'Phase 1: Agentic discovery completed (fallback mode)');
  }

  if (!agentOutput || agentOutput.trim().length === 0) {
    log.warn('Phase 1: Agent returned empty output');
    return { success: false, error: 'No use cases discovered from your data' };
  }

  // =========================================================================
  // PHASE 2: Format output into structured JSON (with session logging)
  // Simple text-to-JSON conversion using structured output
  // =========================================================================
  
  // Create session logger for Phase 2 debugging
  const phase2TurnId = randomUUID();
  const phase2SessionLogger = createTurnSessionLogger(
    { component: 'useCaseGenerator', operation: 'phase2-formatting' },
    { turnId: phase2TurnId, rendererSessionId: `use-case-formatting-${phase2TurnId}` }
  );
  
  phase2SessionLogger.info({ phase1OutputLength: agentOutput.length }, 'Phase 2: Starting structured JSON formatting');
  
  const phase2AbortController = new AbortController();
  const phase2Timeout = setTimeout(() => phase2AbortController.abort(), FORMATTING_PHASE_TIMEOUT_MS);

  const formattingPrompt = `Extract exactly 3 personalized use cases from the following analysis, and also identify the user's first name and email address.

USER'S FIRST NAME:
Look in the analysis for the user's first name. It typically appears in:
- The "From" field of their sent emails (e.g., "From: John Smith <[external-email]>")
- Email signatures
- Profile information
Extract just the first name (e.g., "John", not "John Smith"). If you cannot find it, use null.

USER'S EMAIL ADDRESS:
Look in the analysis for the user's email address. It typically appears in:
- The "From" field of their sent emails (e.g., "From: John Smith <[external-email]>" → "[external-email]")
- Email headers or account information
Extract the full email address. If you cannot find it, use null.

PERSONALIZATION REQUIREMENTS:

**Title**: Keep it clear and action-oriented (5-8 words). Specific names are optional but welcome if they fit naturally.

**Description**: This is where personalization MUST be obvious. The description should:
1. Use "like" before specific examples (e.g., "deals like Fairmont, Marino and Intragen") - this signals personalization without being limiting
2. Name 2-3 specific entities (people, companies, projects) discovered in the analysis
3. Mention which data sources are being used (emails, Slack, calendar, transcripts, etc.)

GOOD DESCRIPTION EXAMPLE:
"Track deals like Fairmont, Marino and Intragen to get daily status updates and follow-up reminders based on recent emails and Slack messages."

BAD DESCRIPTION EXAMPLE (too generic):
"Track your active deals and get follow-up reminders."

The user should read the description and immediately think "this was built specifically for me" because they recognize their own companies, projects, and tools.

ANALYSIS:
${agentOutput}

Return exactly 3 use cases with clear titles and richly personalized descriptions, plus the user's first name and email address.`;

  const phase2WorkingModel =
    getCurrentModel(effectiveSettings) ?? getDefaultModelForProvider(effectiveSettings, 'working');
  const phase2ModelConfig = resolveModelConfig(
    phase2WorkingModel,
    planModeTargetFromThinkingModel(getThinkingModel(effectiveSettings), phase2WorkingModel),
    getExtendedContext(effectiveSettings) ?? false
  );

  const phase2Model = phase2ModelConfig.envOverrides?.[ENV_EXECUTION_MODEL] ?? phase2ModelConfig.model;
  const auth = getAuthForDirectUse(effectiveSettings);

  // Active-provider guard. Phase 2 requires Anthropic's structured-outputs
  // beta, which is only available via the direct Anthropic API. Even if a
  // lingering `claude.apiKey` is present, refuse to construct the direct
  // client unless the user has explicitly selected Anthropic as the active
  // provider. Fails closed for `openrouter`, `codex`, and any future proxied
  // provider so the humanizer can surface the config mismatch during
  // onboarding.
  if (!isDirectAnthropicConfig(effectiveSettings)) {
    phase2SessionLogger.warn(
      { activeProvider: effectiveSettings.activeProvider },
      'Phase 2: Non-direct-Anthropic active provider — refusing to construct direct Anthropic client',
    );
    await phase2SessionLogger.flushSessionLogs();
    return {
      success: false,
      error:
        'Use case formatting requires direct Anthropic access. Please complete onboarding with an Anthropic API key, or retry after switching the active provider back to Anthropic.',
      errorKind: 'invalid_request',
    };
  }

  // R4: gate direct-Anthropic construction through the provider route plan.
  // Phase 2 uses Anthropic's structured-outputs beta, which is not available
  // via the OR/Codex proxies. Without this guard, an OR/Codex-active user with
  // a lingering claude.apiKey would silently route phase-2 formatting to
  // Anthropic's native endpoint.
  const directApiKeyForPlan = getApiKey(effectiveSettings) ?? auth.apiKey;
  const currentModels = effectiveSettings.models ?? {};
  const routingSettings: ProviderRouteSettings = {
    ...effectiveSettings,
    models: {
      ...currentModels,
      ...(directApiKeyForPlan ? { apiKey: directApiKeyForPlan } : {}),
    },
  };
  const phase2Plan = await resolveProviderRoutePlan(
    {
      kind: 'forBTS',
      input: {
        settings: routingSettings,
        model: phase2Model,
        category: 'use-case-generator-phase-2',
        codexConnectivity: CODEX_CONNECTIVITY_UNKNOWN,
      },
    },
    {
      ...(auth.apiKey ? { anthropicApiKey: auth.apiKey } : {}),
      includeStructuredOutputBeta: true,
      logLevel: 'debug',
    },
  );
  const directCapability = ensureDirectAnthropicCapable(phase2Plan);
  if (!directCapability.ok) {
    phase2SessionLogger.warn(
      {
        activeProvider: effectiveSettings.activeProvider,
        reason: directCapability.reason,
        transport: phase2Plan.decision.transport,
        modelDialect: phase2Plan.decision.modelDialect,
        wireModelId: phase2Plan.decision.wireModelId,
      },
      'Phase 2: Non-direct-Anthropic active provider — cannot run structured-output formatting',
    );
    await phase2SessionLogger.flushSessionLogs();
    return {
      success: false,
      error:
        'Use case formatting requires direct Anthropic access. Please complete onboarding with an Anthropic API key, or retry after switching the active provider back to Anthropic.',
      errorKind: 'invalid_request',
    };
  }

  if (!auth.apiKey) {
    phase2SessionLogger.warn('Phase 2: No API key available for direct Anthropic formatting');
    await phase2SessionLogger.flushSessionLogs();
    return {
      success: false,
      error:
        'Use case formatting requires direct Anthropic access. Please complete onboarding with an Anthropic API key, or retry after switching the active provider back to Anthropic.',
      errorKind: 'invalid_request',
    };
  }

  const client = createAnthropicSdkClientForDirectPlan(phase2Plan);

  const phase2SystemPrompt =
    'You are a JSON formatter. Extract the user\'s first name and email address from the analysis (look for email From fields, signatures, profile info). Create use cases with clear titles and descriptions that feel personally crafted - use "like" before specific examples (companies, people, projects) and mention data sources.';

  let structuredOutput: {
    use_cases?: unknown[];
    user_first_name?: string | null;
    user_email?: string | null;
  } | undefined;

  try {
    log.info('Phase 2: Formatting use cases into structured JSON');

    const response = await client.messages.create(
      {
        model: phase2Model,
        max_tokens: 4096,
        system: phase2SystemPrompt,
        messages: [{ role: 'user', content: formattingPrompt }],
        output_config: {
          format: {
            type: 'json_schema',
            schema: USE_CASE_JSON_SCHEMA,
          },
        },
      },
      {
        signal: phase2AbortController.signal,
        timeout: FORMATTING_PHASE_TIMEOUT_MS,
        headers: {
          'anthropic-beta': 'structured-outputs-2025-11-13',
        },
      },
    );

    if (response.usage) {
      const cost = calculateCostOrWarn(
        phase2Model,
        response.usage.input_tokens,
        response.usage.output_tokens,
        log,
        'use-case-discovery',
        response.usage.cache_creation_input_tokens ?? undefined,
        response.usage.cache_read_input_tokens ?? undefined,
      );
      if (cost != null && cost > 0) {
        appendCostEntry({
          ts: Date.now(),
          cost,
          cat: 'useCaseDiscovery',
          m: phase2Model,
          auth: 'api-key',
          outcome: { kind: 'auxiliary_success' },
        });
      }
    }

    const phase2Text = response.content
      .filter((block): block is Extract<(typeof response.content)[number], { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    if (!phase2Text) {
      phase2SessionLogger.warn('Phase 2: No text response from formatter');
      await phase2SessionLogger.flushSessionLogs();
      return { success: false, error: 'No response from formatter' };
    }

    const normalizedPhase2Text = phase2Text.startsWith('```')
      ? phase2Text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
      : phase2Text;

    try {
      structuredOutput = JSON.parse(normalizedPhase2Text) as {
        use_cases?: unknown[];
        user_first_name?: string | null;
        user_email?: string | null;
      };
    } catch (parseError) {
      phase2SessionLogger.warn(
        {
          error: parseError instanceof Error ? parseError.message : String(parseError),
          rawResponsePreview: normalizedPhase2Text.slice(0, 600),
        },
        'Phase 2: Failed to parse JSON response',
      );
      await phase2SessionLogger.flushSessionLogs();
      return { success: false, error: 'Invalid response format' };
    }
  } catch (error) {
    if (phase2AbortController.signal.aborted) {
      phase2SessionLogger.warn('Phase 2: Formatting timed out');
      await phase2SessionLogger.flushSessionLogs();
      return { success: false, error: 'Use case formatting timed out', errorKind: 'unknown' };
    }
    
    phase2SessionLogger.error({ error }, 'Phase 2: Formatting failed');
    await phase2SessionLogger.flushSessionLogs();
    const rawMessage = error instanceof Error ? error.message : 'Use case formatting failed';
    // Stage 6b (plan 260421): classification-first humanization.
    // When the error is a ModelError, forward classification + provider context
    // to humanizeAgentError so billing/auth/rate-limit copy names the user's
    // actual provider (e.g. OpenRouter) instead of generic "API account".
    // Non-ModelError throwables fall back to unclassified (legacy parity via
    // the humanizer's rawMessage path).
    const humanized = humanizeAgentError(
      error instanceof ModelError
        ? {
            kind: 'classified',
            errorKind: error.__agentErrorKind,
            rawMessage: error.__rawMessage,
            provider: error.provider,
            upstreamProviderName: error.upstreamProvider,
          }
        : { kind: 'unclassified', rawMessage },
    );
    return {
      success: false,
      error: humanized,
      errorKind: getErrorKind(error),
    };
  } finally {
    clearTimeout(phase2Timeout);
  }

  // Log the structured output for debugging (this is what was missing!)
  phase2SessionLogger.info({ structuredOutput }, 'Phase 2: Received structured output');
  
  if (!structuredOutput?.use_cases || !Array.isArray(structuredOutput.use_cases)) {
    phase2SessionLogger.warn({ structuredOutput }, 'Phase 2: Invalid structured output from formatting');
    await phase2SessionLogger.flushSessionLogs();
    return { success: false, error: 'Invalid response format' };
  }

  // Extract and validate user's first name
  let userFirstName: string | undefined;
  const rawFirstName = structuredOutput.user_first_name;
  if (typeof rawFirstName === 'string' && rawFirstName.trim().length >= 2 && rawFirstName.trim().length <= 30) {
    // Basic validation: reasonable length, starts with letter, not a placeholder
    const trimmed = rawFirstName.trim();
    const lowerTrimmed = trimmed.toLowerCase();
    // Reject common placeholder values that LLMs return when they can't find a name
    const invalidNames = ['null', 'undefined', 'unknown', 'user', 'name', 'n/a', 'none'];
    if (/^[A-Za-z]/.test(trimmed) && !invalidNames.includes(lowerTrimmed)) {
      userFirstName = trimmed;
      log.info({ userFirstName }, 'Extracted user first name from use case generation');
    }
  }

  // Extract and validate user's email address
  let userEmail: string | undefined;
  const rawEmail = structuredOutput.user_email;
  if (typeof rawEmail === 'string' && rawEmail.trim().length > 0) {
    const trimmed = rawEmail.trim().toLowerCase();
    // Basic email validation
    const emailMatch = trimmed.match(/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/);
    if (emailMatch) {
      userEmail = emailMatch[0];
      log.info({ userEmail }, 'Extracted user email from use case generation');
    }
  }

  const now = Date.now();
  const useCases: PersonalizedUseCase[] = structuredOutput.use_cases
    .slice(0, 3)
    .map((item, index) => {
      const raw = item as Record<string, unknown>;
      return {
        id: crypto.randomUUID?.() ?? `usecase-${index}-${now}`,
        title: typeof raw.title === 'string' ? raw.title : `Use Case ${index + 1}`,
        description: typeof raw.description === 'string' ? raw.description : '',
        prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
        icon: typeof raw.icon === 'string' ? raw.icon : '✨',
        generatedAt: now
      };
    });

  if (useCases.length === 0) {
    phase2SessionLogger.warn('No use cases in structured output');
    await phase2SessionLogger.flushSessionLogs();
    return { success: false, error: 'No use cases generated' };
  }

  phase2SessionLogger.info({ count: useCases.length, userFirstName: userFirstName ?? '(not found)', userEmail: userEmail ?? '(not found)' }, 'Successfully generated personalized use cases');
  await phase2SessionLogger.flushSessionLogs();
  
  log.info({ count: useCases.length, userFirstName: userFirstName ?? '(not found)', userEmail: userEmail ?? '(not found)' }, 'Successfully generated personalized use cases');

  // ==========================================================================
  // Add generated use cases to the self-curating library
  // ==========================================================================
  let addedCount = 0;
  let forcedCount = 0;

  for (const uc of useCases) {
    const candidate: UseCaseCandidate = {
      title: uc.title,
      description: uc.description,
      prompt: uc.prompt,
      icon: uc.icon ?? 'Lightbulb',
      qualityRating: 90
    };

    const result = await addUseCase(candidate, { callerIntent: 'background_indexing' });
    if (result.added) {
      addedCount++;
    }
  }

  // Guarantee at least 1 new use case per generation (daily minimum)
  if (addedCount === 0 && useCases.length > 0) {
    const firstUseCase = useCases[0];
    if (firstUseCase) {
      const forced = await forceAddUseCase({
        title: firstUseCase.title,
        description: firstUseCase.description,
        prompt: firstUseCase.prompt,
        icon: firstUseCase.icon ?? 'Lightbulb',
        qualityRating: 85
      });
      if (forced.added) {
        forcedCount = 1;
      }
    }
  }

  log.info(
    { addedCount, forcedCount, totalGenerated: useCases.length },
    'Added use cases to library'
  );

  return { success: true, useCases, userFirstName, userEmail };
}

/**
 * Initialize the use case library from existing settings (one-time migration).
 * Should be called during app startup after settings are loaded.
 */
export async function initializeUseCaseLibrary(
  existingUseCases: PersonalizedUseCase[]
): Promise<void> {
  if (!needsMigration()) {
    log.debug('Use case library migration already complete');
    return;
  }

  if (existingUseCases.length === 0) {
    log.debug('No existing use cases to migrate');
    return;
  }

  const imported = await importFromSettings(existingUseCases);
  log.info({ imported }, 'Migrated existing use cases to library');
}

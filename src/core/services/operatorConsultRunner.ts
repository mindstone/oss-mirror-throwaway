import { createScopedLogger } from '@core/logger';
import { getTracker, type Tracker } from '@core/tracking';
import { callWithModelAuthAware } from '@core/services/behindTheScenesClient';
import { getSettings } from '@core/services/settingsStore';
import { classifyError } from '@core/rebelCore/modelErrors';
import { CODEX_CONNECTIVITY_UNKNOWN } from '@core/rebelCore/codexConnectivity';
import { redactAndTruncateRawError } from '@core/utils/redactRawError';
import { resolveBtsModel } from '@shared/utils/btsModelResolver';
import type { AppSettings } from '@shared/types';
import {
  OperatorConsultToolInputSchema,
  parseOperatorId,
  type OperatorConsultResult,
  type OperatorDefinition,
} from '@shared/types/operators';
import type { BuiltinToolContext } from '@core/rebelCore/types';
import { assemblePersonaPrompt } from './personaPromptAssembly';
import * as operatorRegistry from './operatorRegistry';
import * as operatorDiaryStore from './operatorDiaryStore';

const log = createScopedLogger({ service: 'operatorConsultRunner' });

let consultGateRemovedBreadcrumbEmitted = false;

const RECENT_DIARY_ENTRY_LIMIT = 5;
const RECENT_DIARY_CHAR_LIMIT = 4_000;
const CONSULT_MAX_TOKENS = 1_000;
const CONSULT_TEMPERATURE = 0.2;
const FANOUT_COUNTER_KEY = 'operator_consult.fanout_count';

type BtsErrorCategory = 'rate_limited' | 'malformed_response' | 'auth_failed' | 'network' | 'invalid_request' | 'unknown';
type ConsultPromptSource = 'frontmatter' | 'body';

type OperatorConsultLogger = Pick<ReturnType<typeof createScopedLogger>, 'info' | 'warn'>;

interface ConsultBtsResponse {
  content: Array<{ type: string; text?: string }>;
}

export interface OperatorConsultRunnerDeps {
  registry: {
    getById(operatorId: string): OperatorDefinition | undefined;
    listAvailable(spacePaths: string[]): Promise<OperatorDefinition[]>;
  };
  diaryStore: {
    readDiary(operatorId: string, spacePath: string): Promise<string>;
    appendDiary(operatorId: string, spacePath: string, entry: string): Promise<void>;
  };
  getSettings(): AppSettings;
  callModel(
    settings: AppSettings,
    model: string | undefined,
    options: Parameters<typeof callWithModelAuthAware>[2],
    tracking?: Parameters<typeof callWithModelAuthAware>[3],
  ): Promise<ConsultBtsResponse>;
  tracker: Pick<Tracker, 'track'>;
  logger: OperatorConsultLogger;
}

const defaultDeps: OperatorConsultRunnerDeps = {
  registry: operatorRegistry,
  diaryStore: operatorDiaryStore,
  getSettings,
  callModel: callWithModelAuthAware,
  tracker: {
    track: (event, properties) => getTracker().track(event, properties),
  },
  logger: log,
};

function getInputOperatorId(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return undefined;
  }
  const operatorId = (input as { operatorId?: unknown }).operatorId;
  return typeof operatorId === 'string' ? operatorId : undefined;
}

function resolveConsultModel(
  settings: AppSettings,
  context: BuiltinToolContext,
): {
  model: string;
  route?: NonNullable<ReturnType<NonNullable<BuiltinToolContext['getExecutionRoute']>>>;
} {
  const route = context.getExecutionRoute?.();
  const profileId = typeof route?.profileId === 'string' ? route.profileId.trim() : '';
  if (profileId.length > 0) {
    return { model: `profile:${profileId}`, route };
  }
  const model = typeof route?.model === 'string' ? route.model.trim() : '';
  if (model.length > 0) {
    return { model, route };
  }
  return { model: resolveBtsModel(settings, 'council') };
}

function incrementFanoutTelemetry(context: BuiltinToolContext, tracker: Pick<Tracker, 'track'>): void {
  const nextCount = (context.rateLimitState?.get(FANOUT_COUNTER_KEY) ?? 0) + 1;
  context.rateLimitState?.set(FANOUT_COUNTER_KEY, nextCount);
  tracker.track(FANOUT_COUNTER_KEY, {
    count: nextCount,
    wasExplicitCouncilIntent: context.wasExplicitCouncilIntent === true,
  });
}

async function resolveOperator(
  operatorId: string,
  deps: OperatorConsultRunnerDeps,
): Promise<{ operator?: OperatorDefinition; availableIds: string[] }> {
  const cached = deps.registry.getById(operatorId);
  if (cached) {
    return { operator: cached, availableIds: [cached.id] };
  }

  const parsed = parseOperatorId(operatorId);
  if (!parsed.spacePath) {
    return { availableIds: [] };
  }

  const available = await deps.registry.listAvailable([parsed.spacePath]);
  return {
    operator: deps.registry.getById(operatorId) ?? available.find((candidate) => candidate.id === operatorId),
    availableIds: available.map((candidate) => candidate.id),
  };
}

function getRecentDiaryEntries(rawDiary: string): string[] {
  const entries = rawDiary
    .split(/\n{2,}(?=##\s|\d{4}-\d{2}-\d{2}|Focus:|$)/u)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(-RECENT_DIARY_ENTRY_LIMIT);

  const selected: string[] = [];
  let remainingChars = RECENT_DIARY_CHAR_LIMIT;
  for (const entry of entries.reverse()) {
    if (remainingChars <= 0) break;
    const clipped = entry.length > remainingChars ? entry.slice(0, remainingChars) : entry;
    selected.unshift(clipped);
    remainingChars -= clipped.length;
  }
  return selected;
}

function extractResponseText(response: ConsultBtsResponse): string {
  return response.content
    .map((block) => block.text ?? '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

function parseConsultModelResponse(text: string): {
  perspective: string;
  evidenceCited: string[];
  confidence: number;
} {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('malformed_response: empty response');
  }

  const parsed = JSON.parse(trimmed) as Record<string, unknown>;
  const perspective = typeof parsed.perspective === 'string'
    ? parsed.perspective.trim()
    : '';
  if (!perspective) {
    throw new Error('malformed_response: empty perspective');
  }

  const evidenceCited = Array.isArray(parsed.evidenceCited)
    ? parsed.evidenceCited.filter((item): item is string => typeof item === 'string')
    : [];
  const confidence = typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
    ? Math.max(0, Math.min(1, parsed.confidence))
    : 0.5;
  return { perspective, evidenceCited, confidence };
}

function sanitizeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactAndTruncateRawError(raw)?.slice(0, 500) ?? 'unknown';
}

function classifyBtsError(error: unknown, fallback?: BtsErrorCategory): {
  category: BtsErrorCategory;
  sanitizedMessage: string;
} {
  const sanitizedMessage = sanitizeErrorMessage(error);
  if (fallback) {
    return { category: fallback, sanitizedMessage };
  }

  const classified = classifyError(error);
  switch (classified.kind) {
    case 'rate_limit':
      return { category: 'rate_limited', sanitizedMessage };
    case 'auth':
      return { category: 'auth_failed', sanitizedMessage };
    case 'server_error':
    case 'network':
      return { category: 'network', sanitizedMessage };
    // Deterministic request-shape rejections (e.g. a provider 400 "Unsupported parameter: …").
    // Surfaced as its own reason so this class is diagnosable instead of hiding under 'unknown'.
    case 'invalid_request':
      return { category: 'invalid_request', sanitizedMessage };
    case 'unknown':
    case 'billing':
    case 'moderation':
    case 'context_overflow':
    case 'model_unavailable':
    case 'managed_model_not_allowed':
    case 'image_input_unsupported':
    case 'tool_input_too_large':
    case 'abort':
      return { category: 'unknown', sanitizedMessage };
  }
}

function buildConsultUserPrompt(input: {
  operatorName: string;
  focus: string;
  callerContextSummary?: string | null;
}): string {
  return [
    `Consult as ${input.operatorName} on the requested focus.`,
    '',
    'Return ONLY valid JSON with this exact shape:',
    '{"perspective": "your concise advisory perspective", "evidenceCited": ["short cited operator-persona or diary fact"], "confidence": 0.0}',
    '',
    'Rules:',
    '- Stay in the Operator persona and use their stated voice.',
    '- Use diary entries only as recent context, not as a replacement for the persona.',
    '- Keep the perspective tightly scoped to the focus.',
    '',
    `Focus: ${input.focus}`,
    input.callerContextSummary ? `Caller context: ${input.callerContextSummary}` : '',
  ].filter(Boolean).join('\n');
}

function buildDiaryEntry(input: {
  operatorName: string;
  focus: string;
  perspective: string;
  evidenceCited: string[];
  confidence: number;
}): string {
  return [
    `## ${new Date().toISOString()} — ${input.operatorName}`,
    `Focus: ${input.focus}`,
    `Confidence: ${input.confidence.toFixed(2)}`,
    input.evidenceCited.length > 0 ? `Evidence cited: ${input.evidenceCited.join('; ')}` : 'Evidence cited: none',
    '',
    input.perspective,
  ].join('\n');
}

function resolveConsultPromptSource(operator: OperatorDefinition): { consultationPrompt: string; source: ConsultPromptSource } {
  const frontmatterPrompt = operator.consultationPrompt?.trim();
  if (frontmatterPrompt) {
    return {
      consultationPrompt: frontmatterPrompt,
      source: 'frontmatter',
    };
  }
  return {
    consultationPrompt: operator.body,
    source: 'body',
  };
}

export async function runConsult(
  input: unknown,
  context: BuiltinToolContext = {},
  deps: OperatorConsultRunnerDeps = defaultDeps,
): Promise<OperatorConsultResult> {
  if (context.surfaceCapability !== 'desktop') {
    return {
      isError: true,
      errorCode: 'operator_consult_desktop_only',
      message: 'Operator consults use local Space files and are only available in the desktop app.',
      ...(getInputOperatorId(input) ? { operatorId: getInputOperatorId(input) } : {}),
    };
  }

  if (!consultGateRemovedBreadcrumbEmitted) {
    consultGateRemovedBreadcrumbEmitted = true;
    deps.logger.info({}, 'operators:consult_gate_removed');
  }

  const parsedInput = OperatorConsultToolInputSchema.parse(input);

  incrementFanoutTelemetry(context, deps.tracker);

  const { operator, availableIds } = await resolveOperator(parsedInput.operatorId, deps);
  if (!operator) {
    return {
      isError: true,
      errorCode: 'operator_not_found',
      message: `Operator '${parsedInput.operatorId}' was not found in the available Operators for this Space.`,
      operatorId: parsedInput.operatorId,
      availableIds,
    };
  }

  const diaryEntries = getRecentDiaryEntries(await deps.diaryStore.readDiary(operator.id, operator.spacePath));
  const { consultationPrompt, source: consultPromptSource } = resolveConsultPromptSource(operator);
  deps.logger.info(
    {
      operatorSlug: operator.operatorSlug,
      source: consultPromptSource,
    },
    'operators:consult_prompt_resolved',
  );
  const operatorLabel = operator.displayName?.trim() || operator.name;
  const system = assemblePersonaPrompt({
    persona: [
      `You are ${operatorLabel}, an Operator advisor.`,
      operator.description,
      `Consult when: ${operator.consult_when}`,
      consultationPrompt,
    ].filter(Boolean).join('\n\n'),
    grounding: '',
    diaryEntries,
    focus: parsedInput.focus,
    callerContext: 'You are being called by Rebel mid-turn as a single-Operator consult. Give the lead agent a perspective it can synthesize for the user.',
    voiceFraming: [
      'Stay in this Operator persona.',
      'Diary entries are recent memory only, not source of truth.',
    ],
  });

  let modelText: string;
  try {
    const settings = deps.getSettings();
    const resolvedConsultModel = resolveConsultModel(settings, context);
    const executionRouteEffort = typeof resolvedConsultModel.route?.effort === 'string'
      ? resolvedConsultModel.route.effort.trim() || undefined
      : undefined;
    const callModelOptions: Parameters<typeof callWithModelAuthAware>[2] & { effort?: string } = {
      system,
      messages: [{ role: 'user', content: buildConsultUserPrompt({ operatorName: operatorLabel, focus: parsedInput.focus }) }],
      maxTokens: CONSULT_MAX_TOKENS,
      temperature: CONSULT_TEMPERATURE,
      ...(executionRouteEffort ? { effort: executionRouteEffort } : {}),
      codexConnectivity: resolvedConsultModel.route?.codexConnectivity ?? CODEX_CONNECTIVITY_UNKNOWN,
      signal: context.signal,
    };
    const response = await deps.callModel(
      settings,
      resolvedConsultModel.model,
      callModelOptions,
      {
        category: 'council',
      },
    );
    modelText = extractResponseText(response);
  } catch (error) {
    const classified = classifyBtsError(error);
    log.warn(
      {
        errorCategory: classified.category,
        sanitizedMessage: classified.sanitizedMessage,
        operatorId: operator.id,
        spacePath: operator.spacePath,
      },
      'operator_consult_model_call_failed',
    );
    return {
      isError: true,
      errorCode: 'consult_failed',
      message: `Consult with ${operatorLabel} failed before it could return a perspective.`,
      reason: classified.category,
      operatorId: operator.id,
      operatorName: operatorLabel,
    };
  }

  let parsedResponse: ReturnType<typeof parseConsultModelResponse>;
  try {
    parsedResponse = parseConsultModelResponse(modelText);
  } catch (error) {
    const classified = classifyBtsError(error, 'malformed_response');
    log.warn(
      {
        errorCategory: classified.category,
        sanitizedMessage: classified.sanitizedMessage,
        operatorId: operator.id,
        spacePath: operator.spacePath,
      },
      'operator_consult_model_response_malformed',
    );
    return {
      isError: true,
      errorCode: 'consult_failed',
      message: `Consult with ${operatorLabel} failed before it could return a usable perspective.`,
      reason: classified.category,
      operatorId: operator.id,
      operatorName: operatorLabel,
    };
  }

  let diaryAppendFailed = false;
  try {
    await deps.diaryStore.appendDiary(operator.id, operator.spacePath, buildDiaryEntry({
      operatorName: operatorLabel,
      focus: parsedInput.focus,
      ...parsedResponse,
    }));
  } catch (error) {
    diaryAppendFailed = true;
    log.warn(
      {
        error: error instanceof Error ? error.message : String(error),
        operatorId: operator.id,
        spacePath: operator.spacePath,
      },
      'operator_consult_diary_append_failed',
    );
  }

  return {
    isError: false,
    calibrated: true,
    errorCode: null,
    operatorId: operator.id,
    operatorName: operatorLabel,
    perspective: parsedResponse.perspective,
    response: parsedResponse.perspective,
    evidenceCited: parsedResponse.evidenceCited,
    confidence: parsedResponse.confidence,
    diaryAppendFailed,
    ...(diaryAppendFailed
      ? { message: `The consult succeeded, but Rebel could not save it to ${operatorLabel}'s diary.` }
      : {}),
  };
}

export function _resetOperatorConsultRunnerTelemetryForTests(): void {
  consultGateRemovedBreadcrumbEmitted = false;
}

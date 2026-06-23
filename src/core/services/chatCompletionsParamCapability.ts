import type { ModelProviderType } from '@shared/types';
import { PROVIDER_PRESETS } from '@shared/data/modelProviderPresets';

type ChatCompletionsSamplingBody = {
  temperature?: unknown;
  top_p?: unknown;
};

type ChatCompletionsReasoningBody = {
  reasoning_effort?: unknown;
};

type SamplingParamName = 'temperature' | 'top_p';
type ReasoningParamName = 'reasoning_effort';
type ChatCompletionsParamBody = object;

declare const validatedChatCompletionsBodyBrand: unique symbol;

export type ValidatedChatCompletionsBody<T extends ChatCompletionsParamBody = ChatCompletionsParamBody> = T & {
  readonly [validatedChatCompletionsBodyBrand]: true;
};

type StripLog = {
  info: (
    data: {
      modelId: string | undefined;
      providerType: ModelProviderType | undefined;
      strippedParams: Array<SamplingParamName | ReasoningParamName>;
    },
    message: string,
  ) => void;
};

function normalizeOpenAiModelId(modelId: string | undefined): string | null {
  const trimmed = modelId?.trim().toLowerCase();
  if (!trimmed) return null;
  const slashIdx = trimmed.indexOf('/');
  return slashIdx >= 0 ? trimmed.slice(slashIdx + 1) : trimmed;
}

export function getOpenAiPresetReasoningCapability(modelId: string | undefined): boolean | undefined {
  const normalized = normalizeOpenAiModelId(modelId);
  if (!normalized) return undefined;

  const preset = PROVIDER_PRESETS.openai.models.find(
    (model) => normalizeOpenAiModelId(model.value) === normalized,
  );
  if (!preset) return undefined;
  return preset.reasoning !== false;
}

export function stripUnsupportedChatCompletionsSamplingParams(
  body: ChatCompletionsSamplingBody,
  options: {
    modelId: string | undefined;
    providerType: ModelProviderType | undefined;
    log?: StripLog;
  },
): SamplingParamName[] {
  if (options.providerType !== 'openai') return [];
  if (getOpenAiPresetReasoningCapability(options.modelId) !== true) return [];

  const strippedParams: SamplingParamName[] = [];
  if (Object.prototype.hasOwnProperty.call(body, 'temperature')) {
    delete body.temperature;
    strippedParams.push('temperature');
  }
  if (Object.prototype.hasOwnProperty.call(body, 'top_p')) {
    delete body.top_p;
    strippedParams.push('top_p');
  }

  if (strippedParams.length > 0) {
    options.log?.info(
      {
        modelId: options.modelId,
        providerType: options.providerType,
        strippedParams,
      },
      'Stripped unsupported Chat Completions sampling params for OpenAI reasoning model',
    );
  }

  return strippedParams;
}

export function stripUnsupportedChatCompletionsReasoningParams(
  body: ChatCompletionsReasoningBody,
  options: {
    modelId: string | undefined;
    providerType: ModelProviderType | undefined;
    log?: StripLog;
  },
): ReasoningParamName[] {
  if (options.providerType !== 'openai') return [];
  if (getOpenAiPresetReasoningCapability(options.modelId) !== false) return [];

  const strippedParams: ReasoningParamName[] = [];
  if (Object.prototype.hasOwnProperty.call(body, 'reasoning_effort')) {
    delete body.reasoning_effort;
    strippedParams.push('reasoning_effort');
  }

  if (strippedParams.length > 0) {
    options.log?.info(
      {
        modelId: options.modelId,
        providerType: options.providerType,
        strippedParams,
      },
      'Stripped unsupported Chat Completions reasoning params for OpenAI non-reasoning model',
    );
  }

  return strippedParams;
}

export function finalizeChatCompletionsBody<T extends ChatCompletionsParamBody>(
  body: T,
  options: {
    modelId: string | undefined;
    providerType: ModelProviderType | undefined;
    log?: StripLog;
  },
): ValidatedChatCompletionsBody<T> {
  stripUnsupportedChatCompletionsSamplingParams(body as T & ChatCompletionsSamplingBody, options);
  stripUnsupportedChatCompletionsReasoningParams(body as T & ChatCompletionsReasoningBody, options);
  return body as ValidatedChatCompletionsBody<T>;
}

export function serializeChatCompletionsBody<T extends ChatCompletionsParamBody>(
  body: ValidatedChatCompletionsBody<T>,
): string {
  return JSON.stringify(body);
}

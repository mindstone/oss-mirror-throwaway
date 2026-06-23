import type { AppSettings } from '@shared/types';
import type { AuxiliaryCostCategory } from '@shared/costCategories';
import { z } from 'zod';
import {
  callBehindTheScenesWithAuth,
  callWithModelAuthAware,
  type BehindTheScenesRequestOptions,
  type BehindTheScenesResponse,
} from '../../behindTheScenesClient';
import type { TrackingOptions } from '../transports/shared';

export type UseCaseClientFailureKind = 'no_text' | 'parse_failure' | 'invalid_structure';

type ParsedResponseFailure = {
  kind: UseCaseClientFailureKind;
  detail?: string;
};

export type UseCaseClientTextParseResult<TParsedOutput> =
  | { kind: 'success'; value: TParsedOutput }
  | { kind: 'parse_failure' }
  | { kind: 'invalid_structure'; detail?: string };

export type UseCaseClientCallResult<TOutput> =
  | {
      kind: 'success';
      value: TOutput;
      response: BehindTheScenesResponse;
      resolvedModel: string;
    }
  | {
      kind: UseCaseClientFailureKind;
      detail?: string;
      response: BehindTheScenesResponse;
      resolvedModel: string;
    };

export interface UseCaseClientPrompt {
  messages: BehindTheScenesRequestOptions['messages'];
  system?: string;
  maxTokens?: number;
  temperature?: number;
  timeout?: number;
  signal?: AbortSignal;
  codexConnectivity: BehindTheScenesRequestOptions['codexConnectivity'];
}

export interface ParseTextContext<TInput> {
  text: string;
  input: TInput;
}

export interface NormalizeJsonContext<TInput> {
  parsedJson: unknown;
  input: TInput;
}

export interface InvalidStructureDetailContext<TInput> {
  rawParsedJson: unknown;
  parsedJson: unknown;
  issues: z.ZodIssue[];
  input: TInput;
}

export interface RetryDecisionContext<TInput> {
  settings: AppSettings;
  input: TInput;
  failureKind: UseCaseClientFailureKind;
  detail?: string;
  resolvedModel: string;
}

export interface UseCaseClientSpec<TInput, TWireOutput, TParsedOutput = TWireOutput> {
  /** Human-readable identifier for diagnostics and parse helpers. */
  name: string;
  /** Cost category + cooldown bucket selector consumed by BTS dispatch core. */
  category: AuxiliaryCostCategory;
  /** Optional input validator for typed per-use-case call signatures. */
  inputSchema?: z.ZodType<TInput>;
  /** Strict wire contract schema used to derive outputFormat JSON Schema. */
  outputSchema: z.ZodType<TWireOutput>;
  /** Optional parse schema override (defaults to outputSchema). */
  parseSchema?: z.ZodType<TParsedOutput>;
  /** Prompt builder for this use-case. */
  buildPrompt: (input: TInput) => UseCaseClientPrompt;
  /** Optional model-text parser. Default: JSON.parse with null on error. */
  parseTextToJson?: (context: ParseTextContext<TInput>) => unknown | null;
  /** Optional normalizer before Zod validation. */
  normalizeParsedJson?: (context: NormalizeJsonContext<TInput>) => unknown;
  /** Optional invalid-structure detail builder. */
  buildInvalidStructureDetail?: (context: InvalidStructureDetailContext<TInput>) => string | undefined;
  /** Optional one-shot retry model resolver for parse/shape failures. */
  getRetryModelOnFailure?: (context: RetryDecisionContext<TInput>) => string | null | undefined;
}

export interface UseCaseClientRunOptions {
  tracking?: Omit<TrackingOptions, 'category'>;
}

export interface UseCaseClient<TInput, TParsedOutput> {
  readonly wireOutputSchema: Record<string, unknown>;
  run(
    settings: AppSettings,
    input: TInput,
    options?: UseCaseClientRunOptions,
  ): Promise<UseCaseClientCallResult<TParsedOutput>>;
}

export function zodSchemaToBtsWireSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  const { $schema: _omitTopLevelSchema, ...withoutTopLevelSchema } = jsonSchema;
  return withoutTopLevelSchema;
}

function parseJsonWithDefaultParser(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    // eslint-disable-next-line rebel-silent-swallow/no-silent-swallow -- Default parser intentionally returns null so callers can map malformed JSON to parse_failure.
    return null;
  }
}

export function parseUseCaseClientText<TInput, TWireOutput, TParsedOutput = TWireOutput>(
  spec: UseCaseClientSpec<TInput, TWireOutput, TParsedOutput>,
  input: TInput,
  text: string,
): UseCaseClientTextParseResult<TParsedOutput> {
  const parseSchema = spec.parseSchema ?? (spec.outputSchema as unknown as z.ZodType<TParsedOutput>);
  const parsedJson = spec.parseTextToJson
    ? spec.parseTextToJson({ text, input })
    : parseJsonWithDefaultParser(text);

  if (parsedJson === null) {
    return { kind: 'parse_failure' };
  }

  const normalizedJson = spec.normalizeParsedJson
    ? spec.normalizeParsedJson({ parsedJson, input })
    : parsedJson;

  const parsed = parseSchema.safeParse(normalizedJson);
  if (!parsed.success) {
    const detail = spec.buildInvalidStructureDetail?.({
      rawParsedJson: parsedJson,
      parsedJson: normalizedJson,
      issues: parsed.error.issues,
      input,
    });
    return { kind: 'invalid_structure', detail };
  }

  return { kind: 'success', value: parsed.data };
}

function parseResponse<TInput, TParsedOutput>(
  response: BehindTheScenesResponse,
  input: TInput,
  spec: UseCaseClientSpec<TInput, unknown, TParsedOutput>,
): ParsedResponseFailure | { kind: 'success'; value: TParsedOutput } {
  if (!Array.isArray(response.content) || response.content.length === 0) {
    return { kind: 'no_text', detail: 'Empty response from API' };
  }

  const textBlock = response.content.find((block) => block.type === 'text' && typeof block.text === 'string');
  if (!textBlock?.text) {
    return { kind: 'no_text', detail: 'No text content in response' };
  }

  return parseUseCaseClientText(spec, input, textBlock.text);
}

export function createUseCaseClient<TInput, TWireOutput, TParsedOutput = TWireOutput>(
  spec: UseCaseClientSpec<TInput, TWireOutput, TParsedOutput>,
): UseCaseClient<TInput, TParsedOutput> {
  const wireOutputSchema = zodSchemaToBtsWireSchema(spec.outputSchema);

  const run: UseCaseClient<TInput, TParsedOutput>['run'] = async (settings, input, options) => {
    const parsedInput = spec.inputSchema ? spec.inputSchema.parse(input) : input;
    const prompt = spec.buildPrompt(parsedInput);

    const requestOptions: BehindTheScenesRequestOptions = {
      messages: prompt.messages,
      system: prompt.system,
      maxTokens: prompt.maxTokens,
      temperature: prompt.temperature,
      outputFormat: {
        type: 'json_schema',
        schema: wireOutputSchema,
      },
      timeout: prompt.timeout,
      signal: prompt.signal,
      codexConnectivity: prompt.codexConnectivity,
    };

    const tracking = { category: spec.category, ...(options?.tracking ?? {}) };

    const primaryResponse = await callBehindTheScenesWithAuth(settings, requestOptions, tracking);
    const primaryResolvedModel = primaryResponse._resolvedModel ?? '';
    const primaryParse = parseResponse(primaryResponse, parsedInput, spec);

    if (primaryParse.kind === 'success') {
      return {
        kind: 'success',
        value: primaryParse.value,
        response: primaryResponse,
        resolvedModel: primaryResolvedModel,
      };
    }

    const retryModel = spec.getRetryModelOnFailure?.({
      settings,
      input: parsedInput,
      failureKind: primaryParse.kind,
      detail: primaryParse.detail,
      resolvedModel: primaryResolvedModel,
    });

    if (!retryModel) {
      return {
        kind: primaryParse.kind,
        detail: primaryParse.detail,
        response: primaryResponse,
        resolvedModel: primaryResolvedModel,
      };
    }

    const retryResponse = await callWithModelAuthAware(settings, retryModel, requestOptions, tracking);
    const retryResolvedModel = retryResponse._resolvedModel ?? retryModel;
    const retryParse = parseResponse(retryResponse, parsedInput, spec);
    if (retryParse.kind === 'success') {
      return {
        kind: 'success',
        value: retryParse.value,
        response: retryResponse,
        resolvedModel: retryResolvedModel,
      };
    }

    return {
      kind: retryParse.kind,
      detail: retryParse.detail,
      response: retryResponse,
      resolvedModel: retryResolvedModel,
    };
  };

  return {
    wireOutputSchema,
    run,
  };
}

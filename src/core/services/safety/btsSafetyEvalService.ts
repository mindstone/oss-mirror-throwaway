/**
 * BTS (Behind-the-Scenes) implementation of SafetyEvaluationService.
 *
 * Network-level retry for transient errors is handled centrally by
 * withTransientRetry() in behindTheScenesClient.ts.
 */

import type {
  LlmEvalRequest,
  LlmEvalResponse,
  SafetyEvaluationService,
} from '@core/safetyEvaluationService';
import { createScopedLogger } from '@core/logger';
import { callWithModelAuthAware, createBtsRoutePlan } from '../behindTheScenesClient';
import { getSettings } from '@core/services/settingsStore';
import { resolveBtsModel } from '@shared/utils/btsModelResolver';
import { resolveCodexConnectivity } from '@core/rebelCore/codexConnectivity';
import { ModelError } from '@core/rebelCore/modelErrors';

const log = createScopedLogger({ service: 'btsSafetyEvalService' });
const temperatureUnsupportedModels = new Set<string>();

function toTextResponse(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  const serialized = JSON.stringify(value);
  return typeof serialized === 'string' ? serialized : '';
}

export function createBtsSafetyEvalService(): SafetyEvaluationService {
  return {
    async callLlm(request: LlmEvalRequest): Promise<LlmEvalResponse> {
      const settings = getSettings();
      const requestedOverride = request.modelOverride?.trim();
      const resolvedModel = (requestedOverride || resolveBtsModel(settings, 'safety'));
      const sendTemperature =
        request.temperature !== undefined && !temperatureUnsupportedModels.has(resolvedModel);
      const codexConnectivity = resolveCodexConnectivity();

      const btsRequest = {
        codexConnectivity,
        system: request.system,
        messages: [{ role: 'user' as const, content: request.userMessage }],
        maxTokens: request.maxTokens,
        outputFormat: {
          type: 'json_schema' as const,
          schema: request.outputSchema,
        },
        timeout: request.timeout,
        // Forward caller-supplied abort signal so cancelling the turn aborts
        // the in-flight safety-eval LLM call within ms (not after the 15s
        // per-attempt internal timeout).
        signal: request.signal,
      };

      // A4 (observability): log the resolved model + transport actually
      // dispatched on EVERY eval call (not only the `requestedOverride` branch
      // below). When the safety eval degrades, the triage question is "which
      // model/transport did the failing call actually use?" — the resolved
      // model + route-plan transport answers it. The transport comes from a
      // SEPARATE best-effort resolution via the same route resolver
      // (`createBtsRoutePlan`) that `callWithModelAuthAware` uses internally —
      // so it is our best estimate of the dispatched transport for logging, but
      // could drift from what the real dispatch below actually uses. Resolved
      // best-effort: a routing-resolution failure here must never break the
      // eval itself (the real dispatch below surfaces any genuine error).
      let resolvedTransport: string | null = null;
      try {
        const routePlan = await createBtsRoutePlan(
          settings,
          resolvedModel,
          btsRequest,
          'safety',
        );
        resolvedTransport = routePlan.decision.transport;
      } catch {
        resolvedTransport = null;
      }
      log.info(
        {
          resolvedModel,
          transport: resolvedTransport,
          codexConnectivity,
          ...(requestedOverride ? { modelOverride: requestedOverride } : {}),
        },
        'Safety eval dispatch resolved model + transport',
      );

      const callModel = async (
        includeTemperature: boolean,
      ): Promise<Awaited<ReturnType<typeof callWithModelAuthAware>>> =>
        callWithModelAuthAware(
          settings,
          resolvedModel,
          {
            ...btsRequest,
            ...(includeTemperature ? { temperature: request.temperature } : {}),
          },
          { category: 'safety', outcomePolicy: 'turn_bearing' },
          { disableOperationalFallback: request.disableOperationalFallback === true },
        );

      try {
        const response = await callModel(sendTemperature);
        if (requestedOverride) {
          log.info(
            {
              modelOverride: requestedOverride,
              transportHint: request.transportHint ?? null,
              codexConnectivity,
            },
            'Safety eval dispatched with model override',
          );
        }
        return extractResponse(response, settings.behindTheScenesModel);
      } catch (err) {
        if (!sendTemperature || !isTemperatureRejectionError(err)) {
          throw err;
        }

        const errMsg = err.__rawMessage || err.message;
        try {
          const retryResponse = await callModel(false);
          const retryResult = extractResponse(retryResponse, settings.behindTheScenesModel);

          // Only remember the model as temperature-unsupported AFTER the
          // no-temperature retry has fully succeeded (incl. response
          // extraction). A transient/false-positive rejection must not
          // permanently disable temperature-0 for a model that supports it.
          temperatureUnsupportedModels.add(resolvedModel);
          log.warn(
            {
              event: 'safety.eval_temperature_unsupported',
              model: resolvedModel,
              retrySucceeded: true,
              errKind: err.kind,
              errMsg,
            },
            'Safety eval model rejected temperature; retried without temperature',
          );

          return retryResult;
        } catch (retryErr) {
          // No-temperature retry also failed — do NOT remember the model
          // (the rejection may have been transient). Surface the original
          // temperature-rejection context for postmortems (R3: observable,
          // never silent), then rethrow so doEvaluation's retry loop /
          // fail-closed path handles it.
          log.warn(
            {
              event: 'safety.eval_temperature_unsupported',
              model: resolvedModel,
              retrySucceeded: false,
              errKind: err.kind,
              errMsg,
              retryErrMsg: retryErr instanceof Error ? retryErr.message : String(retryErr),
            },
            'Safety eval model rejected temperature; no-temperature retry also failed',
          );
          throw retryErr;
        }
      }
    },
  };
}

/**
 * Whether a 400 is a temperature-rejection the no-temperature retry can heal.
 *
 * The `deprecated` arm matches sampling-forbidden models: Claude Fable 5 and
 * Opus 4.7/4.8 can say "`temperature` is deprecated for this model.", which
 * the unsupported/not-support arms miss. The primary defence for those models
 * is the BTS sanitizer (`sanitizeBtsOptionsForWireModel`); this regex is the
 * runtime self-heal backstop if a path ever bypasses the chokepoint.
 * @internal Exported for unit testing only.
 */
export function isTemperatureRejectionError(err: unknown): err is ModelError {
  if (!(err instanceof ModelError) || err.kind !== 'invalid_request' || err.status !== 400) {
    return false;
  }

  const rawMessage =
    typeof err.__rawMessage === 'string' ? err.__rawMessage : String(err.__rawMessage ?? '');
  const message = `${err.message}\n${rawMessage}`;

  return (
    /temperature/i.test(message)
    && /unsupported|not support|does not support|only the default|deprecated/i.test(message)
  );
}

export function __resetTemperatureUnsupportedModelsForTesting(): void {
  temperatureUnsupportedModels.clear();
}

function extractResponse(
  response: Awaited<ReturnType<typeof callWithModelAuthAware>>,
  behindTheScenesModel: string | undefined,
): LlmEvalResponse {
  const contentTypes = response.content.map((item) => item.type);
  const hasStructuredOutput = response.structured_output != null;

  const textBlock = response.content.find(
    (item) => item.type === 'text' && typeof item.text === 'string' && item.text.length > 0,
  );

  if (hasStructuredOutput && textBlock?.text) {
    log.info(
      { contentTypes, contentBlockCount: response.content.length },
      'BTS safety eval returned both text and structured_output; preferring structured_output',
    );
  }

  if (hasStructuredOutput) {
    return { text: toTextResponse(response.structured_output) };
  }

  if (textBlock?.text) {
    return { text: textBlock.text };
  }

  // Refusal classification (Fable 5 Stage 6): an always-on-thinking model's
  // safety classifier can refuse the eval call itself (stop_reason: 'refusal'
  // with no text). Classify distinctly so it doesn't masquerade as a generic
  // parse failure in logs/Sentry counts.
  if (response._stopReason === 'refusal') {
    log.warn(
      {
        contentTypes,
        contentBlockCount: response.content.length,
        hasStructuredOutput,
        model: behindTheScenesModel,
        stopReason: 'refusal',
      },
      'BTS safety eval response refused by provider safety classifier (stop_reason: refusal)',
    );
    throw new Error('Safety evaluation LLM response refused by provider safety classifier (stop_reason: refusal)');
  }

  log.warn(
    {
      contentTypes,
      contentBlockCount: response.content.length,
      hasStructuredOutput,
      model: behindTheScenesModel,
      stopReason: (response as unknown as Record<string, unknown>).stop_reason,
    },
    'BTS safety eval returned no usable text or structured output',
  );
  throw new Error('Unexpected response format from safety evaluation LLM');
}

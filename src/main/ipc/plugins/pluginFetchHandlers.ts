/**
 * Plugin external-fetch, context, and AI IPC handlers.
 *
 * Covers: external-fetch, get-contexts, ai-summarize, ai-extract, ai-generate
 */

import type { IpcMainInvokeEvent } from 'electron';
import { registerHandler } from '../utils/registerHandler';
import { pluginsChannels } from '@shared/ipc/channels/plugins';
import { getSettings } from '@core/services/settingsStore';
import { getErrorReporter } from '@core/errorReporter';
import { ModelError } from '@core/rebelCore/modelErrors';
import { callBehindTheScenesWithAuth } from '../../services/behindTheScenesClient';
import { checkRateLimit, recordCall } from '@core/services/pluginAiRateLimiter';
import { createScopedLogger } from '@core/logger';
import { humanizeAgentError } from '@rebel/shared';
import {
  getPluginPreTurnContexts,
  setPluginPreTurnContexts,
} from '../../services/pluginPreTurnContextStore';
import {
  hasPluginPermission,
  getPluginExternalDomains,
} from './shared';
import { getRawErrorMessage } from '../../utils/agentTurnUtils';

const log = createScopedLogger({ service: 'pluginFetchHandlers' });

function throwHumanizedPluginAiError(operation: 'summarize' | 'extract' | 'generate', pluginId: string, error: unknown): never {
  const fallbackMessage = error instanceof Error ? error.message : String(error);
  const rawMessage = getRawErrorMessage(error) || fallbackMessage;
  // Stage 6b migration: classification-first humanization. See
  // docs/plans/260421_classification_driven_error_humanizer.md.
  // Plugin authors receive the humanized message via err.message — contract
  // preserved. Classified ModelError now produces subtype+provider-aware copy
  // (fixes v1 bug: quota errors no longer mis-humanized as "That request was too large").
  const humanizedMessage = humanizeAgentError(
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
  const errorKind = error instanceof ModelError ? error.__agentErrorKind : 'unknown';
  const captureTarget = error instanceof Error ? error : new Error(fallbackMessage);

  log.warn(
    { pluginId, operation, errorKind, rawError: rawMessage },
    'Plugin AI request failed'
  );
  getErrorReporter().captureException(captureTarget, {
    tags: {
      plugin_id: pluginId,
      operation,
      error_kind: errorKind,
      surface: 'plugin_ai',
    },
    extra: {
      rawError: rawMessage,
    },
  });

  throw new Error(humanizedMessage);
}

export function registerPluginFetchHandlers(): void {
  // ── Plugin Contexts ───────────────────────────────────────────────────

  const getContextsChannel = pluginsChannels['plugins:get-contexts'];
  registerHandler(getContextsChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = getContextsChannel.request.parse(request);

    if (validated.contexts) {
      setPluginPreTurnContexts(validated.contexts);
    }

    return { contexts: getPluginPreTurnContexts() };
  });

  // ── Plugin External Fetch (mediated HTTP requests) ─────────────────────

  const externalFetchChannel = pluginsChannels['plugins:external-fetch'];
  registerHandler(externalFetchChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = externalFetchChannel.request.parse(request);
    const { pluginId } = validated;

    // Permission check: plugin must have external-fetch permission
    const hasFetchPermission = await hasPluginPermission(pluginId, 'external-fetch');
    if (!hasFetchPermission) {
      log.warn({ pluginId }, 'Plugin attempted external fetch without external-fetch permission');
      return {
        ok: false,
        status: 0,
        data: null,
        error: `Plugin "${pluginId}" is not authorized for "external-fetch".`,
      };
    }

    // Use manifest-declared domains from persisted store (not renderer-supplied)
    const manifestDomains = await getPluginExternalDomains(pluginId);
    if (manifestDomains.length === 0) {
      log.warn({ pluginId }, 'Plugin has external-fetch permission but no externalDomains declared');
      return {
        ok: false,
        status: 0,
        data: null,
        error: `Plugin "${pluginId}" has no external domains declared in manifest.`,
      };
    }

    const { executePluginFetch } = await import('../../services/pluginExternalFetchService');
    return executePluginFetch({
      url: validated.url,
      method: validated.method,
      headers: validated.headers,
      pluginId,
      allowedDomains: manifestDomains,
    });
  });

  // ── Plugin AI Operations ───────────────────────────────────────────────

  const aiSummarizeChannel = pluginsChannels['plugins:ai-summarize'];
  registerHandler(aiSummarizeChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = aiSummarizeChannel.request.parse(request);
    const { pluginId, text, maxLength } = validated;

    const rateCheck = checkRateLimit(pluginId);
    if (!rateCheck.allowed) {
      throw new Error(`Rate limit exceeded for plugin "${pluginId}". Try again in ${Math.ceil((rateCheck.retryAfterMs ?? 0) / 1000)}s.`);
    }

    // Record call BEFORE dispatch to prevent concurrent bypass
    recordCall(pluginId);

    const settings = getSettings();
    const systemPrompt = maxLength
      ? `Summarize the following text concisely in no more than ${maxLength} words.`
      : 'Summarize the following text concisely.';

    try {
      const response = await callBehindTheScenesWithAuth(settings, {
        messages: [{ role: 'user', content: text }],
        system: systemPrompt,
        maxTokens: 1024,
        timeout: 30000,
      }, { category: 'plugin-ai' });

      const content = response.content?.find((block) => block.type === 'text');
      return { summary: content?.text ?? '' };
    } catch (error) {
      throwHumanizedPluginAiError('summarize', pluginId, error);
    }
  });

  const aiExtractChannel = pluginsChannels['plugins:ai-extract'];
  registerHandler(aiExtractChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = aiExtractChannel.request.parse(request);
    const { pluginId, text, schema } = validated;

    const rateCheck = checkRateLimit(pluginId);
    if (!rateCheck.allowed) {
      throw new Error(`Rate limit exceeded for plugin "${pluginId}". Try again in ${Math.ceil((rateCheck.retryAfterMs ?? 0) / 1000)}s.`);
    }

    // Record call BEFORE dispatch to prevent concurrent bypass
    recordCall(pluginId);

    const settings = getSettings();
    const systemPrompt = `Extract structured data from the following text according to the schema "${schema.name}": ${schema.description}. Return ONLY valid JSON matching the schema.`;

    try {
      const response = await callBehindTheScenesWithAuth(settings, {
        messages: [{ role: 'user', content: text }],
        system: systemPrompt,
        maxTokens: 2048,
        timeout: 30000,
        outputFormat: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: schema.properties,
          },
        },
      }, { category: 'plugin-ai' });

      // Try structured_output first (OAuth path), then parse from text
      if (response.structured_output != null) {
        return { result: response.structured_output };
      }

      const content = response.content?.find((block) => block.type === 'text');
      if (content?.text) {
        try {
          return { result: JSON.parse(content.text) };
        } catch {
          throw new Error('Failed to parse structured output from LLM response');
        }
      }

      throw new Error('No content in LLM response');
    } catch (error) {
      throwHumanizedPluginAiError('extract', pluginId, error);
    }
  });

  const aiGenerateChannel = pluginsChannels['plugins:ai-generate'];
  registerHandler(aiGenerateChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = aiGenerateChannel.request.parse(request);
    const { pluginId, prompt, maxTokens } = validated;

    const rateCheck = checkRateLimit(pluginId);
    if (!rateCheck.allowed) {
      throw new Error(`Rate limit exceeded for plugin "${pluginId}". Try again in ${Math.ceil((rateCheck.retryAfterMs ?? 0) / 1000)}s.`);
    }

    // Record call BEFORE dispatch to prevent concurrent bypass
    recordCall(pluginId);

    const settings = getSettings();

    try {
      const response = await callBehindTheScenesWithAuth(settings, {
        messages: [{ role: 'user', content: prompt }],
        system: 'You are a helpful assistant. Respond directly to the request. Be concise and clear.',
        maxTokens: maxTokens ?? 1000,
        timeout: 30000,
      }, { category: 'plugin-ai' });

      const content = response.content?.find((block) => block.type === 'text');
      return { text: content?.text ?? '' };
    } catch (error) {
      throwHumanizedPluginAiError('generate', pluginId, error);
    }
  });
}

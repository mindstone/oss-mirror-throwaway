import { createHash } from 'node:crypto';
import { createScopedLogger } from '@core/logger';
import { applySelectedPrinciple, isSuspiciousUpdate } from '@core/safetyPromptLogic';
import {
  getSafetyPrompt,
  getSafetyPromptWithMeta,
  updateSafetyPrompt,
} from '@core/safetyPromptStore';
import type {
  BlockedActionContext,
  PersistenceIntentSignal,
  PrincipleOptionScope,
  PrincipleUpdate,
} from '@core/safetyPromptTypes';

const log = createScopedLogger({ service: 'chatIntentRulePersistence' });

export type ChatIntentPersistMode = 'auto' | 'confirm';

export type ChatIntentRulePersistenceResult =
  | {
      status: 'applied';
      applied: true;
      suspicious: false;
      source: 'chat-intent';
      update: PrincipleUpdate;
      version: number;
      lastUpdatedAt: number;
      fullUpdatedPromptHash: string;
    }
  | {
      status: 'skipped';
      applied: false;
      suspicious: boolean;
      source: 'chat-intent';
      reason:
        | 'apply_failed'
        | 'broad_scope_pending_picker_ui'
        | 'confirm_mode'
        | 'same_prompt_version'
        | 'suspicious_update';
      update?: PrincipleUpdate;
      error?: string;
      fullUpdatedPromptHash?: string;
    }
  | {
      status: 'error';
      applied: false;
      suspicious: false;
      source: 'chat-intent';
      error: string;
    };

export interface ApplyChatIntentRulePersistenceArgs {
  blockedAction: BlockedActionContext;
  intentSignal: PersistenceIntentSignal;
  userMessage: string;
  persistMode: ChatIntentPersistMode;
}

export async function applyChatIntentRulePersistence({
  blockedAction,
  intentSignal,
  userMessage,
  persistMode,
}: ApplyChatIntentRulePersistenceArgs): Promise<ChatIntentRulePersistenceResult> {
  let result: ChatIntentRulePersistenceResult | undefined;

  try {
    const safetyPrompt = getSafetyPrompt();
    const selectedLabel = buildSelectedLabel(intentSignal);
    const updateResult = await applySelectedPrinciple(
      safetyPrompt,
      {
        ...blockedAction,
        blockReason: blockedAction.blockReason || 'Allowed by in-chat approval',
      },
      selectedLabel,
      intentSignal.scopeHint,
    );

    if (!updateResult.update) {
      const suspicious = updateResult.error.toLowerCase().includes('too broad');
      result = {
        status: 'skipped',
        applied: false,
        suspicious,
        source: 'chat-intent',
        reason: suspicious ? 'suspicious_update' : 'apply_failed',
        error: updateResult.error,
      };
      return result;
    }

    const update = updateResult.update;
    const fullUpdatedPromptHash = hashPrompt(update.fullUpdatedPrompt);
    const suspicious = isSuspiciousUpdate({
      summary: update.summary,
      proposedPrinciple: update.proposedPrinciple,
    });

    if (suspicious) {
      result = {
        status: 'skipped',
        applied: false,
        suspicious: true,
        source: 'chat-intent',
        reason: 'suspicious_update',
        update,
        fullUpdatedPromptHash,
      };
      return result;
    }

    if (update.fullUpdatedPrompt === safetyPrompt) {
      result = {
        status: 'skipped',
        applied: false,
        suspicious: false,
        source: 'chat-intent',
        reason: 'same_prompt_version',
        update,
        fullUpdatedPromptHash,
      };
      return result;
    }

    if (persistMode !== 'auto') {
      result = {
        status: 'skipped',
        applied: false,
        suspicious: false,
        source: 'chat-intent',
        reason: 'confirm_mode',
        update,
        fullUpdatedPromptHash,
      };
      return result;
    }

    if (intentSignal.scopeHint !== 'specific') {
      result = {
        status: 'skipped',
        applied: false,
        suspicious: false,
        source: 'chat-intent',
        reason: 'broad_scope_pending_picker_ui',
        update,
        fullUpdatedPromptHash,
      };
      return result;
    }

    updateSafetyPrompt(update.fullUpdatedPrompt, 'user', 'chat-intent');
    const meta = getSafetyPromptWithMeta();
    result = {
      status: 'applied',
      applied: true,
      suspicious: false,
      source: 'chat-intent',
      update,
      version: meta.version,
      lastUpdatedAt: meta.lastUpdatedAt,
      fullUpdatedPromptHash,
    };
    return result;
  } catch (error) {
    result = {
      status: 'error',
      applied: false,
      suspicious: false,
      source: 'chat-intent',
      error: error instanceof Error ? error.message : String(error),
    };
    return result;
  } finally {
    const logResult = result ?? {
      status: 'error' as const,
      applied: false,
      suspicious: false,
      source: 'chat-intent' as const,
      error: 'unknown',
    };
    log.info(
      {
        event: 'chat_intent_rule_persistence',
        source: 'chat-intent',
        persistMode,
        scopeHint: intentSignal.scopeHint,
        confidence: intentSignal.confidence,
        applied: logResult.applied,
        suspicious: logResult.suspicious,
        fullUpdatedPromptHash:
          'fullUpdatedPromptHash' in logResult ? logResult.fullUpdatedPromptHash : undefined,
        status: logResult.status,
        reason: 'reason' in logResult ? logResult.reason : undefined,
        error: 'error' in logResult ? logResult.error : undefined,
        triggerPhraseLength: intentSignal.triggerPhrase.length,
        userMessageLength: userMessage.length,
      },
      'Chat intent rule persistence evaluated',
    );
  }
}

function buildSelectedLabel(intentSignal: PersistenceIntentSignal): string {
  const phrase = intentSignal.triggerPhrase.trim().replace(/\s+/g, ' ');
  const prefixByScope: Record<PrincipleOptionScope, string> = {
    specific: 'Remember this exact approval',
    broad: 'Remember this category of approvals',
    trusted_tool: 'Always allow this tool',
  };
  return `${prefixByScope[intentSignal.scopeHint]}: ${phrase}`;
}

function hashPrompt(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf8').digest('hex');
}

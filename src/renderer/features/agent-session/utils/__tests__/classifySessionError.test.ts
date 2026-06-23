import { describe, it, expect } from 'vitest';
import { AGENT_ERROR_KIND_TO_SESSION_CATEGORY, buildAgentSessionErrorFingerprint, classifySessionError } from '../classifySessionError';
import { AGENT_ERROR_KINDS } from '@rebel/shared';

describe('AGENT_ERROR_KIND_TO_SESSION_CATEGORY', () => {
  it('maps every AgentErrorKind (exhaustiveness guard)', () => {
    // The `satisfies Record<AgentErrorKind, SessionErrorCategory>` clause in
    // classifySessionError.ts already enforces this at compile time, but this
    // runtime guard catches any map-vs-tuple drift if the `satisfies` is ever
    // weakened to a looser type.
    for (const kind of AGENT_ERROR_KINDS) {
      expect(AGENT_ERROR_KIND_TO_SESSION_CATEGORY[kind]).toBeDefined();
    }
    expect(Object.keys(AGENT_ERROR_KIND_TO_SESSION_CATEGORY).sort()).toEqual([...AGENT_ERROR_KINDS].sort());
  });

  it('maps moderation to its own Sentry category (not string-fallback bucketed)', () => {
    // Regression guard: the chained-ternary ladder this map replaces had
    // silently omitted `moderation`, causing structural moderation events to
    // fall through to classifySessionError string matching.
    expect(AGENT_ERROR_KIND_TO_SESSION_CATEGORY.moderation).toBe('moderation');
  });

  it('maps all infrastructure/transport kinds to api_error category, with kind-level Sentry fingerprint splits via the structuralKind discriminator', () => {
    expect(AGENT_ERROR_KIND_TO_SESSION_CATEGORY.server_error).toBe('api_error');
    expect(AGENT_ERROR_KIND_TO_SESSION_CATEGORY.model_unavailable).toBe('api_error');
    expect(AGENT_ERROR_KIND_TO_SESSION_CATEGORY.process_exit).toBe('api_error');
    expect(AGENT_ERROR_KIND_TO_SESSION_CATEGORY.message_timeout).toBe('api_error');
    expect(AGENT_ERROR_KIND_TO_SESSION_CATEGORY.routing).toBe('api_error');
  });

  it('maps user-actionable and user-intentional kinds to their filter-out categories', () => {
    expect(AGENT_ERROR_KIND_TO_SESSION_CATEGORY.billing).toBe('billing');
    expect(AGENT_ERROR_KIND_TO_SESSION_CATEGORY.rate_limit).toBe('rate_limit');
    expect(AGENT_ERROR_KIND_TO_SESSION_CATEGORY['connection-not-configured']).toBe('auth_error');
    expect(AGENT_ERROR_KIND_TO_SESSION_CATEGORY.user_action).toBe('user_action');
  });
});

describe('classifySessionError', () => {
  it('classifies billing errors', () => {
    expect(classifySessionError('your api account needs billing attention')).toBe('billing');
    expect(classifySessionError('credit balance is too low')).toBe('billing');
    expect(classifySessionError('insufficient credit to continue')).toBe('billing');
    expect(classifySessionError('add credits at your provider')).toBe('billing');
    expect(classifySessionError("you've reached your api quota limit")).toBe('billing');
    expect(classifySessionError("you've reached your api spending limit")).toBe('billing');
  });

  it('classifies moderation errors', () => {
    expect(classifySessionError("your message was flagged by the model's safety filter. try rephrasing — a less direct framing or more context usually helps.")).toBe('moderation');
    expect(classifySessionError('this request hit moderation and was flagged for safety review')).toBe('moderation');
  });

  it('classifies rate limit errors', () => {
    expect(classifySessionError('rate limit reached. add your own api key')).toBe('rate_limit');
    expect(classifySessionError('rate limit reached on both accounts')).toBe('rate_limit');
    expect(classifySessionError("your ai provider's rate limit was reached. this usually resets within a few minutes")).toBe('rate_limit');
    expect(classifySessionError('taking a quick breather. will continue')).toBe('rate_limit');
    expect(classifySessionError('rate_limit: too many requests')).toBe('rate_limit');
  });

  it('classifies Claude Max synthetic rate limit messages', () => {
    expect(classifySessionError("you've hit your limit · resets 6pm pt")).toBe('rate_limit');
    expect(classifySessionError("you've hit your limit for today")).toBe('rate_limit');
    expect(classifySessionError('usage limit reached. try again later')).toBe('rate_limit');
  });

  it('classifies user-intentional actions', () => {
    expect(classifySessionError('automation was stopped by user before completion')).toBe('user_action');
    expect(classifySessionError('task cancelled by user')).toBe('user_action');
    expect(classifySessionError('task canceled by user')).toBe('user_action');
    expect(classifySessionError('operation stopped by user')).toBe('user_action');
  });

  it('classifies watchdog / unresponsive errors', () => {
    expect(classifySessionError('this turn was unresponsive for 3 minutes and was stopped automatically. please try again.')).toBe('watchdog');
    expect(classifySessionError('this turn was unresponsive for 15 minutes and was stopped automatically. you can try sending your message again.')).toBe('watchdog');
    expect(classifySessionError('watchdog turn aborted')).toBe('watchdog');
    expect(classifySessionError('turn was stopped automatically due to timeout')).toBe('watchdog');
  });

  it('classifies MCP / tool errors', () => {
    expect(classifySessionError('a tool connection failed unexpectedly')).toBe('mcp_error');
    expect(classifySessionError("one of your mcp tools has a name that's too long")).toBe('mcp_error');
    expect(classifySessionError('tool name exceeds limit')).toBe('mcp_error');
    expect(classifySessionError('one of your connected tools has an invalid tool configuration')).toBe('mcp_error');
  });

  it('classifies auth errors (before workspace to avoid misclassification)', () => {
    expect(classifySessionError("there's an issue with your api key")).toBe('auth_error');
    expect(classifySessionError('unauthorized access')).toBe('auth_error');
    expect(classifySessionError('authentication failed')).toBe('auth_error');
    // "api key not configured" should be auth_error, not workspace_error
    expect(classifySessionError('openai api key not configured. please add your api key in settings.')).toBe('auth_error');
  });

  it('classifies workspace / config errors', () => {
    expect(classifySessionError('core directory does not exist or is not accessible: /path')).toBe('workspace_error');
    expect(classifySessionError("your library isn't set up yet. check settings to configure it.")).toBe('workspace_error');
    expect(classifySessionError('the directory is not accessible from the workspace directory')).toBe('workspace_error');
  });

  it('classifies context overflow errors (Anthropic)', () => {
    expect(classifySessionError('this conversation got too long. context overflow detected')).toBe('context_overflow');
    expect(classifySessionError('context is too long to process')).toBe('context_overflow');
  });

  it('classifies context overflow errors (non-Claude providers)', () => {
    // OpenAI: "maximum context length is X tokens"
    expect(classifySessionError("this model's maximum context length is 128000 tokens")).toBe('context_overflow');
    // Google: "input token count exceeds the maximum number of tokens allowed"
    expect(classifySessionError('input token count exceeds the maximum number of tokens allowed')).toBe('context_overflow');
    // Generic token-based patterns
    expect(classifySessionError('the number of tokens exceed the model limit')).toBe('context_overflow');
  });

  it('classifies invalid request errors', () => {
    expect(classifySessionError('the request was invalid. try rephrasing or check settings > diagnose.')).toBe('invalid_request');
    expect(classifySessionError('invalid request: message too large')).toBe('invalid_request');
  });

  it('classifies API / server errors', () => {
    expect(classifySessionError('the api service encountered an error. please try again.')).toBe('api_error');
    expect(classifySessionError('the ai service had a hiccup. please try again.')).toBe('api_error');
    expect(classifySessionError('the api service encountered an error after multiple retries. please try again.')).toBe('api_error');
    expect(classifySessionError('something went wrong.')).toBe('api_error');
    expect(classifySessionError('something unexpected happened. if this keeps occurring, try restarting')).toBe('api_error');
    // New user-friendly error messages (from turnErrorRecovery rewrite)
    expect(classifySessionError('the ai service had a rough patch despite several retries. your message is safe — try again in a moment.')).toBe('api_error');
    expect(classifySessionError('something went wrong mid-conversation. your work so far is saved — try sending your message again to pick up where i left off.')).toBe('api_error');
    expect(classifySessionError('hit a snag. retrying...')).toBe('api_error');
    expect(classifySessionError('the ai took too long to respond. your message is safe — try sending it again.')).toBe('api_error');
    expect(classifySessionError("multi-model setup couldn't start. try sending your message again.")).toBe('api_error');
  });

  // REBEL-5YB / REBEL-5P8: same humanized title fragmented across api_error/server_error
  // vs unknown when structuralKind was absent — 'had a moment' closes the classifier gap.
  it('classifies humanizeProviderServerError "had a moment" variants as api_error', () => {
    expect(classifySessionError('openai codex had a moment. retry — your work so far is saved.')).toBe('api_error');
    expect(classifySessionError('anthropic had a moment. retry — your work so far is saved.')).toBe('api_error');
    expect(classifySessionError('the model service had a moment. retry — your work so far is saved.')).toBe('api_error');
    // Already matched via 'ai service' substring — stays api_error
    expect(classifySessionError('the ai service had a moment.')).toBe('api_error');
  });

  it('does not misclassify non-server errors via the "had a moment" substring (precedence guard)', () => {
    // Earlier branches (billing, rate_limit, moderation, etc.) must still win
    expect(classifySessionError('your api account needs billing attention')).toBe('billing');
    expect(classifySessionError('rate limit reached. add your own api key')).toBe('rate_limit');
    expect(classifySessionError("your message was flagged by the model's safety filter. try rephrasing — a less direct framing or more context usually helps.")).toBe('moderation');
  });

  it('classifies timeout diagnostic messages', () => {
    // Anthropic status issue
    expect(classifySessionError('claude seems to be having a moment (status: major). this is on their side — check status.anthropic.com for updates.')).toBe('api_error');
    // Transient stall
    expect(classifySessionError('the response stalled and timed out. your message is safe — usually a temporary hiccup, try sending it again.')).toBe('api_error');
    // Internet unreachable
    expect(classifySessionError("i couldn't reach the internet just now. check your connection, then try again.")).toBe('api_error');
    // Post-tool variants
    expect(classifySessionError('claude seems to be having a moment (status: minor). this is on their side — check status.anthropic.com for updates. please review anything it changed, then retry.')).toBe('api_error');
    expect(classifySessionError('the response stalled and timed out. your message is safe — usually a temporary hiccup, try sending it again. please review anything it changed, then retry.')).toBe('api_error');
  });

  it('classifies tool connection errors from new messages', () => {
    expect(classifySessionError('a tool connection dropped unexpectedly. try sending your message again.')).toBe('mcp_error');
    expect(classifySessionError('running several conversations at once caused a hiccup. try sending your message again.')).toBe('mcp_error');
  });

  it('does not misclassify generic "please try again" as api_error', () => {
    // Generic messages with "please try again" but no api/service signal should be unknown
    expect(classifySessionError('security validation failed - please try again')).toBe('unknown');
    expect(classifySessionError('operation failed. please try again later.')).toBe('unknown');
  });

  it('returns unknown for unrecognized errors', () => {
    expect(classifySessionError('stderrbuffer is not defined')).toBe('unknown');
    expect(classifySessionError('some completely novel error')).toBe('unknown');
  });
});

describe('buildAgentSessionErrorFingerprint', () => {
  it('uses structuralKind as tertiary discriminator for unknown category when kind is present', () => {
    const longMessage = 'a'.repeat(200);
    expect(
      buildAgentSessionErrorFingerprint({
        errorCategory: 'unknown',
        structuralKind: 'server_error',
        lowerError: longMessage,
      }),
    ).toEqual(['AgentSessionError', 'unknown', 'server_error']);
  });

  it('returns the 80-char message-prefix tuple for unknown category when structuralKind is the literal unknown kind', () => {
    // The 'unknown' AgentErrorKind is the polymorphic bucket — do not double-discriminate
    // with ['AgentSessionError','unknown','unknown']; preserve message-prefix granularity.
    expect(
      buildAgentSessionErrorFingerprint({
        errorCategory: 'unknown',
        structuralKind: 'unknown',
        lowerError: 'some novel error message',
      }),
    ).toEqual(['AgentSessionError', 'unknown', 'some novel error message']);
  });

  it('returns the 80-char message-prefix tuple for unknown category when structuralKind is absent', () => {
    expect(
      buildAgentSessionErrorFingerprint({
        errorCategory: 'unknown',
        structuralKind: undefined,
        lowerError: 'some novel error message',
      }),
    ).toEqual(['AgentSessionError', 'unknown', 'some novel error message']);

    const longMessage = 'x'.repeat(200);
    const fingerprint = buildAgentSessionErrorFingerprint({
      errorCategory: 'unknown',
      structuralKind: undefined,
      lowerError: longMessage,
    });
    expect(fingerprint).toEqual(['AgentSessionError', 'unknown', longMessage.slice(0, 80)]);
    expect(fingerprint[2]).toHaveLength(80);
  });

  it('appends the structuralKind as a secondary discriminator for non-unknown categories', () => {
    expect(
      buildAgentSessionErrorFingerprint({
        errorCategory: 'api_error',
        structuralKind: 'server_error',
        lowerError: 'irrelevant for non-unknown branch',
      }),
    ).toEqual(['AgentSessionError', 'api_error', 'server_error']);

    expect(
      buildAgentSessionErrorFingerprint({
        errorCategory: 'mcp_error',
        structuralKind: 'tool_name_corrupt',
        lowerError: 'irrelevant',
      }),
    ).toEqual(['AgentSessionError', 'mcp_error', 'tool_name_corrupt']);
  });

  it('returns the 2-tuple for non-unknown categories when structuralKind is absent', () => {
    expect(
      buildAgentSessionErrorFingerprint({
        errorCategory: 'rate_limit',
        structuralKind: undefined,
        lowerError: 'rate limit reached',
      }),
    ).toEqual(['AgentSessionError', 'rate_limit']);

    expect(
      buildAgentSessionErrorFingerprint({
        errorCategory: 'workspace_error',
        structuralKind: undefined,
        lowerError: 'core directory does not exist',
      }),
    ).toEqual(['AgentSessionError', 'workspace_error']);
  });
});

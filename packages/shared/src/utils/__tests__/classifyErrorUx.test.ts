import { describe, expect, it } from 'vitest';

import { AGENT_ERROR_KINDS, type AgentErrorKind } from '../agentErrorCatalog';
import { categoryForKind, classifyErrorUx } from '../classifyErrorUx';

describe('classifyErrorUx', () => {
  it('returns the canonical category for every AgentErrorKind', () => {
    for (const kind of AGENT_ERROR_KINDS) {
      expect(
        classifyErrorUx({ errorKind: kind, rawMessage: '' }).category,
      ).toBe(categoryForKind(kind));
    }
  });

  it('connection-not-configured routes a Mindstone user to the subscription panel, not providerKeys', () => {
    const resolution = classifyErrorUx({
      errorKind: 'connection-not-configured',
      rawMessage: "Your Mindstone subscription isn't ready yet.",
      settingsContext: {
        activeProvider: 'mindstone',
        hasAnthropicCredentials: false,
        hasOpenRouterCredentials: false,
        hasCodexSubscription: false,
      },
    });

    expect(resolution.alternatives).toEqual([
      {
        label: 'Open settings',
        action: 'open-settings',
        payload: { settingsSection: 'subscription' },
        variant: 'primary',
      },
    ]);
    expect(resolution).toMatchObject({ title: 'Mindstone subscription not ready.' });
  });

  it('auth routes a Mindstone user to the subscription panel, not providerKeys', () => {
    const resolution = classifyErrorUx({
      errorKind: 'auth',
      rawMessage: 'Your Mindstone subscription key is not available.',
      settingsContext: {
        activeProvider: 'mindstone',
        hasAnthropicCredentials: false,
        hasOpenRouterCredentials: false,
        hasCodexSubscription: false,
      },
    });

    expect(resolution.alternatives[0]?.payload).toEqual({ settingsSection: 'subscription' });
    expect(resolution).toMatchObject({ title: 'Mindstone subscription needs attention.' });
  });

  it('auth keeps the providerKeys panel for non-Mindstone providers', () => {
    const resolution = classifyErrorUx({
      errorKind: 'auth',
      rawMessage: 'Invalid API key',
      settingsContext: {
        activeProvider: 'anthropic',
        hasAnthropicCredentials: true,
        hasOpenRouterCredentials: false,
        hasCodexSubscription: false,
      },
    });

    expect(resolution.alternatives[0]?.payload).toEqual({ settingsSection: 'providerKeys' });
  });

  it('connection-not-configured degrades to the generic providerKeys panel when settingsContext is absent', () => {
    const resolution = classifyErrorUx({
      errorKind: 'connection-not-configured',
      rawMessage: 'OpenRouter needs reconnecting.',
    });

    expect(resolution.alternatives[0]?.payload).toEqual({ settingsSection: 'providerKeys' });
    expect(resolution).toMatchObject({
      title: 'Connection not configured.',
      body: 'Connect the provider in Settings, then try again.',
    });
  });

  it('connection-not-configured names ChatGPT Pro for a disconnected codex provider and never implies rejection', () => {
    const resolution = classifyErrorUx({
      errorKind: 'connection-not-configured',
      // The incident raw provider is "OpenAI" on a codex turn — must NOT be echoed.
      provider: 'OpenAI',
      rawMessage:
        'ChatGPT Pro is disconnected. Reconnect it in Settings, or switch to another provider.',
      settingsContext: {
        activeProvider: 'codex',
        hasAnthropicCredentials: true,
        hasOpenRouterCredentials: false,
        hasCodexSubscription: false,
      },
    });

    expect(resolution).toMatchObject({
      title: 'ChatGPT Pro is disconnected.',
      body: 'Reconnect it in Settings, or switch to another provider. Your message is safe.',
    });
    expect(resolution.alternatives).toEqual([
      {
        label: 'Reconnect',
        action: 'open-settings',
        payload: { settingsSection: 'providerKeys' },
        variant: 'primary',
      },
    ]);
    // Trust guard: the toast must not claim a credential was rejected.
    expect(resolution.body).not.toMatch(/rejected the credentials/i);
    // Trap guard: do not echo the raw "OpenAI" provider for a codex turn.
    expect(resolution.title).not.toMatch(/OpenAI/);
  });

  it('invalid_request: gives actionable tool-use copy for the Gemini thought_signature gateway error (REBEL-5RJ)', () => {
    const resolution = classifyErrorUx({
      errorKind: 'invalid_request',
      rawMessage:
        'Function call is missing a thought_signature in functionCall parts. This is required for tools to work correctly.',
    });
    // Tool-specific, non-cryptic guidance — not the generic invalid_request copy.
    expect(resolution.title).toMatch(/use its tools/i);
    expect(resolution.body).toMatch(/gateway/i);
    // Must not dump the raw "thought_signature" jargon at the user.
    expect(resolution.body).not.toMatch(/thought.?signature/i);
    expect(resolution.alternatives?.some((a) => a.action === 'retry')).toBe(true);
  });

  it('connection-not-configured names OpenRouter for a disconnected openrouter provider', () => {
    const resolution = classifyErrorUx({
      errorKind: 'connection-not-configured',
      rawMessage: 'OpenRouter needs reconnecting.',
      settingsContext: {
        activeProvider: 'openrouter',
        hasAnthropicCredentials: false,
        hasOpenRouterCredentials: false,
        hasCodexSubscription: false,
      },
    });

    expect(resolution).toMatchObject({
      title: 'OpenRouter is disconnected.',
      body: 'Reconnect it in Settings, or switch to another provider. Your message is safe.',
    });
    expect(resolution.alternatives).toEqual([
      {
        label: 'Reconnect',
        action: 'open-settings',
        payload: { settingsSection: 'providerKeys' },
        variant: 'primary',
      },
    ]);
    expect(resolution.body).not.toMatch(/rejected the credentials/i);
  });

  it('connection-not-configured prompts for a key (not a reconnect) when the anthropic key is missing', () => {
    const resolution = classifyErrorUx({
      errorKind: 'connection-not-configured',
      rawMessage: 'Authentication is missing. Please add an API key.',
      settingsContext: {
        activeProvider: 'anthropic',
        hasAnthropicCredentials: false,
        hasOpenRouterCredentials: false,
        hasCodexSubscription: false,
      },
    });

    expect(resolution).toMatchObject({
      title: 'No Anthropic key yet.',
      body: 'Add your Anthropic API key in Settings, then try again. Your message is safe.',
    });
    expect(resolution.alternatives[0]?.label).toBe('Add key');
    expect(resolution.alternatives[0]?.payload).toEqual({ settingsSection: 'providerKeys' });
    // API-key provider, not OAuth: must not tell the user to "reconnect" a key.
    expect(resolution.body).not.toMatch(/reconnect/i);
    expect(resolution.body).not.toMatch(/rejected the credentials/i);
  });

  it('unsupported_model Variant A offers a same-provider model when no alternative provider credentials exist', () => {
    const resolution = classifyErrorUx({
      errorKind: 'unsupported_model',
      rawMessage: 'codex-unsupported-model',
      unsupportedModelId: 'gpt-5.5-pro',
      settingsContext: {
        activeProvider: 'codex',
        currentModel: 'gpt-5.5-pro',
        hasAnthropicCredentials: false,
        hasOpenRouterCredentials: false,
        hasCodexSubscription: true,
      },
    });

    expect(resolution.alternatives).toEqual([
      {
        label: 'Use GPT-5.5',
        action: 'switch-model',
        payload: { model: 'gpt-5.5' },
        variant: 'primary',
      },
      {
        label: 'Open settings',
        action: 'open-settings',
        payload: { settingsSection: 'providerKeys' },
        variant: 'secondary',
      },
    ]);
    expect(resolution).toMatchObject({
      title: "ChatGPT Pro doesn't run GPT-5.5 Pro.",
      body: 'Pick a model that works on your subscription, or switch providers.',
    });
    expect(resolution.defaultAction).toBe(resolution.alternatives[0]);
  });

  it('unsupported_model Variant B opens model settings when no same-provider alternative exists', () => {
    const resolution = classifyErrorUx({
      errorKind: 'unsupported_model',
      rawMessage: 'codex-unsupported-model',
      unsupportedModelId: 'gpt-5.5',
      settingsContext: {
        activeProvider: 'codex',
        currentModel: 'gpt-5.5',
        hasAnthropicCredentials: true,
        hasOpenRouterCredentials: false,
        hasCodexSubscription: true,
      },
    });

    expect(resolution.alternatives).toEqual([
      {
        label: 'Choose another',
        action: 'open-settings',
        payload: { settingsSection: 'model' },
        variant: 'primary',
      },
    ]);
    expect(resolution).toMatchObject({
      title: "This model isn't available on your subscription.",
      body: 'Choose another to keep going.',
    });
  });

  it('unsupported_model falls back to Variant A (same-provider switch-model) when settingsContext is undefined', () => {
    const resolution = classifyErrorUx({
      errorKind: 'unsupported_model',
      rawMessage: 'codex-unsupported-model',
      unsupportedModelId: 'gpt-5.5-pro',
    });

    expect(resolution.alternatives).toEqual([
      {
        label: 'Use GPT-5.5',
        action: 'switch-model',
        payload: { model: 'gpt-5.5' },
        variant: 'primary',
      },
      {
        label: 'Open settings',
        action: 'open-settings',
        payload: { settingsSection: 'providerKeys' },
        variant: 'secondary',
      },
    ]);
    expect(resolution.defaultAction).toBe(resolution.alternatives[0]);
  });

  // FOX-3494 (Option Y): a native-Claude model selected for a PRIMARY turn while
  // on ChatGPT Pro (Codex) with no Anthropic key dead-ends as a
  // ConnectionNotConfiguredError carrying invalidReason
  // 'missing-anthropic-credentials-for-claude-model'. Keeping the error class
  // preserves every existing recoverable-terminal gate; classifyErrorUx leads
  // with switch-to-GPT under the connection-not-configured branch. Honest,
  // model-aware attribution — never a bare "Anthropic not connected".
  it('connection-not-configured (codex + claude-* reason) leads with switch-to-GPT and offers add-Anthropic-key secondary', () => {
    const resolution = classifyErrorUx({
      errorKind: 'connection-not-configured',
      rawMessage: 'connection-not-configured',
      invalidReason: 'missing-anthropic-credentials-for-claude-model',
      unsupportedModelId: 'claude-opus-4-8',
      failedRole: 'execution',
      settingsContext: {
        activeProvider: 'codex',
        currentModel: 'claude-opus-4-8',
        hasAnthropicCredentials: false,
        hasOpenRouterCredentials: false,
        hasCodexSubscription: true,
      },
    });

    expect(resolution).toMatchObject({
      title: "Claude isn't available on ChatGPT Pro.",
    });
    expect(resolution.body).toContain('ChatGPT Pro');
    expect(resolution.body).toContain('Anthropic');
    expect(resolution.body).toContain('Your message is safe.');
    expect(resolution.alternatives).toEqual([
      {
        label: 'Switch to GPT-5.5',
        action: 'switch-model',
        payload: { model: 'gpt-5.5', failedRole: 'execution' },
        variant: 'primary',
      },
      {
        label: 'Add an Anthropic key',
        action: 'open-settings',
        payload: { settingsSection: 'providerKeys' },
        variant: 'secondary',
      },
    ]);
    expect(resolution.defaultAction).toBe(resolution.alternatives[0]);
  });

  // FOX-3494 (F1): a PLANNING-role failure carries failedRole:'planning' into the
  // switch-model payload so the IPC handler repairs the thinking slot (not just
  // the working model) — preventing the retry loop.
  it('connection-not-configured (codex + claude-* reason, planning role) carries failedRole into the switch-model payload', () => {
    const resolution = classifyErrorUx({
      errorKind: 'connection-not-configured',
      rawMessage: 'connection-not-configured',
      invalidReason: 'missing-anthropic-credentials-for-claude-model',
      unsupportedModelId: 'claude-opus-4-8',
      failedRole: 'planning',
      settingsContext: {
        activeProvider: 'codex',
        currentModel: 'claude-opus-4-8',
        hasAnthropicCredentials: false,
        hasOpenRouterCredentials: false,
        hasCodexSubscription: true,
      },
    });
    expect(resolution.alternatives[0]).toEqual({
      label: 'Switch to GPT-5.5',
      action: 'switch-model',
      payload: { model: 'gpt-5.5', failedRole: 'planning' },
      variant: 'primary',
    });
  });

  // Gateway-profile recovery: when the user has a selectable profile that serves the
  // failed model (e.g. a custom OpenAI-compatible gateway proxying claude-opus-4-8),
  // the claude-under-ChatGPT-Pro recovery LEADS with "Use <profile>" (switches to the
  // profile, which routes through the gateway) instead of only offering switch-to-GPT.
  it('claude-under-codex leads with "Use <profile>" when a profile serves the failed model', () => {
    const resolution = classifyErrorUx({
      errorKind: 'connection-not-configured',
      rawMessage: 'connection-not-configured',
      invalidReason: 'missing-anthropic-credentials-for-claude-model',
      unsupportedModelId: 'claude-opus-4-8',
      failedRole: 'execution',
      settingsContext: {
        activeProvider: 'codex',
        currentModel: 'claude-opus-4-8',
        hasAnthropicCredentials: false,
        hasOpenRouterCredentials: false,
        hasCodexSubscription: true,
        recoveryProfiles: [
          { id: 'test-gw', name: 'Test Gateway', model: 'claude-opus-4-8' },
        ],
      },
    });

    expect(resolution.alternatives[0]).toEqual({
      label: 'Use Test Gateway',
      action: 'switch-model',
      payload: { model: 'profile:test-gw', failedRole: 'execution' },
      variant: 'primary',
    });
    expect(resolution.defaultAction).toBe(resolution.alternatives[0]);
  });

  // Gateway-profile recovery (generic Anthropic-no-key terminal): same idea for a user
  // whose active provider is Anthropic with no key but who has a gateway profile serving
  // the failed model. Leads with "Use <profile>".
  it('generic anthropic connection-not-configured leads with "Use <profile>" when a profile serves the failed model', () => {
    const resolution = classifyErrorUx({
      errorKind: 'connection-not-configured',
      rawMessage: 'connection-not-configured',
      unsupportedModelId: 'claude-opus-4-8',
      failedRole: 'execution',
      settingsContext: {
        activeProvider: 'anthropic',
        currentModel: 'claude-opus-4-8',
        hasAnthropicCredentials: false,
        hasOpenRouterCredentials: false,
        hasCodexSubscription: false,
        recoveryProfiles: [
          { id: 'test-gw', name: 'Test Gateway', model: 'claude-opus-4-8' },
        ],
      },
    });

    expect(resolution.alternatives[0]).toEqual({
      label: 'Use Test Gateway',
      action: 'switch-model',
      payload: { model: 'profile:test-gw', failedRole: 'execution' },
      variant: 'primary',
    });
  });

  // The provider's actual rejection reason should reach the user verbatim-ish, not be
  // hidden behind generic "The AI service rejected the request" copy (gw REBEL-5RJ).
  it('invalid_request surfaces the upstream provider message in the body', () => {
    const resolution = classifyErrorUx({
      errorKind: 'invalid_request',
      rawMessage:
        '"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.',
    });
    expect(resolution.body).toContain('thinking.type.adaptive');
    expect(resolution.alternatives.some((a) => a.action === 'retry')).toBe(true);
  });

  it('invalid_request keeps generic copy when no meaningful upstream message is present', () => {
    const resolution = classifyErrorUx({ errorKind: 'invalid_request', rawMessage: '' });
    expect(resolution.title).toBe('The AI service rejected the request.');
    expect(resolution.body).toContain('Your message is safe');
  });

  // Review F3: a profile whose model is the canonical dashed id (claude-opus-4-8) still
  // matches a failed model expressed as the dotted alias (claude-opus-4.8).
  it('matches a recovery profile across the dotted/dashed Claude alias', () => {
    const resolution = classifyErrorUx({
      errorKind: 'connection-not-configured',
      rawMessage: 'connection-not-configured',
      unsupportedModelId: 'claude-opus-4.8',
      failedRole: 'execution',
      settingsContext: {
        activeProvider: 'anthropic',
        hasAnthropicCredentials: false,
        hasOpenRouterCredentials: false,
        hasCodexSubscription: false,
        recoveryProfiles: [{ id: 'test-gw', name: 'Test Gateway', model: 'claude-opus-4-8' }],
      },
    });

    expect(resolution.alternatives[0]).toMatchObject({
      action: 'switch-model',
      payload: { model: 'profile:test-gw', failedRole: 'execution' },
    });
  });

  // FOX-3494 (#4): the actionable branch discriminates on the EXACT invalidReason.
  // A generic connection-not-configured under codex (no claude-* reason) keeps the
  // existing "ChatGPT Pro is disconnected" reconnect copy — it must NOT mis-fire.
  it('connection-not-configured (codex, no claude-* reason) keeps the generic reconnect copy', () => {
    const resolution = classifyErrorUx({
      errorKind: 'connection-not-configured',
      rawMessage: 'connection-not-configured',
      settingsContext: {
        activeProvider: 'codex',
        hasAnthropicCredentials: false,
        hasOpenRouterCredentials: false,
        hasCodexSubscription: true,
      },
    });
    expect(resolution.title).toBe('ChatGPT Pro is disconnected.');
  });

  // FOX-3494 (F2): the claude-* reason should never reach classifyErrorUx for a
  // non-codex active provider (the producer gates on activeProvider==='codex'),
  // but defend in depth — if it somehow does, keep the generic copy rather than
  // mis-attributing to ChatGPT Pro.
  it('connection-not-configured (claude-* reason, NON-codex active provider) does NOT show ChatGPT Pro copy', () => {
    const resolution = classifyErrorUx({
      errorKind: 'connection-not-configured',
      rawMessage: 'connection-not-configured',
      invalidReason: 'missing-anthropic-credentials-for-claude-model',
      unsupportedModelId: 'claude-opus-4-8',
      settingsContext: {
        activeProvider: 'anthropic',
        hasAnthropicCredentials: false,
        hasOpenRouterCredentials: false,
        hasCodexSubscription: false,
      },
    });
    expect(resolution.title).not.toBe("Claude isn't available on ChatGPT Pro.");
    expect(resolution.title).toBe('No Anthropic key yet.');
  });

  it('unsupported_model (codex + non-claude model) keeps the existing GPT-5.5-Pro variant (no regression)', () => {
    const resolution = classifyErrorUx({
      errorKind: 'unsupported_model',
      rawMessage: 'codex-unsupported-model',
      unsupportedModelId: 'gpt-5.5-pro',
      settingsContext: {
        activeProvider: 'codex',
        currentModel: 'gpt-5.5-pro',
        hasAnthropicCredentials: false,
        hasOpenRouterCredentials: false,
        hasCodexSubscription: true,
      },
    });
    expect(resolution.title).toBe("ChatGPT Pro doesn't run GPT-5.5 Pro.");
  });

  it.each(['auth', 'billing'] satisfies AgentErrorKind[])(
    '%s includes an open-settings action',
    (kind) => {
      const resolution =
        kind === 'billing'
          ? classifyErrorUx({
              errorKind: kind,
              rawMessage: '',
              billingMeta: {
                subtype: 'credits',
                upstreamProviderName: 'OpenRouter',
              },
            })
          : classifyErrorUx({
              errorKind: kind,
              rawMessage: '',
            });

      expect(
        resolution.alternatives.some(
          (action) => action.action === 'open-settings',
        ),
      ).toBe(true);
    },
  );

  it('image_input_unsupported LEADS with switch-model and keeps retry secondary (260610 DA F2)', () => {
    const resolution = classifyErrorUx({
      errorKind: 'image_input_unsupported',
      rawMessage:
        '{"error":{"message":"No endpoints found that support image input","code":404}}',
    });

    // A tool-result image is baked into history: retry loops forever, so the
    // primary action must be switching to a vision-capable model.
    expect(resolution.category).toBe('unsupported-feature');
    expect(resolution.persistent).toBe(true);
    expect(resolution.title).toBe("This model can't view images.");
    expect(resolution.body).toMatch(/vision-capable model/i);
    expect(resolution.alternatives).toEqual([
      {
        label: 'Switch model',
        action: 'open-settings',
        payload: { settingsSection: 'models' },
        variant: 'primary',
      },
      { label: 'Try again', action: 'retry', variant: 'secondary' },
    ]);
    expect(resolution.defaultAction).toMatchObject({ action: 'open-settings' });
  });

  it('rate_limit with retryAfterMs remains non-persistent', () => {
    const resolution = classifyErrorUx({
      errorKind: 'rate_limit',
      rawMessage: '429',
      rateLimitMeta: { retryAfterMs: 12_000 },
    });

    expect(resolution.persistent).toBe(false);
    expect(resolution.body).toContain('12 seconds');
  });

  it('network is transient, retry-first, and never interpolates raw transport details', () => {
    const resolution = classifyErrorUx({
      errorKind: 'network',
      rawMessage: 'UND_ERR_CONNECT_TIMEOUT chatgpt.com 2606:4700::1',
    });
    const rendered = [
      resolution.title,
      resolution.body,
      ...resolution.alternatives.map((action) => action.label),
    ].join(' ');

    expect(categoryForKind('network')).toBe('transient');
    expect(resolution.persistent).toBe(false);
    expect(resolution.defaultAction).toMatchObject({ label: 'Try again', action: 'retry' });
    expect(resolution.alternatives[1]).toMatchObject({
      label: 'Check connections',
      action: 'open-settings',
      payload: { settingsSection: 'diagnose' },
      variant: 'secondary',
    });
    expect(rendered).toContain("Can't reach the AI service.");
    expect(rendered).not.toContain('UND_ERR_CONNECT_TIMEOUT');
    expect(rendered).not.toContain('chatgpt.com');
    expect(rendered).not.toContain('2606:4700::1');
  });

  it('rate_limit with plan-scoped limit uses subscription-window guidance', () => {
    const resolution = classifyErrorUx({
      errorKind: 'rate_limit',
      rawMessage: 'usage limit reached',
      limitScope: 'plan',
      rateLimitMeta: { retryAfterMs: 30_000 },
    });

    expect(resolution.body).toBe(
      'Your subscription usage window is tapped out. Try again in about 30 seconds, or switch providers in Settings.',
    );
  });

  it('billing with plan-scoped limit uses subscription allowance guidance', () => {
    const resolution = classifyErrorUx({
      errorKind: 'billing',
      rawMessage: 'usage_limit_reached',
      limitScope: 'plan',
    });

    expect(resolution.body).toBe(
      'Your subscription plan has hit its usage allowance. Open Settings to switch plans or provider.',
    );
  });

  it('unknown returns a non-empty fallback resolution', () => {
    const resolution = classifyErrorUx({
      errorKind: 'unknown',
      rawMessage: '',
    });

    expect(resolution).toMatchObject({
      category: 'unknown',
      persistent: true,
    });
    expect(resolution.title.length).toBeGreaterThan(0);
    expect(resolution.body.length).toBeGreaterThan(0);
  });

  describe('chief-of-staff-unavailable (260622 Stage 4)', () => {
    it('reconnecting is transient/info with Try again + an always-offered proceed-without escape (never trapped)', () => {
      const resolution = classifyErrorUx({
        errorKind: 'chief-of-staff-unavailable',
        rawMessage: '',
        chiefOfStaffReason: 'reconnecting',
      });
      expect(resolution.category).toBe('transient');
      // transient → dismissible (not blocking)
      expect(resolution.persistent).toBe(false);
      expect(resolution.title).toBe('Reconnecting to your drive.');
      expect(resolution.body).toContain('your drive');
      expect(resolution.body).not.toMatch(/FUSE|symlink|EACCES|ENOENT|errno/i);
      // The escape is always present so a dead drive can never trap the user.
      expect(resolution.alternatives.map((a) => a.action)).toEqual([
        'retry',
        'proceed-without-chief-of-staff',
      ]);
    });

    it('unreadable is user-fixable/warning with Try again + Open the file (reveal sentinel)', () => {
      const resolution = classifyErrorUx({
        errorKind: 'chief-of-staff-unavailable',
        rawMessage: '',
        chiefOfStaffReason: 'unreadable',
      });
      expect(resolution.category).toBe('user-fixable');
      expect(resolution.persistent).toBe(true);
      expect(resolution.title).toBe("Can't read your Chief-of-Staff instructions.");
      expect(resolution.body).not.toMatch(/FUSE|symlink|EACCES|ENOENT|errno/i);
      expect(resolution.alternatives.map((a) => a.action)).toEqual(['retry', 'open-settings']);
      // "Open the file" reuses open-settings with the reveal sentinel section.
      expect(resolution.alternatives[1]?.payload?.settingsSection).toBe(
        'reveal-chief-of-staff-readme',
      );
    });

    it('missing-after-setup is user-fixable/warning with Recreate + proceed-without', () => {
      const resolution = classifyErrorUx({
        errorKind: 'chief-of-staff-unavailable',
        rawMessage: '',
        chiefOfStaffReason: 'missing-after-setup',
      });
      expect(resolution.category).toBe('user-fixable');
      expect(resolution.persistent).toBe(true);
      expect(resolution.title).toBe('Your Chief-of-Staff instructions are missing.');
      expect(resolution.alternatives.map((a) => a.action)).toEqual([
        'recreate-chief-of-staff',
        'proceed-without-chief-of-staff',
      ]);
    });

    it('no reason supplied falls back to a calm single Try again (kind default category)', () => {
      const resolution = classifyErrorUx({
        errorKind: 'chief-of-staff-unavailable',
        rawMessage: '',
      });
      expect(resolution.category).toBe('user-fixable');
      expect(resolution.alternatives).toHaveLength(1);
      expect(resolution.alternatives[0]?.action).toBe('retry');
    });
  });

  it('keeps alternatives within the Notice action cap for every kind', () => {
    const counts = Object.fromEntries(
      AGENT_ERROR_KINDS.map((kind) => {
        const resolution = classifyErrorUx({ errorKind: kind, rawMessage: '' });
        expect(resolution.alternatives.length).toBeLessThanOrEqual(2);
        return [kind, resolution.alternatives.length];
      }),
    );

    expect(counts).toMatchInlineSnapshot(`
      {
        "auth": 1,
        "billing": 1,
        "chief-of-staff-unavailable": 1,
        "connection-not-configured": 1,
        "context_overflow": 1,
        "image_input_unsupported": 2,
        "invalid_request": 2,
        "managed_model_not_allowed": 2,
        "mcp_error": 2,
        "message_timeout": 1,
        "model_unavailable": 1,
        "moderation": 1,
        "network": 2,
        "process_exit": 1,
        "rate_limit": 1,
        "routing": 2,
        "server_error": 1,
        "session_not_found": 1,
        "tool_name_corrupt": 2,
        "unknown": 2,
        "unsupported_model": 2,
        "user_action": 0,
      }
    `);
  });
});

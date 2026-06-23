import { useState, useRef, useEffect, useCallback } from 'react';
import { Loader2, Check, Info } from 'lucide-react';
import { Button, Tooltip, Input, Label } from '@renderer/components/ui';
import { validateEmail, validateFirstName } from '@core/services/identity/userIdentityValidation';
import { useOpenRouterSetup } from '@renderer/hooks/useOpenRouterSetup';
import { useSubscriptionState } from '@renderer/hooks/useSubscriptionState';
import { OpenRouterPrivacyModal } from '@renderer/components/OpenRouterPrivacyModal';
import { OpenAILogo, OpenRouterLogo, AnthropicLogo } from '@renderer/features/settings/components/ProviderLogos';
import { tracking } from '@renderer/src/tracking';
import { rendererIsOss } from '../../../src/rendererIsOss';
import type { AppSettings, ActiveProvider, SubscriptionTier, ModelSettings } from '@shared/types';
import { planProviderSwitch } from '@shared/utils/providerSwitch';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { getApiKey } from '@renderer/features/settings/utils/modelAuthAccessors';
import styles from '../OnboardingWizard.module.css';
import settingsStyles from '@renderer/features/settings/components/SettingsSurface.module.css';
import type { ApiStepProps } from './types';

const VALIDATION_DEBOUNCE_MS = 500;
const ANTHROPIC_API_KEY_URL = 'https://platform.claude.com/settings/keys';
const API_KEY_WALKTHROUGH_URL = 'https://app.arcade.software/share/KBwVIlB5Ln58J7C697EV?ref=share-link';
const CHATGPT_PRO_PRICING_URL = 'https://chatgpt.com/pricing';

const sanitizeApiKey = (value: string): string => value.replace(/\s/g, '');

export const ApiStep = ({
  state,
  draftSettings,
  updateDraft,
  updateClaude,
  isValidatingClaude,
  claudeValidationMessage,
  claudeValidationOk,
  validateClaudeKey,
}: ApiStepProps) => {
  const { claudeReady, triedContinue } = state;

  const hasOrToken = !!draftSettings.openRouter?.oauthToken;
  const orSetup = useOpenRouterSetup(hasOrToken);
  const [showOrPrivacy, setShowOrPrivacy] = useState(false);
  const orConnected = hasOrToken || orSetup.phase === 'success';

  const handleOrConnect = () => setShowOrPrivacy(true);
  const handleOrPrivacyAccept = () => {
    setShowOrPrivacy(false);
    void orSetup.handleConnect();
  };

  const claudeValidationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const apiKey = getApiKey(draftSettings);
  const hasApiKey = !!apiKey && claudeValidationOk === true;
  const claudeConnected = hasApiKey;

  // Codex OAuth state — mirrors AgentsTab pattern
  const [codexStatus, setCodexStatus] = useState<{ connected: boolean; accountEmail?: string }>({ connected: false });
  const [codexLoading, setCodexLoading] = useState(false);
  const [codexError, setCodexError] = useState<string | null>(null);

  const { subscription, isActive: subscriptionActive, isPastDueWithinGrace } = useSubscriptionState();
  const [checkoutLoadingTier, setCheckoutLoadingTier] = useState<SubscriptionTier | null>(null);
  const [subscriptionError, setSubscriptionError] = useState<string | null>(null);

  useEffect(() => {
    window.codexApi
      ?.status()
      .then(setCodexStatus)
      .catch((error: unknown) => {
        // Best-effort: a failed Codex OAuth status probe just leaves the default
        // disconnected state; it must not break onboarding render.
        ignoreBestEffortCleanup(error, {
          operation: 'onboarding.apiStep.codexStatusProbe',
          reason: 'optional-codex-oauth-status-on-mount',
        });
      });
    return () => {
      if (claudeValidationTimerRef.current) clearTimeout(claudeValidationTimerRef.current);
    };
  }, []);

  const codexConnected = codexStatus.connected;
  const subscriptionEntitled = subscriptionActive || isPastDueWithinGrace;
  const routingAvailable = subscription?.routingAvailable === true;

  // Provider selection state — tri-state: codex / openrouter / anthropic
  const activeProvider: ActiveProvider | undefined = draftSettings.activeProvider ??
    (draftSettings.openRouter?.enabled && draftSettings.openRouter?.oauthToken ? 'openrouter' : undefined);

  const applyClaudeState = useCallback((nextClaude: Partial<ModelSettings>) => {
    for (const key of Object.keys(nextClaude) as Array<keyof ModelSettings>) {
      if (Object.is(draftSettings.models[key], nextClaude[key])) {
        continue;
      }
      updateClaude(key, nextClaude[key] as ModelSettings[typeof key]);
    }
  }, [draftSettings.models, updateClaude]);

  const handleProviderSelect = useCallback((provider: ActiveProvider) => {
    if (draftSettings.activeProvider === provider) {
      return;
    }

    const plan = planProviderSwitch({
      to: provider,
      settings: draftSettings,
      codexConnected,
    });

    for (const [key, value] of Object.entries(plan.updates) as Array<[keyof AppSettings, AppSettings[keyof AppSettings]]>) {
      if (key === 'openRouter') {
        continue;
      }
      if (key === 'claude') {
        applyClaudeState(value as Partial<ModelSettings>);
        continue;
      }
      updateDraft(key, value as never);
    }
  }, [applyClaudeState, codexConnected, draftSettings, updateDraft]);

  // Codex OAuth — triggers real browser login, only applies defaults on success
  const handleCodexConnect = useCallback(async () => {
    setCodexLoading(true);
    setCodexError(null);
    try {
      const result = await window.codexApi.login();
      if (result.success) {
        setCodexStatus({ connected: true, accountEmail: result.email });
        handleProviderSelect('codex');
      } else {
        setCodexError(result.error ?? "Couldn't connect. Please try again.");
      }
    } catch {
      setCodexError("Couldn't connect. Please try again.");
    } finally {
      setCodexLoading(false);
    }
  }, [handleProviderSelect]);

  // Auto-select provider on successful connection.
  // Guards prevent late-arriving results from overriding an already-connected provider.
  useEffect(() => {
    if (orConnected && !codexConnected && !claudeConnected && activeProvider !== 'openrouter') {
      handleProviderSelect('openrouter');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: omitting codexConnected/claudeConnected/activeProvider/handleProviderSelect; auto-select must fire on the OR connection transition only, not on every guard-value change that would re-trigger after a late-arriving competing connection
  }, [orConnected]);

  useEffect(() => {
    if (claudeValidationOk && !codexConnected && !orConnected && activeProvider !== 'anthropic') {
      handleProviderSelect('anthropic');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: omitting codexConnected/orConnected/activeProvider/handleProviderSelect; same late-arriving-guard pattern as the openrouter effect above — fire only on claudeValidationOk transition
  }, [claudeValidationOk]);

  useEffect(() => {
    // Respect a deliberate switch away from managed Mindstone: once the user has
    // opted out, this auto-select must not snap them back. Mirrors the canonical
    // `userOptedOutOfManaged` guard in authService.extractManagedProviderInfo, so
    // first-time activation (flag unset) still auto-selects Mindstone.
    const userOptedOutOfManaged =
      draftSettings.managedProviderDeactivated === true && activeProvider !== 'mindstone';
    if (
      subscriptionEntitled &&
      activeProvider !== 'mindstone' &&
      (routingAvailable || draftSettings.activeProvider === 'mindstone') &&
      !userOptedOutOfManaged
    ) {
      handleProviderSelect('mindstone');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- trigger on subscription/routing/settings change
  }, [subscriptionEntitled, routingAvailable, draftSettings.activeProvider, draftSettings.managedProviderDeactivated]);

  const handleSubscribe = useCallback(async (tier: SubscriptionTier) => {
    setSubscriptionError(null);
    setCheckoutLoadingTier(tier);
    try {
      tracking.subscription.subscribeClicked({ tier, origin: 'onboarding' });
      await window.subscriptionApi.createCheckout({ tier, origin: 'onboarding' });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Couldn't open checkout. Please try again.";
      setSubscriptionError(message);
    } finally {
      setCheckoutLoadingTier(null);
    }
  }, []);

  const [showAnthropicKeyInput, setShowAnthropicKeyInput] = useState(!!apiKey);

  const isDashActive = subscriptionEntitled && subscription?.tier === 'dash';
  const isRogueActive = subscriptionEntitled && subscription?.tier === 'rogue';
  const isOss = rendererIsOss();
  const connectionRequiredProviderClause = isOss
    ? 'add an Anthropic API key, connect OpenRouter, or use ChatGPT Pro.'
    : 'use ChatGPT Pro, connect OpenRouter, or add an Anthropic API key.';

  // OSS "About you (optional)" block. Local raw input state (so invalid text
  // stays visible while the user fixes it); valid values are written to the
  // onboarding draft, which persists at completion via settings:update. The
  // raw validator reason routes to a native <details> affordance, not the
  // resting surface (gentle inline hint there). Invalid input never blocks
  // Continue — it just isn't written/POSTed.
  const [aboutName, setAboutName] = useState<string>(draftSettings.userFirstName ?? '');
  const [aboutEmail, setAboutEmail] = useState<string>(draftSettings.userEmail ?? '');
  const [nameError, setNameError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);

  const handleAboutNameChange = useCallback(
    (raw: string) => {
      setAboutName(raw);
      if (raw.trim() === '') {
        // Cleared — drop any error; leave the draft value as-is (no clobber).
        setNameError(null);
        return;
      }
      const result = validateFirstName(raw);
      if (result.ok) {
        setNameError(null);
        updateDraft('userFirstName', result.value);
      } else {
        setNameError(result.error);
      }
    },
    [updateDraft],
  );

  const handleAboutEmailChange = useCallback(
    (raw: string) => {
      setAboutEmail(raw);
      if (raw.trim() === '') {
        setEmailError(null);
        return;
      }
      const result = validateEmail(raw);
      if (result.ok) {
        setEmailError(null);
        updateDraft('userEmail', result.value);
      } else {
        setEmailError(result.error);
      }
    },
    [updateDraft],
  );

  const chatGptProCard = (
    <div
      key="chatgpt-pro"
      className={`${settingsStyles.providerCard} ${codexConnected && activeProvider === 'codex' ? settingsStyles.providerCardSelected : ''}`}
      onClick={() => {
        if (codexConnected && activeProvider !== 'codex') handleProviderSelect('codex');
        else if (!codexConnected && !codexLoading) handleCodexConnect();
      }}
      role="option"
      aria-selected={codexConnected && activeProvider === 'codex'}
      tabIndex={0}
      data-testid="onboarding-codex-card"
    >
      <div className={settingsStyles.providerCardHeader}>
        <OpenAILogo size={20} className={settingsStyles.providerCardIcon} />
        <Tooltip
          content="ChatGPT Pro is OpenAI's premium subscription that gives you unlimited access to GPT-5.5, their most capable model. Rebel uses your subscription to handle tasks like research, writing, and analysis."
          maxWidth="280px"
        >
          <span className={settingsStyles.providerCardTitle}>ChatGPT Pro</span>
        </Tooltip>
        {!isOss && (
          <span className={settingsStyles.providerCardRecommended}>(recommended)</span>
        )}
      </div>
      <div className={settingsStyles.providerCardBody}>
        <p className={settingsStyles.providerCardDescription}>
          Use your existing ChatGPT Pro subscription ($200/month) to power Rebel with OpenAI&apos;s best models. No extra API costs.
        </p>
      </div>
      <div className={settingsStyles.providerCardFooter}>
        <div className={settingsStyles.providerCardFooterLeft}>
          <a
            href={CHATGPT_PRO_PRICING_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={settingsStyles.providerCardFooterLink}
            onClick={(e) => e.stopPropagation()}
          >
            Create a Pro account
          </a>
        </div>
        <div className={settingsStyles.providerCardFooterRight} onClick={(e) => e.stopPropagation()}>
          {codexConnected ? (
            <Tooltip
              content={codexStatus.accountEmail ? `Connected as ${codexStatus.accountEmail}` : 'Connected to ChatGPT Pro'}
              placement="top"
            >
              <span className={settingsStyles.providerCardConnectedBadge}>
                <Check size={12} aria-hidden />
                Connected
              </span>
            </Tooltip>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleCodexConnect(); }}
              disabled={codexLoading}
              data-testid="onboarding-codex-setup-button"
              className={settingsStyles.providerCardConnectBtn}
            >
              {codexLoading && <Loader2 size={12} className={settingsStyles.spinnerIcon} />}
              {codexLoading ? 'Connecting...' : 'Connect'}
            </Button>
          )}
        </div>
        {codexError && (
          <p className={settingsStyles.errorMessage} style={{ margin: 0, fontSize: '0.72rem', gridColumn: '1 / -1' }}>{codexError}</p>
        )}
      </div>
    </div>
  );

  const openRouterCard = (
    <div
      key="openrouter"
      className={`${settingsStyles.providerCard} ${orConnected && activeProvider === 'openrouter' ? settingsStyles.providerCardSelected : ''}`}
      onClick={() => {
        if (orConnected && activeProvider !== 'openrouter') handleProviderSelect('openrouter');
        else if (!orConnected && !orSetup.isLoading) handleOrConnect();
      }}
      role="option"
      aria-selected={orConnected && activeProvider === 'openrouter'}
      tabIndex={0}
      data-testid="onboarding-openrouter-card"
    >
      <div className={settingsStyles.providerCardHeader}>
        <OpenRouterLogo size={20} className={settingsStyles.providerCardIcon} />
        <Tooltip
          content="OpenRouter is a service that gives you access to AI models from multiple providers (Anthropic, Google, OpenAI) through a single account. It handles billing across all of them."
          maxWidth="280px"
        >
          <span className={settingsStyles.providerCardTitle}>OpenRouter</span>
        </Tooltip>
      </div>
      <div className={settingsStyles.providerCardBody}>
        <p className={settingsStyles.providerCardDescription}>
          Access Claude, GPT, Gemini, and other models through one account. OpenRouter handles billing for all providers in one place.
          {' '}
          <Tooltip
            content="If your company uses an OpenRouter organization, switch to that organization in OpenRouter before connecting here. This ensures billing goes to your company account."
            maxWidth="280px"
          >
            <span className={settingsStyles.apiKeyQuestion}>Company account?</span>
          </Tooltip>
        </p>
        {orConnected && (
          <div className={settingsStyles.providerCardHelpLinks}>
            <span className={settingsStyles.providerCardStepsLabel}>Next steps:</span>
            <a
              href="https://openrouter.ai/credits"
              target="_blank"
              rel="noopener noreferrer"
              className={settingsStyles.providerCardFooterLink}
              onClick={(e) => e.stopPropagation()}
            >
              1. Add credits to your account
            </a>
            <a
              href="https://openrouter.ai/settings/credits"
              target="_blank"
              rel="noopener noreferrer"
              className={settingsStyles.providerCardFooterLink}
              onClick={(e) => e.stopPropagation()}
            >
              2. Set up auto top-up (optional)
            </a>
          </div>
        )}
      </div>
      <div className={settingsStyles.providerCardFooter}>
        <div className={settingsStyles.providerCardFooterLeft}>
          <a
            href="https://openrouter.ai/docs/faq"
            target="_blank"
            rel="noopener noreferrer"
            className={settingsStyles.providerCardFooterLink}
            onClick={(e) => e.stopPropagation()}
          >
            Learn more
          </a>
        </div>
        <div className={settingsStyles.providerCardFooterRight} onClick={(e) => e.stopPropagation()}>
          {orConnected ? (
            <span className={settingsStyles.providerCardConnectedBadge}>
              <Check size={12} aria-hidden />
              Connected
            </span>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleOrConnect(); }}
              disabled={orSetup.isLoading}
              data-testid="onboarding-openrouter-setup-button"
              className={settingsStyles.providerCardConnectBtn}
            >
              {orSetup.isLoading && <Loader2 size={12} className={settingsStyles.spinnerIcon} />}
              {orSetup.buttonLabel}
            </Button>
          )}
        </div>
        {orSetup.isLoading && (
          <button
            type="button"
            className={settingsStyles.providerCardDisconnectLink}
            onClick={(e) => { e.stopPropagation(); orSetup.handleCancel(); }}
            data-testid="onboarding-openrouter-cancel-button"
            style={{ gridColumn: '1 / -1', justifySelf: 'end' }}
          >
            Cancel
          </button>
        )}
        {orSetup.error && (
          <p className={settingsStyles.errorMessage} style={{ margin: 0, fontSize: '0.72rem', gridColumn: '1 / -1' }}>{orSetup.error}</p>
        )}
        {orSetup.waitingMessage && (
          <p className={settingsStyles.connectionCardHint} style={{ gridColumn: '1 / -1' }}>{orSetup.waitingMessage}</p>
        )}
        {orSetup.phase === 'waiting' && (
          <Button
            variant="outline"
            size="sm"
            onClick={(e: React.MouseEvent) => { e.stopPropagation(); orSetup.handleRetry(); }}
            data-testid="onboarding-openrouter-retry-button"
            className={settingsStyles.providerCardConnectBtn}
            style={{ gridColumn: '1 / -1', justifySelf: 'end' }}
          >
            Try again
          </Button>
        )}
      </div>
    </div>
  );

  const anthropicCard = (
    <div
      key="anthropic"
      className={`${settingsStyles.providerCard} ${claudeConnected && activeProvider === 'anthropic' ? settingsStyles.providerCardSelected : ''}`}
      onClick={() => {
        if (hasApiKey && activeProvider !== 'anthropic') handleProviderSelect('anthropic');
        else if (!hasApiKey && !showAnthropicKeyInput) setShowAnthropicKeyInput(true);
      }}
      role="option"
      aria-selected={claudeConnected && activeProvider === 'anthropic'}
      tabIndex={0}
      data-testid="onboarding-anthropic-card"
    >
      <div className={settingsStyles.providerCardHeader}>
        <AnthropicLogo size={20} className={settingsStyles.providerCardIcon} />
        <Tooltip
          content="An API key is a unique passcode from Anthropic that lets Rebel access Claude on your behalf. You paste it here once and Rebel handles the rest."
          maxWidth="260px"
        >
          <span className={settingsStyles.providerCardTitle}>Anthropic</span>
        </Tooltip>
        {isOss && (
          <span className={settingsStyles.providerCardRecommended}>(recommended)</span>
        )}
      </div>
      <div className={settingsStyles.providerCardBody}>
        <p className={settingsStyles.providerCardDescription}>
          Connect directly to Claude with an API key. You pay per use based on how much you use Rebel.{' '}
          <Tooltip
            content="An API key is a unique passcode from Anthropic that lets Rebel access Claude on your behalf. You paste it here once and Rebel handles the rest."
            maxWidth="260px"
          >
            <span className={settingsStyles.apiKeyQuestion}>What is an API key?</span>
          </Tooltip>
        </p>
      </div>
      <div className={settingsStyles.providerCardFooter}>
        {hasApiKey ? (
          <>
            <div className={settingsStyles.providerCardFooterLeft}>
              <button
                type="button"
                className={settingsStyles.providerCardDisconnectLink}
                onClick={(e) => {
                  e.stopPropagation();
                  updateClaude('apiKey', null);
                  setShowAnthropicKeyInput(false);
                }}
                data-testid="onboarding-claude-remove-key-button"
              >
                Remove
              </button>
            </div>
            <div className={settingsStyles.providerCardFooterRight}>
              <span className={settingsStyles.providerCardConnectedBadge}>
                <Check size={12} aria-hidden />
                Key added
              </span>
            </div>
          </>
        ) : showAnthropicKeyInput ? (
          <div className={settingsStyles.providerCardKeyInputExpanded} onClick={(e) => e.stopPropagation()}>
            <div className={settingsStyles.providerCardKeyRow}>
              <input
                id="onboarding-claude-key"
                data-testid="onboarding-claude-api-key-input"
                type="text"
                inputMode="text"
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                data-form-type="other"
                value={apiKey ?? ''}
                onChange={(event) => {
                  const sanitized = sanitizeApiKey(event.currentTarget.value) || null;
                  updateClaude('apiKey', sanitized);
                  if (claudeValidationTimerRef.current) clearTimeout(claudeValidationTimerRef.current);
                  if (sanitized) {
                    tracking.onboarding.claudeKeyEntered();
                    claudeValidationTimerRef.current = setTimeout(() => {
                      void validateClaudeKey(sanitized);
                    }, VALIDATION_DEBOUNCE_MS);
                  }
                }}
                placeholder="sk-ant-..."
                autoFocus
                style={{ WebkitTextSecurity: 'disc' } as React.CSSProperties}
              />
            </div>
            <div className={settingsStyles.providerCardKeyInputHelp}>
              <a
                href={ANTHROPIC_API_KEY_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={settingsStyles.providerCardFooterLink}
              >
                Get API key
              </a>
              <span className={settingsStyles.providerCardFooterLinkDot}>&middot;</span>
              <a
                href={API_KEY_WALKTHROUGH_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={settingsStyles.providerCardFooterLink}
              >
                Walkthrough
              </a>
            </div>
            {claudeValidationMessage && !isValidatingClaude && (
              <p className={claudeValidationOk ? settingsStyles.successMessage : settingsStyles.errorMessage} style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.72rem', margin: 0 }}>
                {claudeValidationOk ? <Check size={12} /> : null}
                {claudeValidationMessage}
              </p>
            )}
            {isValidatingClaude && claudeValidationMessage && (
              <p className={settingsStyles.connectionCardHint} style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.72rem', margin: 0 }}>
                <Loader2 size={12} className={settingsStyles.spinnerIcon} />
                {claudeValidationMessage}
              </p>
            )}
          </div>
        ) : (
          <>
            <div className={settingsStyles.providerCardFooterLeft}>
              <a
                href={API_KEY_WALKTHROUGH_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={settingsStyles.providerCardFooterLink}
                onClick={(e) => e.stopPropagation()}
              >
                Setup guide
              </a>
            </div>
            <div className={settingsStyles.providerCardFooterRight}>
              <Button
                variant="outline"
                size="sm"
                onClick={(e: React.MouseEvent) => { e.stopPropagation(); setShowAnthropicKeyInput(true); }}
                data-testid="onboarding-claude-add-key-button"
                className={settingsStyles.providerCardConnectBtn}
              >
                Add API Key
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );

  return (
    <div className={styles.stepBody}>
      <div className={styles.stepTitleGroup}>
        <h2>Connect your AI</h2>
        <p className={styles.stepDescription}>
          This connection powers everything Rebel does, from drafting emails and preparing for meetings to researching topics and managing your inbox. One-time setup, under a minute.
        </p>
      </div>

      {!isOss && (
        <>
          <div className={settingsStyles.subscriptionGroup}>
            <h3 className={settingsStyles.subscriptionGroupHeading}>Let Mindstone handle it</h3>
            <p className={settingsStyles.subscriptionGroupSubheading}>
              We pick up the AI bill — no API keys, no separate accounts, no surprises. Powered by OpenRouter.
            </p>

            <div className={settingsStyles.subscriptionGrid} role="list" aria-label="Mindstone subscription tiers">
              {/* Dash tier */}
              <div
                className={`${settingsStyles.subscriptionCard} ${isDashActive ? settingsStyles.subscriptionCardSelected : ''}`}
                role="listitem"
                data-testid="onboarding-subscription-dash-card"
              >
                <div className={settingsStyles.subscriptionCardHeader}>
                  <h4 className={settingsStyles.subscriptionCardTitle}>Dash</h4>
                  <span className={settingsStyles.subscriptionPriceBadge}>$200/mo</span>
                </div>
                <p className={settingsStyles.subscriptionCardDescription}>
                  Capable models that handle your daily workload.
                </p>
                <div className={settingsStyles.subscriptionCardFooter}>
                  {isDashActive ? (
                    <span className={settingsStyles.subscriptionActiveBadge}>
                      <Check size={12} aria-hidden />
                      Active
                    </span>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void handleSubscribe('dash')}
                      disabled={checkoutLoadingTier !== null}
                      data-testid="onboarding-subscription-dash-button"
                      className={settingsStyles.providerCardConnectBtn}
                    >
                      {checkoutLoadingTier === 'dash' && <Loader2 size={12} className={settingsStyles.spinnerIcon} />}
                      {checkoutLoadingTier === 'dash' ? 'Opening checkout...' : 'Subscribe'}
                    </Button>
                  )}
                </div>
              </div>

              {/* Rogue tier */}
              <div
                className={`${settingsStyles.subscriptionCard} ${isRogueActive ? settingsStyles.subscriptionCardSelected : ''}`}
                role="listitem"
                data-testid="onboarding-subscription-rogue-card"
              >
                <div className={settingsStyles.subscriptionCardHeader}>
                  <h4 className={settingsStyles.subscriptionCardTitle}>Rogue</h4>
                  <span className={settingsStyles.subscriptionPriceBadge}>$500/mo</span>
                </div>
                <p className={settingsStyles.subscriptionCardDescription}>
                  The most powerful models available — for work that demands the best.
                </p>
                <div className={settingsStyles.subscriptionCardFooter}>
                  {isRogueActive ? (
                    <span className={settingsStyles.subscriptionActiveBadge}>
                      <Check size={12} aria-hidden />
                      Active
                    </span>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void handleSubscribe('rogue')}
                      disabled={checkoutLoadingTier !== null}
                      data-testid="onboarding-subscription-rogue-button"
                      className={settingsStyles.providerCardConnectBtn}
                    >
                      {checkoutLoadingTier === 'rogue' && <Loader2 size={12} className={settingsStyles.spinnerIcon} />}
                      {checkoutLoadingTier === 'rogue' ? 'Opening checkout...' : 'Subscribe'}
                    </Button>
                  )}
                </div>
              </div>
            </div>

            {subscriptionEntitled && !routingAvailable && (
              <p className={settingsStyles.subscriptionRoutingHint} data-testid="onboarding-subscription-routing-hint">
                Subscription active — your AI is being set up. We&apos;ll switch you over automatically.
              </p>
            )}

            {subscriptionError && (
              <p className={settingsStyles.errorMessage} style={{ margin: 0, fontSize: '0.72rem' }}>
                {subscriptionError}
              </p>
            )}
          </div>

          <div className={settingsStyles.subscriptionDivider} aria-hidden>
            <span className={settingsStyles.subscriptionDividerLabel}>or bring your own AI</span>
          </div>
        </>
      )}

      {isOss && (
        <div className={settingsStyles.subscriptionGroup}>
          <h3 className={settingsStyles.subscriptionGroupHeading}>Bring your own AI</h3>
          <p className={settingsStyles.subscriptionGroupSubheading}>
            In the open-source build, Rebel uses your own AI account or API key. Connect one option below to get started.
          </p>
        </div>
      )}

      <div className={settingsStyles.providerCardGrid} role="listbox" aria-label="AI provider">
        {isOss
          ? [anthropicCard, openRouterCard, chatGptProCard]
          : [chatGptProCard, openRouterCard, anthropicCard]}
      </div>

      {/*
        OSS "About you (optional)" block — a quiet trailing courtesy, subordinate
        to the provider grid above (never a gate). The Mindstone-sharing
        disclosure is persistent and adjacent to the fields (block subheading +
        per-field email helper) so implied consent holds at the point of entry;
        it must never move into the <details> affordance. Design intent:
        docs/plans/260623_oss-identity-ask-lead-capture/PLAN.md (Stage 4 + chief-designer report).
      */}
      {isOss && (
        <div
          className={settingsStyles.subscriptionGroup}
          data-testid="onboarding-about-you"
        >
          <h3 className={settingsStyles.subscriptionGroupHeading}>About you (optional)</h3>
          <p className={settingsStyles.subscriptionGroupSubheading}>
            Your name lets Rebel address you; your email helps it tell your meetings
            and messages apart from everyone else&apos;s — and lets Mindstone keep in
            touch about the open build. Skip it and everything still works.
          </p>

          <div className={settingsStyles.aboutYouField}>
            <Label htmlFor="about-you-name">First name</Label>
            <Input
              id="about-you-name"
              inputSize="md"
              type="text"
              value={aboutName}
              error={!!nameError}
              placeholder="What should Rebel call you?"
              onChange={(e) => handleAboutNameChange(e.target.value)}
              data-testid="onboarding-about-you-name"
            />
            {nameError && (
              <>
                <p className={settingsStyles.errorMessage} style={{ margin: 0 }}>
                  Names need at least 2 letters and should start with a letter.
                </p>
                <details className={styles.fieldHint}>
                  <summary>Details</summary>
                  <span data-testid="onboarding-about-you-name-detail">{nameError}</span>
                </details>
              </>
            )}
          </div>

          <div className={settingsStyles.aboutYouField}>
            <Label htmlFor="about-you-email">Email</Label>
            <Input
              id="about-you-email"
              inputSize="md"
              type="email"
              inputMode="email"
              value={aboutEmail}
              error={!!emailError}
              onChange={(e) => handleAboutEmailChange(e.target.value)}
              data-testid="onboarding-about-you-email"
            />
            <p className={settingsStyles.connectionCardHint} style={{ margin: 0 }}>
              Shared with Mindstone so we can keep in touch — and used locally to
              spot your own meetings and accounts.
            </p>
            {emailError && (
              <>
                <p className={settingsStyles.errorMessage} style={{ margin: 0 }}>
                  That doesn&apos;t look like a valid email.
                </p>
                <details className={styles.fieldHint}>
                  <summary>Details</summary>
                  <span data-testid="onboarding-about-you-email-detail">{emailError}</span>
                </details>
              </>
            )}
          </div>
        </div>
      )}

      <OpenRouterPrivacyModal
        open={showOrPrivacy}
        onAccept={handleOrPrivacyAccept}
        onCancel={() => setShowOrPrivacy(false)}
      />

      {/* Connection required — shown when user tries Continue without auth */}
      {triedContinue && !claudeReady && (
        <div className={styles.connectionRequiredBanner}>
          <Info size={16} aria-hidden />
          <p>Connect a model provider to continue — {connectionRequiredProviderClause}</p>
        </div>
      )}
    </div>
  );
};

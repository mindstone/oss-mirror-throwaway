import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, RebelLoadingIndicator, Spinner } from '@renderer/components/ui';
import { BrandLogo } from '@renderer/components/BrandLogo';
import { ChevronDown, FolderOpen, RefreshCw, ShieldCheck, ExternalLink, FileText } from 'lucide-react';
import { tracking } from '@renderer/src/tracking';
import introStyles from '../OnboardingShared.module.css';
import preflightStyles from '../components/PreflightCheck.module.css';
import wizardStyles from '../OnboardingWizard.module.css';
import type { PreflightResult, PreflightIssue } from '@shared/ipc/channels/health';
import type { WelcomeStepProps } from './types';

const REBEL_MASCOT_ANIMATED_URL = 'https://storage.googleapis.com/mindstone-public-assets/rebel/intro-welcome.gif';
const REBEL_MASCOT_STATIC_URL = 'https://storage.googleapis.com/mindstone-public-assets/rebel/rebel4.png';

const PRIVACY_DETAILS = [
  'Your files and conversations are stored on your computer',
  'AI requests are processed by Anthropic and OpenAI (not used to train their models)',
  'We collect basic telemetry (usage stats, error reports) to improve Rebel',
  'Files in shared cloud storage remain visible to colleagues with access',
];

type CheckStatus = 'idle' | 'checking' | 'issues' | 'clear';

type IssueState = {
  expanded: boolean;
  retrying: boolean;
  resolved: boolean;
};

const MIN_CHECK_TIME_MS = 2000;

const isWindows = window.electronEnv?.platform === 'win32';
const EULA_URL = 'https://help.mindstone.com/en/articles/12976594-rebel-end-user-licence-agreement';
// TODO: Update to dedicated privacy policy article URL when published
const PRIVACY_POLICY_URL = 'https://mindstone.com/privacy-policy';

const PREFLIGHT_CHECKS = [
  { id: 'storage', label: 'Storage space' },
  { id: 'permissions', label: 'Save permissions' },
  ...(isWindows ? [
    { id: 'gitBash', label: 'Git for Windows' },
    { id: 'powershell', label: 'PowerShell' },
  ] : []),
  { id: 'runtime', label: 'Runtime environment' },
];

export const WelcomeStep = ({
  goNext,
  startMigrationImport,
  twinkleParticles,
  shootingStars,
  eulaAccepted,
  setEulaAccepted,
}: WelcomeStepProps) => {
  const [checkStatus, setCheckStatus] = useState<CheckStatus>('idle');
  const [result, setResult] = useState<PreflightResult | null>(null);
  const [issueStates, setIssueStates] = useState<Record<string, IssueState>>({});
  const [checksExpanded, setChecksExpanded] = useState(false);
  const [showSlowCheckHint, setShowSlowCheckHint] = useState(false);
  const [showEulaError, setShowEulaError] = useState(false);
  const [mascotFailed, setMascotFailed] = useState(false);
  const [privacyDetailsExpanded, setPrivacyDetailsExpanded] = useState(false);
  const checkStartTimeRef = useRef<number>(0);
  const mascotSrc = mascotFailed ? REBEL_MASCOT_STATIC_URL : REBEL_MASCOT_ANIMATED_URL;

  const handleEulaChange = useCallback((checked: boolean) => {
    setEulaAccepted(checked);
    setShowEulaError(false);
    if (checked) {
      tracking.onboarding.eulaAccepted();
    } else {
      tracking.onboarding.eulaDeclined();
    }
  }, [setEulaAccepted]);

  const attemptContinue = useCallback(() => {
    if (!eulaAccepted) {
      setShowEulaError(true);
      return;
    }
    void goNext();
  }, [eulaAccepted, goNext]);

  const attemptMigrationImport = useCallback(() => {
    if (!eulaAccepted) {
      setShowEulaError(true);
      return;
    }
    startMigrationImport();
  }, [eulaAccepted, startMigrationImport]);

  useEffect(() => {
    if (!isWindows || checkStatus !== 'checking') return;

    const timeoutId = window.setTimeout(() => {
      setShowSlowCheckHint(true);
    }, 8000);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [checkStatus]);

  const runCheck = useCallback(async () => {
    setShowSlowCheckHint(false);
    setCheckStatus('checking');
    checkStartTimeRef.current = Date.now();
    
    try {
      const checkResult = await window.systemHealthApi.preflightCheck();
      setResult(checkResult);

      // Initialize issue states
      const states: Record<string, IssueState> = {};
      for (const issue of checkResult.issues) {
        states[issue.id] = { expanded: false, retrying: false, resolved: false };
      }
      setIssueStates(states);

      // Ensure minimum display time so users can read the status
      const elapsed = Date.now() - checkStartTimeRef.current;
      const remainingTime = Math.max(0, MIN_CHECK_TIME_MS - elapsed);

      if (checkResult.issues.length === 0) {
        setTimeout(() => setCheckStatus('clear'), remainingTime);
      } else {
        setTimeout(() => setCheckStatus('issues'), remainingTime);
      }
    } catch (error) {
      console.error('Pre-flight check failed:', error);
      const issue: PreflightIssue = {
        id: 'preflight-check-failed',
        category: 'system',
        title: "We couldn't finish the setup check",
        description: 'Rebel can keep going, but one of the readiness checks did not report back.',
        severity: 'warning',
        remediation: 'Try the check again. If it keeps happening, you can continue and Rebel will guide you if something needs attention later.',
        canRetry: true,
        actionType: 'retry-only',
      };
      setResult({
        canProceed: true,
        issues: [issue],
        checkDurationMs: Date.now() - checkStartTimeRef.current,
      });
      setIssueStates({
        [issue.id]: { expanded: true, retrying: false, resolved: false },
      });
      setCheckStatus('issues');
    }
  }, []);

  const handleButtonClick = useCallback(() => {
    if (checkStatus === 'idle') {
      if (!eulaAccepted) {
        setShowEulaError(true);
        return;
      }
      void runCheck();
    } else if (checkStatus === 'clear') {
      attemptContinue();
    }
  }, [attemptContinue, checkStatus, eulaAccepted, runCheck]);

  const handleContinueAnyway = useCallback(() => {
    attemptContinue();
  }, [attemptContinue]);

  const toggleIssue = useCallback((issueId: string) => {
    setIssueStates((prev) => ({
      ...prev,
      [issueId]: { ...prev[issueId], expanded: !prev[issueId]?.expanded },
    }));
  }, []);

  const handleOpenFolder = useCallback(async (folderPath: string) => {
    try {
      await window.systemHealthApi.preflightOpenPath(folderPath);
    } catch (error) {
      console.error('Failed to open folder:', error);
    }
  }, []);

  const handleRetryIssue = useCallback(async (issueId: string) => {
    setIssueStates((prev) => ({
      ...prev,
      [issueId]: { ...prev[issueId], retrying: true },
    }));

    try {
      const checkResult = await window.systemHealthApi.preflightCheck();
      setResult(checkResult);

      const stillHasIssue = checkResult.issues.some((i) => i.id === issueId);

      setIssueStates((prev) => ({
        ...prev,
        [issueId]: {
          ...prev[issueId],
          retrying: false,
          resolved: !stillHasIssue,
          expanded: stillHasIssue ? prev[issueId]?.expanded : false,
        },
      }));

      if (checkResult.issues.length === 0) {
        setCheckStatus('clear');
      }
    } catch (error) {
      console.error('Retry check failed:', error);
      setIssueStates((prev) => ({
        ...prev,
        [issueId]: { ...prev[issueId], retrying: false },
      }));
    }
  }, []);

  const hasBlockers = result?.issues.some((i) => i.severity === 'blocker' && !issueStates[i.id]?.resolved) ?? false;

  const renderIssue = (issue: PreflightIssue) => {
    const state = issueStates[issue.id] || { expanded: false, retrying: false, resolved: false };

    if (state.resolved) {
      return (
        <div key={issue.id} className={preflightStyles.issue} style={{ opacity: 0.6 }}>
          <div className={preflightStyles.issueHeader}>
            <div className={`${preflightStyles.issueIcon} ${preflightStyles.resolved}`}>✓</div>
            <div className={preflightStyles.issueContent}>
              <p className={preflightStyles.issueTitle}>{issue.title}</p>
              <p className={preflightStyles.issueDescription}>Resolved</p>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div key={issue.id} className={preflightStyles.issue}>
        <div
          className={preflightStyles.issueHeader}
          onClick={() => toggleIssue(issue.id)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && toggleIssue(issue.id)}
        >
          <div className={`${preflightStyles.issueIcon} ${issue.severity === 'blocker' ? preflightStyles.blocker : preflightStyles.warning}`}>
            {issue.severity === 'blocker' ? '!' : '◐'}
          </div>
          <div className={preflightStyles.issueContent}>
            <p className={preflightStyles.issueTitle}>{issue.title}</p>
            <p className={preflightStyles.issueDescription}>{issue.description}</p>
          </div>
          <ChevronDown
            className={`${preflightStyles.issueChevron} ${state.expanded ? preflightStyles.expanded : ''}`}
            size={16}
          />
        </div>

        {state.expanded && (
          <div className={preflightStyles.issueExpanded}>
            {issue.remediation && <p className={preflightStyles.remediation}>{issue.remediation}</p>}
            {issue.diagnosticHint && (
              <p className={preflightStyles.diagnosticHint}>{issue.diagnosticHint}</p>
            )}
            <div className={preflightStyles.issueActions}>
              {issue.actionType === 'open-folder' && issue.actionPath && (
                <button
                  className={preflightStyles.issueButton}
                  onClick={() => {
                    if (issue.actionPath) void handleOpenFolder(issue.actionPath);
                  }}
                  type="button"
                >
                  <FolderOpen size={14} />
                  Open folder
                </button>
              )}
              {issue.actionType === 'open-url' && issue.actionPath && (
                <button
                  className={preflightStyles.issueButton}
                  onClick={() => {
                    if (issue.actionPath) void window.appApi.openUrl(issue.actionPath);
                  }}
                  type="button"
                >
                  Download
                </button>
              )}
              {issue.canRetry && (
                <button
                  className={preflightStyles.issueButton}
                  onClick={() => void handleRetryIssue(issue.id)}
                  disabled={state.retrying}
                  type="button"
                >
                  {state.retrying ? (
                    <Spinner size="sm" decorative />
                  ) : (
                    <RefreshCw size={14} />
                  )}
                  {state.retrying ? 'Checking...' : 'Check again'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  // Derive button text and state
  const getButtonConfig = (): { text: React.ReactNode; disabled: boolean } => {
    switch (checkStatus) {
      case 'idle':
        return { text: 'Start now', disabled: !eulaAccepted };
      case 'checking':
        // Button is hidden during checking - this is just a fallback
        return { text: 'Checking...', disabled: true };
      case 'clear':
        return { text: 'Continue', disabled: false };
      case 'issues':
        return { 
          text: hasBlockers ? 'Fix issues to continue' : 'Continue anyway', 
          disabled: hasBlockers 
        };
    }
  };

  const buttonConfig = getButtonConfig();
  const shouldShowEulaAcceptance = checkStatus === 'idle';

  return (
    <div
      className={`${introStyles.overlay} dark`}
      role="dialog"
      aria-modal
    >
      {/* Nebula glow layers for depth */}
      <div className={introStyles.nebulaLayer} aria-hidden />
      
      {/* Main particle field */}
      <div className={introStyles.particles} aria-hidden>
        {twinkleParticles.map((p) => (
          <div
            key={p.key}
            className={`${introStyles.particle} ${
              p.type === 1 ? introStyles.particleBlue :
              p.type === 2 ? introStyles.particlePurple :
              p.type === 3 ? introStyles.particleGlow : ''
            }`}
            style={{
              left: `${p.left}%`,
              top: `${p.top}%`,
              animationDelay: `${p.delay}s`,
            }}
          />
        ))}
      </div>
      
      {/* Shooting stars */}
      <div className={introStyles.shootingStarsLayer} aria-hidden>
        {shootingStars.map((star) => (
          <div
            key={star.key}
            className={introStyles.shootingStar}
            style={{
              left: `${star.startLeft}%`,
              top: `${star.startTop}%`,
              animationDelay: `${star.delay}s`,
            }}
          />
        ))}
      </div>
      
      <div className={introStyles.container} style={{ gap: 0 }} data-testid="onboarding-welcome-content">
        <BrandLogo height={20} style={{ opacity: 0.5, marginBottom: 12 }} />

        {checkStatus === 'idle' && (
          <img
            src={mascotSrc}
            alt=""
            aria-hidden="true"
            className={introStyles.welcomeMascot}
            onError={() => setMascotFailed(true)}
          />
        )}
        
        {/* Title and description - changes based on status */}
        {checkStatus === 'idle' && (
          <>
            <h1 className={introStyles.headline} style={{ marginBottom: 16 }} data-testid="onboarding-welcome-title">
              Welcome to Rebel
            </h1>
            <p className={introStyles.subhead} style={{ opacity: 0.65, maxWidth: 620 }}>
              Your new, easier way of working. Before we set up your workspace,
              let's make sure your system is ready.
            </p>
          </>
        )}

        {checkStatus === 'checking' && (
          <>
            <h1 className={introStyles.headline} style={{ marginBottom: 16 }}>
              One moment...
            </h1>
            <p className={introStyles.subhead} style={{ opacity: 0.65, maxWidth: 620 }}>
              {showSlowCheckHint
                ? "This can take a moment while your system's security software checks a few Rebel tools."
                : "Making sure everything's ready. If your system asks for permission, just tap Allow."}
            </p>
          </>
        )}

        {checkStatus === 'clear' && (
          <>
            <h1 className={introStyles.headline} style={{ marginBottom: 16 }}>
              You're all set!
            </h1>
            <p className={introStyles.subhead} style={{ opacity: 0.65, maxWidth: 620 }}>
              Everything looks great. Let's get you started.
            </p>
          </>
        )}

        {checkStatus === 'issues' && (
          <>
            <h1 className={introStyles.headline} style={{ marginBottom: 16 }}>
              Just one thing
            </h1>
            <p className={introStyles.subhead} style={{ opacity: 0.65, maxWidth: 620 }}>
              Let's sort this out before we continue.
            </p>
          </>
        )}

        {/* Loading animation - branded GIF */}
        {checkStatus === 'checking' && (
          <>
            <div style={{ marginTop: 32, display: 'flex', justifyContent: 'center' }}>
              <RebelLoadingIndicator
                layout="stacked"
                size="lg"
                label="Checking your setup"
                description="Making sure Rebel can run properly before we continue."
              />
            </div>
            
            {/* Expandable checks list for curious users */}
            <div className={preflightStyles.checksToggle}>
              <button
                type="button"
                className={preflightStyles.checksToggleButton}
                onClick={() => setChecksExpanded(!checksExpanded)}
                aria-expanded={checksExpanded}
              >
                <span>What we're checking</span>
                <ChevronDown
                  className={`${preflightStyles.checksToggleChevron} ${checksExpanded ? preflightStyles.expanded : ''}`}
                  size={14}
                />
              </button>
              {checksExpanded && (
                <ul className={preflightStyles.checksList}>
                  {PREFLIGHT_CHECKS.map((check) => (
                    <li key={check.id} className={preflightStyles.checksListItem}>
                      {check.label}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}

        {/* Success checkmark with glow effect */}
        {checkStatus === 'clear' && (
          <div style={{ marginTop: 32, position: 'relative', width: 120, height: 120, margin: '32px auto 0' }}>
            <div className={preflightStyles.checkmarkGlow} />
            <div className={preflightStyles.checkmark} />
            <div className={preflightStyles.checkmarkParticles}>
              <div className={preflightStyles.checkmarkParticle} />
              <div className={preflightStyles.checkmarkParticle} />
              <div className={preflightStyles.checkmarkParticle} />
              <div className={preflightStyles.checkmarkParticle} />
              <div className={preflightStyles.checkmarkParticle} />
              <div className={preflightStyles.checkmarkParticle} />
              <div className={preflightStyles.checkmarkParticle} />
              <div className={preflightStyles.checkmarkParticle} />
            </div>
          </div>
        )}

        {/* Issue list */}
        {checkStatus === 'issues' && result && (
          <div className={preflightStyles.issueList} style={{ marginTop: 24, maxWidth: 480 }}>
            {result.issues.map(renderIssue)}
          </div>
        )}

        {/* Privacy + EULA card — shown in idle state, before any tool connections */}
        {shouldShowEulaAcceptance && (
          <div className={introStyles.privacyTrust}>
            <div className={introStyles.privacyTrustItem}>
              <ShieldCheck size={15} className={introStyles.privacyTrustIcon} aria-hidden />
              <div>
                <p className={introStyles.privacyTrustText}>
                  <strong>Stored on your device, not the cloud</strong>
                  Your conversations and files stay on your computer. AI providers process requests but don't retain them.{' '}
                  <a
                    href={PRIVACY_POLICY_URL}
                    className={introStyles.privacyPolicyLink}
                    onClick={(e) => {
                      e.preventDefault();
                      void window.appApi.openUrl(PRIVACY_POLICY_URL);
                    }}
                  >
                    Privacy Policy
                    <ExternalLink size={11} aria-hidden />
                  </a>
                  {' · '}
                  <button
                    type="button"
                    className={introStyles.privacyPolicyLinkButton}
                    onClick={() => {
                      void window.appApi.revealPath('rebel-system/help-for-humans/Rebel-privacy-policy.md');
                    }}
                  >
                    <FileText size={11} aria-hidden />
                    Open full policy
                  </button>
                </p>

                {/* Collapsible privacy details */}
                <div className={introStyles.privacyDetailsToggle}>
                  <button
                    type="button"
                    className={introStyles.privacyDetailsButton}
                    onClick={() => setPrivacyDetailsExpanded(!privacyDetailsExpanded)}
                    aria-expanded={privacyDetailsExpanded}
                  >
                    <span>What this means</span>
                    <ChevronDown
                      className={`${introStyles.privacyDetailsChevron} ${privacyDetailsExpanded ? introStyles.privacyDetailsChevronExpanded : ''}`}
                      size={14}
                    />
                  </button>
                  {privacyDetailsExpanded && (
                    <ul className={introStyles.privacyDetailsList}>
                      {PRIVACY_DETAILS.map((detail) => (
                        <li key={detail} className={introStyles.privacyDetailsItem}>
                          {detail}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>

            <div className={introStyles.privacyTrustDivider} />

            <label className={`${wizardStyles.checkboxContainer} ${wizardStyles.checkboxContainerLeft}`} style={{ marginBottom: 0 }}>
              <input
                type="checkbox"
                checked={eulaAccepted}
                onChange={(e) => handleEulaChange(e.target.checked)}
              />
              <span className={wizardStyles.checkboxLabel}>
                I agree to the{' '}
                <a
                  href={EULA_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={introStyles.privacyPolicyLink}
                  onClick={(e) => {
                    e.preventDefault();
                    void window.appApi.openUrl(EULA_URL);
                  }}
                >
                  End User License Agreement
                  <ExternalLink size={11} aria-hidden />
                </a>
              </span>
            </label>
            {showEulaError && (
              <p className={wizardStyles.validationText} style={{ marginTop: 0, marginBottom: 0 }}>
                Review and accept the terms to continue
              </p>
            )}
          </div>
        )}

        {/* Action button - hidden during checking */}
        {checkStatus !== 'checking' && (
          <div
            className={introStyles.actions}
            style={{
              marginTop: checkStatus === 'issues' ? 24 : shouldShowEulaAcceptance ? 20 : 40,
              flexDirection: 'column',
              alignItems: 'center',
            }}
          >
            <Button
              size="lg"
              onClick={checkStatus === 'issues' && !hasBlockers ? handleContinueAnyway : handleButtonClick}
              disabled={buttonConfig.disabled}
              style={{ minWidth: 180 }}
              data-testid="onboarding-get-started-button"
            >
              {buttonConfig.text}
            </Button>
            {checkStatus === 'idle' && (
              <Button
                variant="ghost"
                size="sm"
                onClick={attemptMigrationImport}
                data-testid="onboarding-import-transfer-button"
              >
                Already using Rebel? Bring it over.
              </Button>
            )}
          </div>
        )}

        {/* Footer note for issues */}
        {checkStatus === 'issues' && !hasBlockers && (
          <p style={{ opacity: 0.5, fontSize: '13px', marginTop: 12, textAlign: 'center' }}>
            Some features may not work perfectly — nothing deal-breaking
          </p>
        )}
      </div>
    </div>
  );
};

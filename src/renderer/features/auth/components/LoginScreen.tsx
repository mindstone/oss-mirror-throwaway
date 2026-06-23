import { useState, useEffect, useMemo, useRef, useCallback, type ReactElement } from 'react';
import { Button, Input } from '@renderer/components/ui';
import { BrandLogo } from '@renderer/components/BrandLogo';
import { useEscapeHatchHotkey } from '@renderer/features/onboarding/hooks/useEscapeHatchHotkey';
import { useIpcEvent } from '@renderer/hooks/useIpcEvent';
import type { AuthProvider } from '@shared/ipc/schemas/auth';
import styles from './LoginScreen.module.css';

// Mascot animation - plays once on load (hosted on GCS)
const MASCOT_GIF_URL = 'https://storage.googleapis.com/mindstone-public-assets/rebel/intro-welcome.gif';
// Duration of the GIF animation in milliseconds (adjust based on actual GIF length)
const MASCOT_GIF_DURATION_MS = 2500;

const OTP_RESEND_COOLDOWN_SECONDS = 30;
const STORED_EMAIL_KEY = 'rebel-login-email';

type OtpStep = 'hidden' | 'email' | 'code';

interface LoginScreenProps {
  onLogin: (provider: AuthProvider) => Promise<void>;
  onSkip?: () => void;
}

type TwinkleParticle = {
  key: number;
  left: number;
  top: number;
  delay: number;
  type: number;
};

type ShootingStar = {
  key: string;
  startLeft: number;
  startTop: number;
  delay: number;
};

/**
 * Generate particles for the star field background.
 */
function generateParticles(): TwinkleParticle[] {
  const particles: TwinkleParticle[] = [];
  for (let i = 0; i < 80; i++) {
    particles.push({
      key: i,
      left: Math.random() * 100,
      top: Math.random() * 100,
      delay: Math.random() * 4,
      type: Math.floor(Math.random() * 4),
    });
  }
  return particles;
}

/**
 * Generate shooting stars for the background.
 */
function generateShootingStars(): ShootingStar[] {
  return Array.from({ length: 3 }, (_, i) => ({
    key: `star-${i}`,
    startLeft: 20 + Math.random() * 60,
    startTop: Math.random() * 40,
    delay: i * 8 + Math.random() * 4,
  }));
}

/**
 * Login screen with Google and Microsoft sign-in buttons.
 * Styled to match the Welcome to Rebel onboarding screen.
 */
export function LoginScreen({ onLogin, onSkip }: LoginScreenProps): ReactElement {
  const [isLoading, setIsLoading] = useState(false);
  const [loadingProvider, setLoadingProvider] = useState<AuthProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gifFrozenSrc, setGifFrozenSrc] = useState<string | null>(null);
  const mascotRef = useRef<HTMLImageElement>(null);

  // Loopback connectivity state (for detecting blocked OAuth)
  const [loopbackBlocked, setLoopbackBlocked] = useState(false);
  const [loopbackTested, setLoopbackTested] = useState(false);

  // API reachability state (for detecting blocked POST requests)
  const [apiUnreachable, setApiUnreachable] = useState(false);
  const [apiTested, setApiTested] = useState(false);
  const [apiFailureReason, setApiFailureReason] = useState<
    'tls' | 'timeout' | 'network' | 'http' | 'unknown' | null
  >(null);

  // OTP flow state
  const [otpStep, setOtpStep] = useState<OtpStep>('hidden');
  const [email, setEmail] = useState(() => localStorage.getItem(STORED_EMAIL_KEY) ?? '');
  const [otp, setOtp] = useState('');
  const [otpLoading, setOtpLoading] = useState(false);
  const [resendCountdown, setResendCountdown] = useState(0);

  // Generate particles and shooting stars once on mount
  const twinkleParticles = useMemo(() => generateParticles(), []);
  const shootingStars = useMemo(() => generateShootingStars(), []);

  // Hidden escape hatch: Cmd/Ctrl + Shift + Alt + E to enter guest mode
  useEscapeHatchHotkey({
    isActive: !!onSkip,
    onTrigger: () => onSkip?.(),
  });

  // Capture current frame of GIF to freeze it on the last frame
  const freezeGif = useCallback(() => {
    const img = mascotRef.current;
    if (!img || !img.complete || img.naturalWidth === 0) return;

    try {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0);
        const dataUrl = canvas.toDataURL('image/png');
        setGifFrozenSrc(dataUrl);
      }
    } catch {
      // If canvas capture fails (e.g., CORS), the GIF will just continue looping
      // This is an acceptable fallback
    }
  }, []);

  // Freeze GIF on last frame after it plays once
  useEffect(() => {
    const timer = setTimeout(() => {
      freezeGif();
    }, MASCOT_GIF_DURATION_MS);

    return () => clearTimeout(timer);
  }, [freezeGif]);

  // Listen for login errors from main process (timeout, callback errors)
  useIpcEvent(window.api.onAuthLoginError, (data) => {
    setError(data.message);
    setIsLoading(false);
    setLoadingProvider(null);
  }, []);

  // Test loopback and API connectivity on mount
  useEffect(() => {
    let cancelled = false;

    async function runConnectivityTests() {
      // Run both tests in parallel
      const [loopbackWorks, apiResult] = await Promise.all([
        window.authApi.testLoopback().catch(() => false),
        window.authApi.testApiReachability().catch(() => ({ reachable: false as const, reason: 'unknown' as const })),
      ]);

      const apiWorks = apiResult.reachable;

      if (cancelled) return;

      setLoopbackBlocked(!loopbackWorks);
      setLoopbackTested(true);
      setApiUnreachable(!apiWorks);
      setApiTested(true);
      setApiFailureReason(apiWorks ? null : apiResult.reason);

      // Auto-show email input if loopback is blocked (but only if API works)
      if (!loopbackWorks && apiWorks) {
        setOtpStep('email');
      }
    }

    runConnectivityTests();

    return () => {
      cancelled = true;
    };
  }, []);

  // Resend countdown timer
  useEffect(() => {
    if (resendCountdown <= 0) return;
    const timer = setInterval(() => {
      setResendCountdown((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [resendCountdown]);

  // Poll for API reachability when initially unreachable
  useEffect(() => {
    if (!apiUnreachable || !apiTested) return;

    const interval = setInterval(async () => {
      const result = await window.authApi.testApiReachability().catch(() => ({ reachable: false as const, reason: 'unknown' as const }));
      if (result.reachable) {
        setApiUnreachable(false);
        setApiFailureReason(null);
      } else {
        setApiFailureReason(result.reason);
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [apiUnreachable, apiTested]);

  const handleLogin = async (provider: AuthProvider) => {
    setIsLoading(true);
    setLoadingProvider(provider);
    setError(null);

    try {
      await onLogin(provider);
      // Don't reset loading here - the browser is open and we're waiting for callback
      // Loading state will be cleared when:
      // - Auth succeeds (AuthGate unmounts this component)
      // - Auth fails (caught below or via onAuthLoginError)
      // - User clicks cancel
    } catch {
      setError("That sign-in didn't take. Try again.");
      setIsLoading(false);
      setLoadingProvider(null);
    }
  };

  const handleCancel = async () => {
    try {
      await window.authApi.cancel();
    } catch {
      // Ignore cancel errors
    }
    setIsLoading(false);
    setLoadingProvider(null);
  };

  const handleShowEmailInput = () => {
    setOtpStep('email');
    setError(null);
  };

  const handleSendOtp = async () => {
    if (!email.trim()) {
      setError("Pop in your email to continue.");
      return;
    }

    setOtpLoading(true);
    setError(null);

    try {
      await window.authApi.sendOtp({ email: email.trim() });
      localStorage.setItem(STORED_EMAIL_KEY, email.trim());
      setOtpStep('code');
      setOtp('');
      setResendCountdown(OTP_RESEND_COOLDOWN_SECONDS);
    } catch (err) {
      let errorMsg = 'Failed to send code. Please try again.';
      if (err instanceof Error) {
        const match = err.message.match(/': Error: (.+)$/);
        if (match) {
          errorMsg = match[1];
        }
      }
      setError(errorMsg);
    } finally {
      setOtpLoading(false);
    }
  };

  const handleVerifyOtp = async () => {
    if (otp.length !== 6) {
      setError('All six digits, please.');
      return;
    }

    setOtpLoading(true);
    setError(null);

    try {
      await window.authApi.verifyOtp({ email: email.trim(), otp });
      // Success - auth state change will unmount this component
    } catch (err) {
      let errorMsg = 'Verification failed. Please try again.';
      if (err instanceof Error) {
        const match = err.message.match(/': Error: (.+)$/);
        if (match) {
          errorMsg = match[1];
        }
      }
      setError(errorMsg);
      setOtpLoading(false);
    }
  };

  const handleResendOtp = async () => {
    if (resendCountdown > 0) return;
    await handleSendOtp();
  };

  const handleChooseDifferentEmail = () => {
    setOtpStep('email');
    setOtp('');
    setError(null);
    setResendCountdown(0);
  };

  const handleOtpChange = (value: string) => {
    // Only allow digits, max 6 characters
    const cleaned = value.replace(/\D/g, '').slice(0, 6);
    setOtp(cleaned);
  };

  return (
    <div
      className={`${styles.overlay} dark`}
      role="dialog"
      aria-modal
      data-testid="login-screen-overlay"
    >
      {/* Nebula glow layers for depth */}
      <div className={styles.nebulaLayer} aria-hidden />

      {/* Main particle field */}
      <div className={styles.particles} aria-hidden>
        {twinkleParticles.map((p) => (
          <div
            key={p.key}
            className={`${styles.particle} ${
              p.type === 1
                ? styles.particleBlue
                : p.type === 2
                  ? styles.particlePurple
                  : p.type === 3
                    ? styles.particleGlow
                    : ''
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
      <div className={styles.shootingStarsLayer} aria-hidden>
        {shootingStars.map((star) => (
          <div
            key={star.key}
            className={styles.shootingStar}
            style={{
              left: `${star.startLeft}%`,
              top: `${star.startTop}%`,
              animationDelay: `${star.delay}s`,
            }}
          />
        ))}
      </div>

      <div className={styles.container} data-testid="login-screen-content">
        {/* Mascot animation - plays once, then freezes on last frame */}
        {/* Note: crossOrigin="anonymous" removed - GCS bucket lacks CORS headers */}
        {/* GIF will loop until frozen; freezing may fail without CORS but image will display */}
        <img
          ref={mascotRef}
          src={gifFrozenSrc ?? MASCOT_GIF_URL}
          alt="Rebel mascot"
          className={styles.mascot}
        />

        <BrandLogo height={18} variant="white" style={{ opacity: 0.8 }} />

        <h1 className={styles.headline} data-testid="login-screen-title">
          Welcome to Rebel
        </h1>

        <p className={styles.subhead}>
          Your smarter way of working — sign in to get started
        </p>

        {error && <div className={styles.error}>{error}</div>}

        {/* Network warning: API unreachable */}
        {apiUnreachable && apiTested && (
          <div className={styles.networkWarning}>
            {apiFailureReason === 'tls' ? (
              <>
                <p className={styles.networkWarningText}>
                  Rebel can’t verify a secure connection right now.
                </p>
                <p className={styles.networkWarningHint}>
                  This can happen on managed networks that inspect HTTPS traffic. Try a different network, or ask your IT team to allow Rebel.
                </p>
              </>
            ) : (
              <>
                <p className={styles.networkWarningText}>
                  Rebel can’t reach the server right now.
                </p>
                <p className={styles.networkWarningHint}>
                  Check your connection or try a different network. If the problem persists, your network may be blocking Rebel — contact your IT team.
                </p>
              </>
            )}
          </div>
        )}

        {/* Network warning: Only loopback blocked (OAuth broken, but OTP should work) */}
        {loopbackBlocked && loopbackTested && !apiUnreachable && (
          <div className={styles.networkWarning}>
            <p className={styles.networkWarningText}>
              Something is blocking sign-in with Google and Microsoft. Please use email instead.
            </p>
            <p className={styles.networkWarningHint}>
              Contact your IT team if you need these options enabled.
            </p>
          </div>
        )}

        {otpStep === 'code' ? (
          /* OTP Code Entry */
          <div className={styles.otpSection}>
            <p className={styles.otpLabel}>Enter code sent to</p>
            <p className={styles.otpEmail}>{email}</p>
            <Input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="000000"
              value={otp}
              onChange={(e) => handleOtpChange(e.target.value)}
              className={styles.otpInput}
              disabled={otpLoading}
              autoFocus
            />
            <Button
              variant="default"
              size="lg"
              className={styles.otpButton}
              onClick={handleVerifyOtp}
              disabled={otpLoading || otp.length !== 6}
            >
              {otpLoading ? 'Verifying...' : 'Verify'}
            </Button>
            <div className={styles.otpLinks}>
              {resendCountdown > 0 ? (
                <span className={styles.resendDisabled}>Resend code ({resendCountdown}s)</span>
              ) : (
                <button type="button" className={styles.textLink} onClick={handleResendOtp} disabled={otpLoading}>
                  Resend code
                </button>
              )}
              <button type="button" className={styles.textLink} onClick={handleChooseDifferentEmail} disabled={otpLoading}>
                Use a different email
              </button>
            </div>
          </div>
        ) : (
          /* Provider Buttons + Email Flow */
          <>
            <div className={styles.buttons}>
              <Button
                variant="outline"
                size="lg"
                className={styles.providerButton}
                onClick={() => handleLogin('google')}
                disabled={isLoading || otpLoading || loopbackBlocked}
                data-testid="login-google-button"
              >
                <GoogleIcon />
                <span>
                  {loadingProvider === 'google' ? 'Signing in...' : 'Continue with Google'}
                </span>
              </Button>

              <Button
                variant="outline"
                size="lg"
                className={styles.providerButton}
                onClick={() => handleLogin('microsoft')}
                disabled={isLoading || otpLoading || loopbackBlocked}
                data-testid="login-microsoft-button"
              >
                <MicrosoftIcon />
                <span>
                  {loadingProvider === 'microsoft' ? 'Signing in...' : 'Continue with Microsoft'}
                </span>
              </Button>
            </div>

            {isLoading && (
              <div className={styles.loadingState}>
                <p className={styles.hint}>Complete sign-in in your browser...</p>
                <Button variant="ghost" size="sm" onClick={handleCancel} className={styles.cancelButton}>
                  Cancel
                </Button>
              </div>
            )}

            {!isLoading && otpStep === 'hidden' && (
              <button type="button" className={styles.emailLink} onClick={handleShowEmailInput}>
                Or continue with email
              </button>
            )}

            {otpStep === 'email' && (
              <div className={styles.emailSection}>
                <div className={styles.divider}>
                  <span>or</span>
                </div>
                <Input
                  type="email"
                  placeholder="Enter your email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={styles.emailInput}
                  disabled={otpLoading}
                  autoFocus
                  onKeyDown={(e) => e.key === 'Enter' && handleSendOtp()}
                />
                <Button
                  variant="outline"
                  size="lg"
                  className={styles.sendCodeButton}
                  onClick={handleSendOtp}
                  disabled={otpLoading || !email.trim()}
                >
                  {otpLoading ? 'Sending...' : 'Send code'}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );
}

function MicrosoftIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="1" width="10" height="10" fill="#F25022" />
      <rect x="13" y="1" width="10" height="10" fill="#7FBA00" />
      <rect x="1" y="13" width="10" height="10" fill="#00A4EF" />
      <rect x="13" y="13" width="10" height="10" fill="#FFB900" />
    </svg>
  );
}

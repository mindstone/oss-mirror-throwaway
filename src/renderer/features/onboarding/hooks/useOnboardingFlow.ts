import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { AppSettings, PersonalizedUseCase } from '@shared/types';
import type { SpaceInfo } from '@shared/ipc/schemas/library';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { tracking } from '@renderer/src/tracking';
import { recordRendererBreadcrumb } from '@renderer/src/sentry';
import { useToast } from '@renderer/components/ui';
import { useTimeoutRef } from '@renderer/hooks/useTimeoutRef';
import { useIntervalRef } from '@renderer/hooks/useIntervalRef';
import { fetchSpaces, getSpacesSnapshotFor, invalidateSpaces } from '@renderer/hooks/useSpacesData';
import { withRendererTimeout } from '@renderer/utils/withRendererTimeout';
import { getApiKey } from '@renderer/features/settings/utils/modelAuthAccessors';
import { useSubscriptionState } from '@renderer/hooks/useSubscriptionState';
import {
  useConnectorSetupGuidance,
  type MaybeSetupGuidanceResult,
  type UseConnectorSetupGuidanceResult,
} from '@renderer/features/settings/hooks/useConnectorSetupGuidance';
import {
  isConnectedStatus,
  isErrorStatus,
  isGeneratingStatus,
  isInFlight,
  isPollingStatus,
  isPendingStatus,
  isReadyToConnectStatus,
  toolAuthEventFromAuthUrlResponse,
  toolAuthEventFromVerifyResponse,
  toolAuthReducer,
  type ToolAuthEvent,
  type ToolAuthFieldPatch,
  type VerifyResponseSource,
} from './toolAuthMachine';
import type { ApiKeyValidation, ApiKeyValidationStatus } from './apiKeyValidationTypes';
import {
  INITIAL_API_KEY_VALIDATION,
  canSkipOf,
  resetValidation,
  statusOf,
  summariseValidation,
  validated,
  validating,
} from './apiKeyValidationMachine';
import type { OnboardingStep } from '@shared/trackingTypes';

export const ONBOARDING_ORGANISATION_SEED_FAILURE_TOAST =
  "We saved your settings but couldn't tag the first space's organisation. You can set it in Settings → Spaces.";

async function getUserSpacesFromSharedCache(coreDirectory: string): Promise<SpaceInfo[]> {
  await fetchSpaces(coreDirectory, { force: true });
  const snapshot = getSpacesSnapshotFor(coreDirectory);
  if (snapshot.error) {
    throw new Error(snapshot.errorMessage ?? 'Failed to scan Spaces.');
  }
  return snapshot.spaces.filter(s => s.type !== 'chief-of-staff');
}

/**
 * Maps technical error messages to user-friendly descriptions.
 */
function friendlyErrorMessage(error: string | null | undefined): string {
  if (!error) return 'Something went sideways — try again.';
  
  const lower = error.toLowerCase();
  
  // Network/timeout errors
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('aborted')) {
    return "That took longer than expected. Check your internet and try again.";
  }
  if (lower.includes('network') || lower.includes('fetch') || lower.includes('econnrefused')) {
    return "Couldn't reach the network. Check your connection and try again.";
  }
  
  // MCP errors
  if (lower.includes('mcp not configured')) {
    return "Tool connections aren't set up yet. Finish the previous step first.";
  }
  
  // Auth errors
  if (lower.includes('401') || lower.includes('unauthorized')) {
    return "That sign-in didn't take. Try connecting again.";
  }
  if (lower.includes('403') || lower.includes('forbidden')) {
    return "Access denied — check your account permissions.";
  }
  
  // Generic errors - keep short and actionable
  if (lower.includes('failed to generate auth link')) {
    return "Couldn't start the connection. Try again.";
  }
  if (lower.includes('failed to verify')) {
    return "Couldn't verify your connection. Try again.";
  }
  
  // If it's already reasonably user-friendly (short, no stack trace), return as-is
  if (error.length < 100 && !error.includes('\n') && !error.includes('Error:')) {
    return error;
  }
  
  return 'Something went sideways — try again.';
}

/**
 * Checks if an error is transient (network/timeout) and worth retrying.
 */
function isTransientError(error: string | null | undefined): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  return (
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('aborted') ||
    lower.includes('network') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('fetch')
  );
}

/**
 * Poll for Microsoft auth completion as a fallback for missed deep link callbacks.
 * Returns a promise that resolves when connected or rejects when aborted.
 * This helps recover when the OAuth callback is delivered to a different app instance.
 */
function pollForMicrosoftAuth(
  intervalMs: number,
  signal?: AbortSignal,
): Promise<{ polled: true }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    // eslint-disable-next-line prefer-const -- assigned after cleanup closure captures it
    let intervalId: ReturnType<typeof setInterval> | undefined;

    const cleanup = () => {
      if (intervalId) clearInterval(intervalId);
    };

    const handleAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };

    signal?.addEventListener('abort', handleAbort, { once: true });

    const check = async () => {
      try {
        const result = await window.microsoftApi.isConnected();
        if (result.connected) {
          cleanup();
          signal?.removeEventListener('abort', handleAbort);
          resolve({ polled: true });
        }
      } catch {
        // Ignore errors, keep polling
      }
    };

    // First check after intervalMs, then repeat
    intervalId = setInterval(check, intervalMs);
  });
}

/**
 * Poll for Slack auth completion as a fallback for missed deep link callbacks.
 * Returns a promise that resolves when connected or rejects when aborted.
 * Slack uses the same deep link pattern as Microsoft (mindstone://slack/callback).
 */
function pollForSlackAuth(
  intervalMs: number,
  signal?: AbortSignal,
): Promise<{ polled: true; teamName?: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    // eslint-disable-next-line prefer-const -- assigned after cleanup closure captures it
    let intervalId: ReturnType<typeof setInterval> | undefined;

    const cleanup = () => {
      if (intervalId) clearInterval(intervalId);
    };

    const handleAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };

    signal?.addEventListener('abort', handleAbort, { once: true });

    const check = async () => {
      try {
        const result = await window.slackApi.getWorkspaces();
        if (result.workspaces && result.workspaces.length > 0) {
          cleanup();
          signal?.removeEventListener('abort', handleAbort);
          resolve({ polled: true, teamName: result.workspaces[0].teamName });
        }
      } catch {
        // Ignore errors, keep polling
      }
    };

    // First check after intervalMs, then repeat
    intervalId = setInterval(check, intervalMs);
  });
}

/**
 * Use case generation status for the final setup step.
 */
export type UseCaseGenerationStatus = 'idle' | 'generating' | 'success' | 'error';

/**
 * Step identifiers for the onboarding wizard.
 */
export type WizardStep = 'welcome' | 'migrationImport' | 'googleDrive' | 'api' | 'voiceSetup' | 'toolAuth';

/**
 * Full ordered sequence of onboarding steps (internal navigation).
 */
export const FULL_STEP_SEQUENCE: WizardStep[] = ['welcome', 'googleDrive', 'api', 'voiceSetup', 'toolAuth'];
export const MIGRATION_IMPORT_STEP_SEQUENCE: WizardStep[] = ['welcome', 'migrationImport'];

/**
 * Legacy export for backward compatibility.
 * @deprecated Use FULL_STEP_SEQUENCE instead
 */
export const STEP_SEQUENCE: WizardStep[] = FULL_STEP_SEQUENCE;

/**
 * Steps shown as pills in the wizard UI (excludes welcome).
 * Welcome is a pre-step that doesn't count toward numbered progress.
 */
export const DISPLAY_STEPS: WizardStep[] = ['googleDrive', 'api', 'voiceSetup', 'toolAuth'];

/**
 * Human-readable labels for each step in the compact stepper UI.
 */
export const STEP_LABELS: Record<WizardStep, string> = {
  welcome: 'Welcome',
  migrationImport: 'Bring Rebel over',
  googleDrive: 'Spaces',
  api: 'Connect AI',
  voiceSetup: 'Voice',
  toolAuth: 'Connectors',
};

/**
 * More descriptive labels used for screen readers and progress summaries.
 */
export const STEP_ACCESSIBLE_LABELS: Record<WizardStep, string> = {
  welcome: 'Welcome',
  migrationImport: 'Bring Rebel over',
  googleDrive: 'Spaces',
  api: 'Connect your AI',
  voiceSetup: 'Talk to Rebel',
  toolAuth: 'Set up your connectors',
};

export function isTrackedOnboardingStep(step: WizardStep): step is Extract<WizardStep, OnboardingStep> {
  return step !== 'migrationImport';
}

/**
 * Tool authentication status for each tool in the toolAuth step.
 */
// ToolAuthStatus, ToolType, ToolAuthState live in `./toolAuthTypes` (extracted to
// break a useOnboardingFlow ↔ toolAuthMachine import cycle). Re-exported here so
// existing consumers (ToolAuthStep, steps/types) keep importing them from this
// module unchanged — see invariant #2 in the plan.
export type { ToolAuthStatus, ToolType, ToolAuthState } from './toolAuthTypes';
import type { ToolAuthStatus, ToolType, ToolAuthState } from './toolAuthTypes';

/**
 * Provider-agnostic tool categories for tracking events.
 * Maps specific tool types to their category for analytics.
 */
export type ToolTrackingCategory = 'email' | 'calendar' | 'chat';

/**
 * Maps specific tool types to their provider-agnostic tracking category.
 */
export const TOOL_TO_TRACKING_CATEGORY: Record<ToolType, ToolTrackingCategory> = {
  'gmail': 'email',
  'outlook-mail': 'email',
  'google-calendar': 'calendar',
  'outlook-calendar': 'calendar',
  'slack': 'chat',
  'teams': 'chat',
};

/**
 * Tools grouped by category - used to prevent multiple providers in the same category connecting simultaneously.
 */
const TOOL_CATEGORY: Record<ToolType, ToolTrackingCategory> = {
  gmail: 'email',
  'outlook-mail': 'email',
  'google-calendar': 'calendar',
  'outlook-calendar': 'calendar',
  slack: 'chat',
  teams: 'chat',
};

/**
 * Tools that are considered "email" tools - one must be connected to proceed.
 */
export const EMAIL_TOOLS: ToolType[] = ['gmail', 'outlook-mail'];
const TOOL_AUTH_ORDER: ToolType[] = [];


/**
 * Initial tool auth states for the toolAuth step.
 * One email tool (Gmail or Outlook Mail) is required, Calendar and Chat are optional.
 * Tools are grouped by category: Email (Gmail/Outlook Mail), Calendar, Chat.
 */
export const INITIAL_TOOL_AUTH_STATES: ToolAuthState[] = [
  // Email tools - one is required
  {
    tool: 'gmail',
    displayName: 'Gmail',
    description: 'Connect your Gmail account',
    serverName: 'gmail',
    status: 'pending',
    authUrl: null,
    error: null,
    awaitingSince: null,
    required: true, // Either Gmail or Outlook Mail is required (enforced by toolAuthReady logic)
  },
  {
    tool: 'outlook-mail',
    displayName: 'Outlook Mail',
    description: 'Connect your Outlook account',
    serverName: 'outlook mail',
    status: 'pending',
    authUrl: null,
    error: null,
    awaitingSince: null,
    required: false, // User-initiated; gating logic still requires any email (Gmail OR Outlook Mail)
  },
  // Calendar tools - optional
  {
    tool: 'google-calendar',
    displayName: 'Google Calendar',
    description: 'Connect your calendar',
    serverName: 'google calendar',
    status: 'pending',
    authUrl: null,
    error: null,
    awaitingSince: null,
    required: false,
  },
  {
    tool: 'outlook-calendar',
    displayName: 'Outlook Calendar',
    description: 'Connect your Outlook calendar',
    serverName: 'outlook calendar',
    status: 'pending',
    authUrl: null,
    error: null,
    awaitingSince: null,
    required: false,
  },
  // Chat tools - optional
  {
    tool: 'slack',
    displayName: 'Slack',
    description: 'Connect team messaging',
    serverName: 'slack',
    status: 'pending',
    authUrl: null,
    error: null,
    awaitingSince: null,
    required: false,
  },
  {
    tool: 'teams',
    displayName: 'Microsoft Teams',
    description: 'Connect team messaging',
    serverName: 'microsoft teams',
    status: 'pending',
    authUrl: null,
    error: null,
    awaitingSince: null,
    required: false,
  },
];

type MicrophoneStatus = 'unknown' | 'checking' | 'granted' | 'denied' | 'not-determined' | 'restricted';

/**
 * API key validation status for automatic step skipping. The canonical
 * definition now lives in `./apiKeyValidationTypes` (extracted to break the
 * hook⇄machine import cycle); re-exported here so existing consumers that import
 * it from this hook (and the `OnboardingFlowState` annotation below) stay
 * unbroken.
 */
export type { ApiKeyValidationStatus } from './apiKeyValidationTypes';

export type OnboardingFlowState = {
  // Navigation
  stepIndex: number;
  activeStep: WizardStep;
  totalSteps: number;
  canProceed: boolean;
  triedContinue: boolean;
  /** The step sequence for this onboarding flow */
  stepSequence: WizardStep[];

  // API key validation for step skipping (returning users)
  /** Current status of background API key validation */
  apiKeyValidationStatus: ApiKeyValidationStatus;
  /** True if validation succeeded while still on welcome step - safe to skip API step */
  canSkipApiStep: boolean;

  // Permissions
  microphoneStatus: MicrophoneStatus;

  // Completion
  isCompleting: boolean;
  completionError: string | null;

  // Tool Auth step skip state (dev mode only)
  canSkipToolAuth: boolean;

  // Tool Auth step (Step 6)
  toolAuthStates: ToolAuthState[];
  isGeneratingAuthLinks: boolean;
  isVerifyingAuth: boolean;
  toolAuthReady: boolean;
  /** The tool currently being authenticated */
  activeAuthTool: ToolType | null;

  // User info
  userFirstName: string | null;
  fetchingUserName: boolean;

  // Google Drive / Spaces state
  googleDriveInstalled: boolean;
  companyName: string;
  googleDriveError: string | null;
  googleDriveReady: boolean;
  /** Unified list of connected spaces (replaces pendingDriveLinks + createdDriveLinks + wizardCreatedSpaces) */
  connectedSpaces: SpaceInfo[];

  // Org config onboarding streamlining
  /** Company display name from org auth config (authoritative when set) */
  orgCompanyDisplayName: string | null;
  /** True if org config has at least one space defined */
  orgHasSpaces: boolean;
  /** Shared drive provider from org config (e.g. "google-drive", "onedrive", "dropbox") */
  orgSharedDriveProvider: string | null;

  // OneDrive state
  oneDriveInstalled: boolean;
  oneDriveConfigured: boolean;

  // Use case generation state
  useCaseGenerationStatus: UseCaseGenerationStatus;
  useCaseGenerationError: string | null;
  generatedUseCases: PersonalizedUseCase[];
  useCasesReady: boolean;

  // Validation states
  workspaceReady: boolean;
  workspaceValidation: {
    checking: boolean;
    errors: string[];
    warnings: string[];
  };
  claudeReady: boolean;
  voiceReady: boolean;
  voiceProvider: AppSettings['voice']['provider'];
  
  // EULA acceptance
  eulaAccepted: boolean;

  // Connector setup guidance (broken-by-default OAuth). OnboardingWizard renders
  // `ConnectorSetupDialog` from this controller so a not-configured start-auth result opens the
  // shared setup dialog instead of being dropped.
  setupGuidance: UseConnectorSetupGuidanceResult;
};

export type OnboardingFlowActions = {
  setStepIndex: (index: number) => void;
  goNext: () => Promise<void>;
  goBack: () => void;
  completeOnboardingWithOrganisationSeed: (options?: { skipAudioIntro?: boolean }) => Promise<void>;
  setMicrophoneStatus: (status: MicrophoneStatus) => void;
  setIsCompleting: (completing: boolean) => void;
  setCompletionError: (error: string | null) => void;
  // Tool Auth actions
  //
  // M3 (escape-hatch quarantine): `updateToolAuthState` is a FIELD-ONLY patch. A
  // `status` change is NOT representable here by design — it is a COMPILE ERROR.
  // Status transitions must go through a named action (`generateAuthLink`,
  // `startOAuthFlow`, `markToolAuthConnected`, `observeCatalogConnection`,
  // `disconnectToolAuth`, `verifyToolAuth`, the polling effect) so the FSM
  // transition table is the single arbiter of what status changes are legal.
  // No full-replace `setToolAuthStates` is exposed on the production contract —
  // the reducer's `STATES_REPLACED` primitive (still validated + reducer-tested)
  // is intentionally not surfaced as an action, so there is no status-bypass
  // escape hatch on `OnboardingFlowActions`. See `toolAuthMachine.ts` header + PLAN.md M3.
  updateToolAuthState: (tool: ToolType, updates: ToolAuthFieldPatch) => void;
  /**
   * TEST-ONLY status driver. Drives a tool through a guarded `PATCH_STATUS`
   * transition (validated by the FSM table). Production code MUST use the named
   * status actions instead — this exists purely so integration tests can set up
   * arbitrary FSM states without threading IPC mocks. Prefixed `__` + suffixed
   * `ForTest` so it can never be mistaken for a production status writer.
   */
  setToolAuthStatusForTest: (
    tool: ToolType,
    status: ToolAuthStatus,
    fields?: ToolAuthFieldPatch,
  ) => void;
  clearToolAuthError: (tool: ToolType) => void;
  observeCatalogConnection: (tool: ToolType) => void;
  markToolAuthConnected: (tool: ToolType) => void;
  disconnectToolAuth: (tool: ToolType) => void;
  generateAuthLink: (tool: ToolType, options?: { autoStart?: boolean }) => Promise<void>;
  /** Start OAuth flow - opens URL and begins polling. Call when user clicks Connect. */
  startOAuthFlow: (tool: ToolType) => void;
  verifyToolAuth: (tool: ToolType) => Promise<boolean>;
  /** Skip a specific tool (for optional tools) - not used in grid view */
  skipTool: (tool: ToolType) => void;
  // User info actions
  setUserFirstName: (name: string | null) => void;
  setFetchingUserName: (fetching: boolean) => void;
  handleFinish: () => Promise<void>;
  // Google Drive / Spaces actions
  setGoogleDriveInstalled: (installed: boolean) => void;
  setCompanyName: (name: string) => void;
  setGoogleDriveError: (error: string | null) => void;
  /** Add a space to the connected spaces list */
  addConnectedSpace: (space: SpaceInfo) => void;
  /** Remove a space from the connected spaces list by path */
  removeConnectedSpace: (path: string) => void;
  /** Refresh connected spaces from workspace scan */
  refreshConnectedSpaces: () => Promise<void>;
  // Use case generation actions
  startUseCaseGeneration: () => Promise<void>;
  retryUseCaseGeneration: () => Promise<void>;
  // EULA acceptance actions
  setEulaAccepted: (accepted: boolean) => void;
  startMigrationImportBranch: () => void;
  startStandardSetupBranch: () => void;
};

export type UseOnboardingFlowOptions = {
  isOpen: boolean;
  draftSettings: AppSettings | null;
  completeOnboarding: (options?: { skipAudioIntro?: boolean }) => Promise<void>;
  onUserNameFetched?: (firstName: string | null) => void;
};

/**
 * Hook that manages onboarding wizard flow state.
 * Extracts navigation, validation, and completion logic from OnboardingWizard.
 *
 * @example
 * const { state, actions } = useOnboardingFlow({
 *   isOpen,
 *   draftSettings,
 *   completeOnboarding,
 *   onUserNameFetched
 * });
 */
export const useOnboardingFlow = ({
  isOpen,
  draftSettings,
  completeOnboarding,
  onUserNameFetched,
}: UseOnboardingFlowOptions): { state: OnboardingFlowState; actions: OnboardingFlowActions } => {
  const { showToast } = useToast();
  // Shared connector setup-guidance funnel: when a local OAuth provider is broken-by-default (no
  // client credentials configured), `generateAuthLink` routes the start-auth result here so the
  // `ConnectorSetupDialog` (rendered by OnboardingWizard from `state.setupGuidance`) opens instead
  // of dropping `setupGuidance` into a generic GENERATE_FAILED message.
  const setupGuidanceDialog = useConnectorSetupGuidance();
  // API-key validation lives in a single discriminated-union state (the pure
  // machine in ./apiKeyValidationMachine). It is declared here, before the
  // stepSequence useMemo, because the derived `canSkipApiStep` is consumed by
  // that useMemo (TDZ/ordering requirement — set by the validation effect below).
  const [apiKeyValidation, setApiKeyValidation] = useState<ApiKeyValidation>(INITIAL_API_KEY_VALIDATION);
  // Derived public surface: flat 4-value status + skip flag. `canSkipApiStep` is
  // DERIVED (never stored) so it cannot drift from the status — the bug class
  // this extraction kills by construction.
  const apiKeyValidationStatus = statusOf(apiKeyValidation);
  const canSkipApiStep = canSkipOf(apiKeyValidation);
  const [canSkipGoogleDriveStep, setCanSkipGoogleDriveStep] = useState(false);

  // Org config state for onboarding streamlining (hide sections, pre-fill company name)
  const [orgCompanyDisplayName, setOrgCompanyDisplayName] = useState<string | null>(null);
  const [orgHasSpaces, setOrgHasSpaces] = useState(false);
  const [orgSharedDriveProvider, setOrgSharedDriveProvider] = useState<string | null>(null);
  const [migrationImportBranchActive, setMigrationImportBranchActive] = useState(false);

  // Step sequence - dynamically excludes steps based on validation results
  // This prevents returning users with valid keys from seeing the API step,
  // and free-tier users (no license) from seeing the Spaces step
  const stepSequence = useMemo(() => {
    if (migrationImportBranchActive) {
      return [...MIGRATION_IMPORT_STEP_SEQUENCE];
    }
    let sequence = [...FULL_STEP_SEQUENCE];
    if (canSkipApiStep) {
      sequence = sequence.filter(step => step !== 'api');
    }
    if (canSkipGoogleDriveStep) {
      sequence = sequence.filter(step => step !== 'googleDrive');
    }
    return sequence;
  }, [canSkipApiStep, canSkipGoogleDriveStep, migrationImportBranchActive]);
  
  // Navigation state
  const [stepIndex, setStepIndex] = useState(0);
  // Ref for async code that needs current stepIndex value (declared here, before first use)
  const stepIndexRef = useRef<number>(0);
  // Keep ref in sync with state on every render
  stepIndexRef.current = stepIndex;
  // Current `isOpen` for async continuations. The wizard hook stays mounted while
  // closed (OnboardingWizard is rendered unconditionally by App; close is just
  // isOpen=false), so an in-flight effect that resolves after close would still
  // fire onboarding-funnel analytics for a wizard the user already abandoned.
  // Async effects read this ref (not the captured `isOpen` closure) before emitting
  // tracking so closed-window events don't pollute funnel metrics. Mirrors the
  // isPollingInProgressRef recheck the OAuth verify effect already uses.
  const isOpenRef = useRef<boolean>(isOpen);
  isOpenRef.current = isOpen;
  const [triedContinue, setTriedContinue] = useState(false);

  // Permission states
  const [microphoneStatus, setMicrophoneStatus] = useState<MicrophoneStatus>('checking');

  // Completion state
  const [isCompleting, setIsCompleting] = useState(false);
  const [completionError, setCompletionError] = useState<string | null>(null);

  // Tool Auth states
  const [toolAuthStates, dispatchToolAuthEvent] = useReducer(toolAuthReducer, INITIAL_TOOL_AUTH_STATES);
  const [isGeneratingAuthLinks, setIsGeneratingAuthLinks] = useState(false);
  const [isVerifyingAuth, setIsVerifyingAuth] = useState(false);

  // Track which tool is currently active for sequential auth flow
  const [activeAuthTool, setActiveAuthTool] = useState<ToolAuthState['tool'] | null>(null);
  // Track tools that user has explicitly skipped
  const [_skippedTools, setSkippedTools] = useState<Set<ToolAuthState['tool']>>(new Set());
  // Interval for OAuth completion polling
  const oauthPollingInterval = useIntervalRef();
  // Timer for initial polling (first poll after delay)
  const oauthPollingTimer = useTimeoutRef();
  // Timer for OAuth timeout (stop after max wait)
  const oauthPollingTimeout = useTimeoutRef();
  // Ref to track if a polling verification is already in progress (prevents overlapping requests)
  const isPollingInProgressRef = useRef(false);
  // Ref to track if background verification has started (prevents duplicate runs)
  // Ref for stable access to toolAuthStates in callbacks (avoids stale closures)
  const toolAuthStatesRef = useRef(toolAuthStates);
  toolAuthStatesRef.current = toolAuthStates;

  // User info
  const [userFirstName, setUserFirstName] = useState<string | null>(null);
  const [fetchingUserName, setFetchingUserName] = useState(false);

  // Google Drive / Spaces state
  const [googleDriveInstalled, setGoogleDriveInstalled] = useState(false);
  const [companyName, setCompanyName] = useState('');
  const [googleDriveError, setGoogleDriveError] = useState<string | null>(null);
  /** Unified list of connected spaces (replaces pendingDriveLinks + createdDriveLinks + wizardCreatedSpaces) */
  const [connectedSpaces, setConnectedSpaces] = useState<SpaceInfo[]>([]);

  // OneDrive state
  const [oneDriveInstalled, setOneDriveInstalled] = useState(false);
  const [oneDriveConfigured, setOneDriveConfigured] = useState(false);

  // Use case generation state
  const [useCaseGenerationStatus, setUseCaseGenerationStatus] = useState<UseCaseGenerationStatus>('idle');
  const [useCaseGenerationError, setUseCaseGenerationError] = useState<string | null>(null);
  const [generatedUseCases, setGeneratedUseCases] = useState<PersonalizedUseCase[]>([]);
  const useCaseGenerationInitiatedRef = useRef(false);

  // EULA acceptance state
  const [eulaAccepted, setEulaAccepted] = useState(false);

  // Workspace path validation state
  const [workspaceValidation, setWorkspaceValidation] = useState<{
    checking: boolean;
    errors: string[];
    warnings: string[];
  }>({ checking: false, errors: [], warnings: [] });
  const workspaceValidationTimer = useTimeoutRef();

  // Tracking refs
  const [onboardingStartTime] = useState(() => Date.now());
  const stepStartTimeRef = useRef<number>(Date.now());
  const prevStepIndexRef = useRef<number>(0);
  // Note: stepIndexRef is declared earlier (near stepIndex state) to avoid TDZ error
  
  // Track if we've initialized state from settings (to avoid re-initializing on every render)
  const hasInitializedFromSettingsRef = useRef(false);
  // Track if we've scanned for existing spaces
  const hasScannedSpacesRef = useRef(false);
  // Track if we've detected Google Drive installation
  const hasDetectedGoogleDriveRef = useRef(false);
  // Track if we've detected OneDrive installation
  const hasDetectedOneDriveRef = useRef(false);
  // Track if we've validated API keys for step skipping
  const hasValidatedApiKeysRef = useRef(false);
  // Track if we've fetched auth config for org onboarding streamlining
  const hasCheckedAuthConfigRef = useRef(false);
  // AbortController for Microsoft OAuth polling fallback (cleanup on unmount or when auth completes)
  const microsoftPollingAbortRef = useRef<AbortController | null>(null);
  // AbortController for Slack OAuth polling fallback (same deep link pattern as Microsoft)
  const slackPollingAbortRef = useRef<AbortController | null>(null);

  // Note: API-key validation state (apiKeyValidation) is declared earlier
  // (before the stepSequence useMemo), and apiKeyValidationStatus/canSkipApiStep
  // are derived from it there.

  // Cleanup deep-link OAuth polling on unmount (Microsoft and Slack)
  useEffect(() => {
    return () => {
      microsoftPollingAbortRef.current?.abort();
      slackPollingAbortRef.current?.abort();
    };
  }, []);

  // Reset step when wizard closes
  useEffect(() => {
    if (!isOpen) {
      setStepIndex(0);
      // Reset initialization flags so we re-initialize when wizard reopens
      hasInitializedFromSettingsRef.current = false;
      hasScannedSpacesRef.current = false;
      hasDetectedGoogleDriveRef.current = false;
      hasDetectedOneDriveRef.current = false;
      hasValidatedApiKeysRef.current = false;
      hasCheckedAuthConfigRef.current = false;
      // Reset API key validation state (collapses status + skip flag to idle/false)
      setApiKeyValidation(resetValidation());
      setCanSkipGoogleDriveStep(false);
      // Reset org config state
      setOrgCompanyDisplayName(null);
      setOrgHasSpaces(false);
      setOrgSharedDriveProvider(null);
      // Reset sequential auth state
      setActiveAuthTool(null);
      setSkippedTools(new Set());
      // Reset EULA checkbox state. If it was previously accepted, the initialization effect
      // will re-hydrate it from `draftSettings.eulaAcceptedAt` when the wizard re-opens.
      setEulaAccepted(false);
      setMigrationImportBranchActive(false);
    }
  }, [isOpen]);
  
  // Initialize state from draftSettings when wizard opens (for relaunch scenario)
  useEffect(() => {
    if (!isOpen || !draftSettings || hasInitializedFromSettingsRef.current) {
      return;
    }
    
    hasInitializedFromSettingsRef.current = true;
    
    // Pre-populate Google Drive state from settings
    if (draftSettings.companyName) {
      setCompanyName(draftSettings.companyName);
    }
    if (draftSettings.googleDriveInstalled) {
      setGoogleDriveInstalled(draftSettings.googleDriveInstalled);
    }
    
    // Pre-populate EULA acceptance if previously accepted
    if (draftSettings.eulaAcceptedAt) {
      setEulaAccepted(true);
    }
    
    // NOTE: We intentionally do NOT pre-populate use cases from settings here.
    // Use cases must be freshly generated each time the onboarding wizard runs
    // to ensure repersonalization based on newly gathered context (email, calendar, etc.).
    // The reset effect (below) ensures useCaseGenerationStatus starts as 'idle'.
    
    // NOTE: connectedSpaces is populated via workspace scan, not from settings
    // This ensures we have the latest filesystem state
    
  }, [isOpen, draftSettings]);

  // Scan workspace for existing spaces when wizard opens
  // This populates connectedSpaces so users see what's already configured
  useEffect(() => {
    if (!isOpen || hasScannedSpacesRef.current) {
      return;
    }
    
    // Only scan if workspace is configured
    const coreDirectory = draftSettings?.coreDirectory;
    if (!coreDirectory) {
      return;
    }
    
    hasScannedSpacesRef.current = true;
    
    
    void (async () => {
      try {
        const userSpaces = await getUserSpacesFromSharedCache(coreDirectory);
        if (userSpaces.length > 0) {
          setConnectedSpaces(userSpaces);
        }
      } catch (error) {
        ignoreBestEffortCleanup(error, {
          operation: 'useOnboardingFlow.scanWorkspaceSpaces',
          reason: 'Not critical — user can still add spaces manually',
        });
      }
    })();
  }, [isOpen, draftSettings?.coreDirectory]);

  // Detect Google Drive installation when wizard opens
  // This auto-populates googleDriveInstalled state and suggests company name
  useEffect(() => {
    if (!isOpen || hasDetectedGoogleDriveRef.current) {
      return;
    }
    
    hasDetectedGoogleDriveRef.current = true;
    
    
    void (async () => {
      try {
        const result = await window.libraryApi.detectGoogleDrive();
        
        
        if (result.installed) {
          setGoogleDriveInstalled(true);
        }
        
        // Pre-fill company name if detected and not already set
        // Don't override authoritative org config company name
        if (result.suggestedCompanyName && !companyName && !draftSettings?.companyName && !orgCompanyDisplayName) {
          setCompanyName(result.suggestedCompanyName);
        }
      } catch (error) {
        ignoreBestEffortCleanup(error, {
          operation: 'useOnboardingFlow.detectGoogleDrive',
          reason: 'Detection is best-effort — user can proceed normally',
        });
      }
    })();
  }, [isOpen, companyName, draftSettings?.companyName, orgCompanyDisplayName]);

  // Detect OneDrive installation when wizard opens
  // Fire-and-forget pattern (same as Google Drive) - detection is fast, no loading state needed
  useEffect(() => {
    if (!isOpen || hasDetectedOneDriveRef.current) {
      return;
    }
    
    hasDetectedOneDriveRef.current = true;
    
    
    void (async () => {
      try {
        const result = await window.libraryApi.detectOnedrive();
        
        
        // Always set state from result (ensures correct state if wizard reopens)
        setOneDriveInstalled(result.installed);
        setOneDriveConfigured(result.configured);
      } catch (error) {
        ignoreBestEffortCleanup(error, {
          operation: 'useOnboardingFlow.detectOneDrive',
          reason: 'Detection is best-effort — user can proceed normally',
        });
      }
    })();
  }, [isOpen]);

  // Fetch auth config to determine org onboarding streamlining
  // (skip Google Drive step, pre-fill company name from org config)
  // Follows the same fire-and-forget pattern as Google Drive/OneDrive detection
  useEffect(() => {
    if (!isOpen || hasCheckedAuthConfigRef.current) return;
    hasCheckedAuthConfigRef.current = true;


    void (async () => {
      try {
        const config = await window.authApi.getConfig();
        if (config) {
          if (config.companyDisplayName) {
            setOrgCompanyDisplayName(config.companyDisplayName);
            // Authoritative — always override any prior value
            setCompanyName(config.companyDisplayName);
          }
          setOrgHasSpaces(config.hasSpaces);
          if (config.sharedDriveProvider) {
            setOrgSharedDriveProvider(config.sharedDriveProvider);
          }
          if (config.licenseTier === 'free' && stepIndexRef.current === 0) {
            setCanSkipGoogleDriveStep(true);
            // Don't emit the funnel event for a wizard closed mid-fetch (see isOpenRef note).
            if (isOpenRef.current) {
              tracking.onboarding.spacesStepSkipped('free');
            }
          }
        }
      } catch (error) {
        ignoreBestEffortCleanup(error, {
          operation: 'useOnboardingFlow.fetchAuthConfigForStreamlining',
          reason: 'Auth config is best-effort — onboarding proceeds without org streamlining',
        });
      }
    })();
  }, [isOpen]);

  // Auto-create shared drive spaces from auth config
  // Runs once per wizard open. Fetches config, resolves paths, creates spaces.
  // Uses refs for state access to avoid stale closures and unnecessary effect re-runs.
  // NOTE: Shared drive auto-creation has been moved to the main process.
  // See sharedDriveService.reconcileSharedDriveSpaces() — triggered by:
  // 1. fetchAuthConfig() after login/startup
  // 2. settings:update when coreDirectory is first set (onboarding completion)

  // Validate API keys when wizard opens (for returning users)
  // If both Claude and voice keys are valid, we can skip the API step
  // This follows the same fire-and-forget pattern as Google Drive/OneDrive detection
  useEffect(() => {
    if (!isOpen || hasValidatedApiKeysRef.current) {
      return;
    }
    
    // Need draftSettings to check keys
    if (!draftSettings) {
      return;
    }
    
    // Check if we have any keys to validate
    const claudeKey = getApiKey(draftSettings);
    const voiceProvider = draftSettings.voice.provider ?? 'openai-whisper';
    const voiceKey = voiceProvider === 'openai-whisper'
      ? draftSettings.voice.openaiApiKey
      : voiceProvider === 'local-parakeet'
        ? null
        : draftSettings.voice.elevenlabsApiKey;
    
    // No keys to validate - stay in idle state
    if (!claudeKey && !voiceKey) {
      return;
    }
    
    hasValidatedApiKeysRef.current = true;
    setApiKeyValidation(validating());
    
    
    void (async () => {
      // DI-A (2026-04-27): adopted shared `withRendererTimeout` utility (was a
      // local helper that did not clear its timer on early settle). Behavior
      // is preserved: same `Error('timeout')` rejection, same TIMEOUT_MS, same
      // Promise.allSettled handling below treats rejections as invalid.
      const TIMEOUT_MS = 5000;

      // Validate both keys in parallel using Promise.allSettled
      const [claudeResult, voiceResult] = await Promise.allSettled([
        // Claude validation (API key only — OAuth removed April 2026)
        claudeKey
          ? withRendererTimeout(
              window.settingsApi.validateClaudeKey({ apiKey: claudeKey }),
              { timeoutMs: TIMEOUT_MS },
            )
          : Promise.resolve({ ok: false, reason: 'invalid' as const, message: 'No key' }),

        // Voice key validation (based on configured provider)
        voiceProvider === 'local-parakeet'
          ? Promise.resolve({ ok: true, reason: 'ok' as const, message: 'No key required for local provider' })
          : voiceKey
            ? withRendererTimeout(
                voiceProvider === 'openai-whisper'
                  ? window.settingsApi.validateOpenaiKey({ apiKey: voiceKey, deepValidate: false })
                  : window.settingsApi.validateElevenlabsKey({ apiKey: voiceKey }),
                { timeoutMs: TIMEOUT_MS },
              )
            : Promise.resolve({ ok: false, reason: 'invalid' as const, message: 'No key' }),
      ]);
      
      // Fold the two settled IPC results into the validation summary. The pure
      // `summariseValidation` reproduces (byte-for-byte) the old inline
      // claudeOk/voiceOk OK-predicate (rejection ⇒ invalid; `reason:'unreachable'`
      // ⇒ invalid fail-safe) and the failureReason precedence — treating the
      // settled values as `unknown` at the seam (no assertNever over raw IPC).
      const outcome = summariseValidation(claudeResult, voiceResult);


      // Capture the welcome-step TOCTOU decision at settle time (I9/I10): status
      // becomes `valid` unconditionally on both-valid, but the skip is only
      // allowed if the user is still on the welcome step at result-arrival time.
      // The union's `valid` variant carries this flag, so canSkip is derived and
      // cannot drift from the status.
      const onWelcomeStep = stepIndexRef.current === 0;
      setApiKeyValidation(validated(onWelcomeStep, outcome.bothValid));

      // Both must be valid to skip the API step.
      // Analytics emits are gated on the CURRENT isOpen (isOpenRef): if the wizard
      // was closed while this validation was in flight, the session was abandoned —
      // emitting apiStepSkipped/apiStepValidationFailed here would over-count
      // skips/failures in the onboarding funnel. The state write above is left
      // unconditional (it's local + self-corrects on reopen via the guard-ref reset).
      if (outcome.bothValid && onWelcomeStep) {
        // Track that the API step will be skipped (provider is the voice provider)
        if (isOpenRef.current) {
          tracking.onboarding.apiStepSkipped(voiceProvider);
        }
      } else if (outcome.bothValid) {
        // Both keys valid but the user advanced past the welcome step — no skip and
        // (deliberately) no validation-failure analytics. Intentionally a no-op branch.
      } else {
        // Track validation failure with the analytics reason derived by the fold.
        if (isOpenRef.current) {
          tracking.onboarding.apiStepValidationFailed(outcome.failureReason ?? 'unknown');
        }
      }
    })();
  }, [isOpen, draftSettings]);

  // Track onboarding started + wizard stage entered
  useEffect(() => {
    if (isOpen) {
      tracking.onboarding.started(false);
      tracking.onboarding.stageEntered('wizard');
    }
  }, [isOpen]);

  const activeStep = stepSequence[stepIndex];
  const totalSteps = stepSequence.length;

  // Track step views
  useEffect(() => {
    const isBackNavigation = stepIndex < prevStepIndexRef.current;
    if (isTrackedOnboardingStep(activeStep)) {
      tracking.onboarding.stepViewed(activeStep, stepIndex, isBackNavigation);
    }
    prevStepIndexRef.current = stepIndex;
    stepStartTimeRef.current = Date.now();
  }, [activeStep, stepIndex]);

  // Debounced workspace path validation
  useEffect(() => {
    // Clear any pending validation
    workspaceValidationTimer.clear();

    const pathToValidate = draftSettings?.coreDirectory;
    
    // Reset validation if path is empty
    if (!pathToValidate) {
      setWorkspaceValidation({ checking: false, errors: [], warnings: [] });
      return;
    }

    // Set checking state immediately
    setWorkspaceValidation(prev => ({ ...prev, checking: true }));

    // Debounce the actual validation call
    workspaceValidationTimer.set(() => {
      void (async () => {
        try {
          const result = await window.libraryApi.validatePath({ path: pathToValidate });
          setWorkspaceValidation({
            checking: false,
            errors: result.errors,
            warnings: result.warnings,
          });
        } catch (error) {
          console.error('Workspace validation failed:', error);
          // On error, don't block - just clear validation state
          setWorkspaceValidation({ checking: false, errors: [], warnings: [] });
        }
      })();
    }, 300);
  }, [draftSettings?.coreDirectory, workspaceValidationTimer]);

  // Validation states
  const workspaceReady = useMemo(
    () => Boolean(draftSettings?.coreDirectory) 
      && eulaAccepted 
      && !workspaceValidation.checking 
      && workspaceValidation.errors.length === 0,
    [draftSettings?.coreDirectory, eulaAccepted, workspaceValidation.checking, workspaceValidation.errors.length]
  );

  const claudeApiKey = getApiKey(draftSettings);
  const { isActive: subscriptionActive, isPastDueWithinGrace } = useSubscriptionState();
  const subscriptionEntitled = subscriptionActive || isPastDueWithinGrace;
  const claudeReady = useMemo(
    () =>
      Boolean(claudeApiKey) ||
      Boolean(draftSettings?.openRouter?.oauthToken) ||
      draftSettings?.activeProvider === 'codex' ||
      draftSettings?.activeProvider === 'mindstone' ||
      subscriptionEntitled,
    [claudeApiKey, draftSettings?.openRouter?.oauthToken, draftSettings?.activeProvider, subscriptionEntitled]
  );

  const voiceProvider = draftSettings?.voice.provider ?? 'openai-whisper';

  const voiceReady = useMemo(() => {
    if (!draftSettings) return false;
    if (voiceProvider === 'local-parakeet') return true;
    return voiceProvider === 'openai-whisper'
      ? Boolean(draftSettings.voice.openaiApiKey)
      : Boolean(draftSettings.voice.elevenlabsApiKey);
  }, [draftSettings, voiceProvider]);

  // Dev mode allows skipping certain onboarding steps for faster testing
  const isDevMode = import.meta.env.DEV;

  // Google Drive / Spaces step is always optional - users can skip without adding any spaces
  // Spaces are created immediately via the AddSpaceWizard dialog, not batched on Continue
  // Existing spaces are loaded on wizard open via the shared Spaces cache.
  const googleDriveReady = true;

  // Can skip tool auth in dev mode
  const canSkipToolAuth = isDevMode;

  // Tool Auth step is ready when ANY email tool (Gmail or Outlook Mail) is connected
  // OR if we can skip (dev mode)
  // OR if any email tool has an error (allow user to skip past failed auth)
  const toolAuthReady = useMemo(() => {
    if (canSkipToolAuth) return true;
    // Check if any email tool is connected (provider-agnostic)
    const anyEmailConnected = toolAuthStates.some(
      (t) => EMAIL_TOOLS.includes(t.tool) && isConnectedStatus(t.status)
    );
    // Allow skipping if email auth failed (user can set up later in Settings)
    const anyEmailError = toolAuthStates.some(
      (t) => EMAIL_TOOLS.includes(t.tool) && isErrorStatus(t.status)
    );
    return anyEmailConnected || anyEmailError;
  }, [toolAuthStates, canSkipToolAuth]);

  // Helper to get next tool that should auto-start (none; kept for compatibility)
  const getNextPendingTool = useCallback((): ToolType | null => {
    for (const tool of TOOL_AUTH_ORDER) {
      const state = toolAuthStates.find((t) => t.tool === tool);
      if (!state) continue;
      
      // Skip if already connected or ready_to_connect
      if (isConnectedStatus(state.status) || isReadyToConnectStatus(state.status)) continue;
      
      // Return if needs auth URL generation
      if (!isConnectedStatus(state.status) && !isReadyToConnectStatus(state.status)) {
        return tool;
      }
    }
    return null;
  }, [toolAuthStates]);

  // Reset activeAuthTool when leaving the toolAuth step
  useEffect(() => {
    if (!isOpen || activeStep !== 'toolAuth') {
      if (activeAuthTool !== null) {
        setActiveAuthTool(null);
      }
    }
  }, [isOpen, activeStep, activeAuthTool]);

  // NOTE: Background tool verification was intentionally removed.
  // It caused UI flicker and introduced race conditions with auth URL generation.

  // Check for existing Google Workspace accounts when entering toolAuth step
  // This detects if Gmail/Calendar were already authorized (e.g., via chained OAuth after login)
  const hasCheckedGoogleAccountsRef = useRef(false);
  useEffect(() => {
    // Reset ref when leaving toolAuth step
    if (!isOpen || activeStep !== 'toolAuth') {
      hasCheckedGoogleAccountsRef.current = false;
      return;
    }

    // Only check once per step entry
    if (hasCheckedGoogleAccountsRef.current) return;
    hasCheckedGoogleAccountsRef.current = true;


    void (async () => {
      try {
        const result = await window.googleWorkspaceApi.getAccounts();
        
        if (result.accounts && result.accounts.length > 0) {
          // Find accounts with active status (tokens are valid)
          const activeAccounts = result.accounts.filter(a => a.status === 'active');
          
          if (activeAccounts.length > 0) {

            const pendingGoogleTools = toolAuthStatesRef.current
              .filter((t) => (t.tool === 'gmail' || t.tool === 'google-calendar') && isPendingStatus(t.status))
              .map((t) => t.tool);

            if (pendingGoogleTools.length > 0) {
              dispatchToolAuthEvent({
                type: 'EXISTING_ACCOUNT_FOUND',
                tools: pendingGoogleTools,
              });
            }
          }
        }
      } catch (error) {
        ignoreBestEffortCleanup(error, {
          operation: 'useOnboardingFlow.checkExistingGoogleAccounts',
          reason: 'Best-effort prefill — user can still connect Google manually',
        });
      }
    })();
  }, [isOpen, activeStep]);

  // Auto-advance to next tool when current tool becomes connected
  useEffect(() => {
    if (!isOpen || activeStep !== 'toolAuth' || !activeAuthTool) {
      return;
    }
    
    const currentToolState = toolAuthStates.find((t) => t.tool === activeAuthTool);
    if (!currentToolState) {
      return;
    }
    
    // For grid-based flow: only advance when connected
    // ready_to_connect means "URL ready, waiting for user click" - no auto-advance needed
    if (isConnectedStatus(currentToolState.status)) {
      if (TOOL_AUTH_ORDER.includes(activeAuthTool)) {
        const nextTool = getNextPendingTool();
        // Only update if the value actually changes (prevents infinite loop)
        if (nextTool !== activeAuthTool) {
          setActiveAuthTool(nextTool);
        }
      } else {
        // For dropdown-initiated tools (e.g., Outlook Mail), do not auto-advance to other providers
        setActiveAuthTool(null);
      }
    }
  }, [isOpen, activeStep, activeAuthTool, toolAuthStates, getNextPendingTool]);

  // OAuth completion polling - first poll after short delay, then every 5s
  useEffect(() => {
    // Clear any existing polling timeout and interval
    oauthPollingTimer.clear();
    oauthPollingInterval.clear();
    oauthPollingTimeout.clear();
    
    // Only poll on toolAuth step when there's an active tool
    if (!isOpen || activeStep !== 'toolAuth' || !activeAuthTool) {
      return;
    }
    
    // Only poll when tool is in awaiting_auth state
    const currentToolState = toolAuthStates.find((t) => t.tool === activeAuthTool);
    if (!currentToolState || !isPollingStatus(currentToolState.status)) {
      return;
    }
    
    
    // Reset polling in progress flag when starting new polling
    isPollingInProgressRef.current = false;
    
    // Helper function to perform a single poll
    const performPoll = async (): Promise<boolean> => {
      // Use ref to get fresh tool state
      const toolState = toolAuthStatesRef.current.find((t) => t.tool === activeAuthTool);
      
      if (!toolState || !isPollingStatus(toolState.status)) {
        // Tool is no longer awaiting auth, stop polling
        oauthPollingTimer.clear();
        oauthPollingInterval.clear();
        isPollingInProgressRef.current = false;
        return true; // Signal to stop polling
      }
      
      // Skip if a polling request is already in progress (prevents overlapping requests)
      if (isPollingInProgressRef.current) {
        return false;
      }
      
      isPollingInProgressRef.current = true;
      
      try {
        const result = await window.miscApi.verifyToolAuth({
          tool: activeAuthTool,
          serverName: toolState.serverName,
          companyName: companyName || undefined
        });

        const event = toolAuthEventFromVerifyResponse(activeAuthTool, result, {
          source: 'poll' satisfies VerifyResponseSource,
        });
        dispatchToolAuthEvent(event);

        if (event.type === 'POLL_AUTHENTICATED') {
          tracking.onboarding.toolAuthVerified(TOOL_TO_TRACKING_CATEGORY[activeAuthTool], true);
          
          // Clear polling since tool is now connected
          oauthPollingTimer.clear();
          oauthPollingInterval.clear();
          return true; // Signal to stop polling
        }
        return false; // Continue polling
      } catch {
        return false; // Continue polling
      } finally {
        // Reset flag so next polling tick can run
        isPollingInProgressRef.current = false;
      }
    };
    
    // Enforce overall timeout (60s) to reset with an error
    oauthPollingTimeout.set(() => {
      dispatchToolAuthEvent({
        type: 'POLL_TIMEOUT',
        tool: activeAuthTool,
        error: 'Timed out waiting for authentication — try again.',
      });
      dispatchToolAuthEvent({
        type: 'FIELD_PATCHED',
        tool: activeAuthTool,
        patch: { authUrl: null },
      });
      setActiveAuthTool(null);
      oauthPollingTimer.clear();
      oauthPollingInterval.clear();
      oauthPollingTimeout.clear();
      isPollingInProgressRef.current = false;
    }, 60000);

    // First poll after 5 seconds (give user a short window to finish OAuth)
    oauthPollingTimer.set(() => {
      void (async () => {
        const shouldStop = await performPoll();
        if (shouldStop) {
          oauthPollingTimeout.clear();
          return;
        }
        
        // Start interval polling every 5 seconds after first poll
        oauthPollingInterval.set(() => {
          void performPoll();
        }, 5000);
      })();
    }, 5000);
    
    // Cleanup on unmount or when dependencies change
    return () => {
      isPollingInProgressRef.current = false;
      oauthPollingTimer.clear();
      oauthPollingInterval.clear();
      oauthPollingTimeout.clear();
    };
  }, [isOpen, activeStep, activeAuthTool, toolAuthStates, companyName, oauthPollingTimer, oauthPollingInterval, oauthPollingTimeout]);

  // Skip a specific tool (for optional tools only)
  const skipTool = useCallback((tool: ToolType) => {
    const toolState = toolAuthStates.find((t) => t.tool === tool);
    if (!toolState || toolState.required) {
      return;
    }
    
    setSkippedTools((prev) => new Set([...prev, tool]));
  }, [toolAuthStates]);

  // Use cases are ready when generation succeeded (or in dev mode)
  const useCasesReady = useMemo(() => {
    if (isDevMode) return true;
    return useCaseGenerationStatus === 'success' && generatedUseCases.length > 0;
  }, [useCaseGenerationStatus, generatedUseCases.length, isDevMode]);

  const canProceed = useMemo(() => {
    switch (activeStep) {
      case 'googleDrive':
        return googleDriveReady;
      case 'api':
        // Allow proceeding without workspaceReady when coreDirectory is not yet set.
        // On Windows with Controlled Folder Access, the default workspace may be blocked,
        // so coreDirectory stays null until the user picks a folder via the library pre-confirmation.
        // When coreDirectory IS set, still require full workspaceReady validation (FOX-2873).
        return (workspaceReady || !draftSettings?.coreDirectory) && eulaAccepted && claudeReady;
      case 'voiceSetup':
        return true;
      case 'toolAuth':
        return toolAuthReady;
      default:
        return true;
    }
  }, [activeStep, workspaceReady, draftSettings?.coreDirectory, eulaAccepted, googleDriveReady, claudeReady, toolAuthReady]);

  // Navigation actions
  const goNext = useCallback(async () => {
    if (!canProceed) {
      setTriedContinue(true);
      return;
    }

    const durationOnStepMs = Date.now() - stepStartTimeRef.current;
    if (isTrackedOnboardingStep(activeStep)) {
      tracking.onboarding.stepCompleted(activeStep, durationOnStepMs, false);
    }

    setTriedContinue(false);
    setStepIndex((prev) => Math.min(prev + 1, totalSteps - 1));
  }, [activeStep, canProceed, totalSteps]);

  const goBack = useCallback(() => {
    setTriedContinue(false);
    setStepIndex((prev) => Math.max(prev - 1, 0));
  }, []);

  const startMigrationImportBranch = useCallback(() => {
    setTriedContinue(false);
    setMigrationImportBranchActive(true);
    setStepIndex(1);
  }, []);

  const startStandardSetupBranch = useCallback(() => {
    setMigrationImportBranchActive(false);
  }, []);

  // Tool Auth actions
  // M3: field-only. `status` is omitted from `ToolAuthFieldPatch` by construction,
  // so a status change cannot even be expressed here — it is a compile error at the
  // call site. Status transitions go exclusively through the named actions below.
  const updateToolAuthState = useCallback((tool: ToolType, updates: ToolAuthFieldPatch) => {
    const current = toolAuthStatesRef.current.find((state) => state.tool === tool);
    if (!current) {
      return;
    }

    if (Object.keys(updates).length > 0) {
      dispatchToolAuthEvent({
        type: 'FIELD_PATCHED',
        tool,
        patch: updates,
      } satisfies ToolAuthEvent);
    }
  }, []);

  // TEST-ONLY status driver — see the action-contract doc. Routes through the same
  // guarded `PATCH_STATUS` event the reducer validates, so it can never reach an
  // illegal status. Not for production use.
  const setToolAuthStatusForTest = useCallback(
    (tool: ToolType, status: ToolAuthStatus, fields: ToolAuthFieldPatch = {}) => {
      const current = toolAuthStatesRef.current.find((state) => state.tool === tool);
      if (!current) {
        return;
      }
      dispatchToolAuthEvent({
        type: 'PATCH_STATUS',
        tool,
        status,
        fields,
      } satisfies ToolAuthEvent);
    },
    [],
  );

  const clearToolAuthError = useCallback((tool: ToolType) => {
    dispatchToolAuthEvent({ type: 'ERROR_CLEARED', tool });
  }, []);

  const observeCatalogConnection = useCallback((tool: ToolType) => {
    dispatchToolAuthEvent({ type: 'CATALOG_CONNECTION_OBSERVED', tool });
  }, []);

  const markToolAuthConnected = useCallback((tool: ToolType) => {
    dispatchToolAuthEvent({ type: 'LOCAL_OAUTH_CONNECTED', tools: [tool] });
  }, []);

  const disconnectToolAuth = useCallback((tool: ToolType) => {
    dispatchToolAuthEvent({ type: 'DISCONNECTED', tool });
    dispatchToolAuthEvent({
      type: 'FIELD_PATCHED',
      tool,
      patch: { error: null, awaitingSince: null },
    });
  }, []);

  const generateAuthLink = useCallback(async (tool: ToolType, options?: { autoStart?: boolean }) => {
    
    const toolState = toolAuthStates.find((t) => t.tool === tool);
    if (!toolState) {
      return;
    }

    // Use local Google Workspace OAuth for Gmail and Google Calendar
    // Note: Now always enabled since Klavis integration was removed
    if (tool === 'gmail' || tool === 'google-calendar') {
      setActiveAuthTool(tool);
      dispatchToolAuthEvent({ type: 'GENERATE_REQUESTED', tool });
      setIsGeneratingAuthLinks(true);
      try {
        const result = await window.googleWorkspaceApi.startAuth();
        if (result.success) {
          dispatchToolAuthEvent({
            type: 'LOCAL_OAUTH_CONNECTED',
            tools: ['gmail', 'google-calendar'],
          });
          tracking.onboarding.toolAuthLinkGenerated(TOOL_TO_TRACKING_CATEGORY[tool]);
          tracking.onboarding.toolAuthVerified(TOOL_TO_TRACKING_CATEGORY[tool], true);
        } else {
          // Broken-by-default (no OAuth client credentials): open the shared setup dialog instead
          // of surfacing the credentials-not-configured guidance as a generic GENERATE_FAILED.
          if (!setupGuidanceDialog.handleResult(result)) {
            dispatchToolAuthEvent({
              type: 'GENERATE_FAILED',
              tool,
              error: result.error ?? 'Google OAuth failed',
            });
          }
          tracking.onboarding.toolAuthError(TOOL_TO_TRACKING_CATEGORY[tool], result.error ?? 'OAuth failed');
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Google OAuth failed';
        dispatchToolAuthEvent({ type: 'GENERATE_FAILED', tool, error: errorMsg });
        tracking.onboarding.toolAuthError(TOOL_TO_TRACKING_CATEGORY[tool], errorMsg);
      } finally {
        setIsGeneratingAuthLinks(false);
      }
      return;
    }

    // Use local Slack OAuth (privacy-first)
    // Includes polling fallback to detect auth completion when deep link callback is missed
    // (same pattern as Microsoft - Slack uses mindstone://slack/callback deep link)
    if (tool === 'slack') {
      setActiveAuthTool(tool);
      dispatchToolAuthEvent({ type: 'GENERATE_REQUESTED', tool });
      setIsGeneratingAuthLinks(true);
      
      // Abort any previous polling
      slackPollingAbortRef.current?.abort();
      slackPollingAbortRef.current = new AbortController();
      
      try {
        // Race between normal OAuth flow and polling fallback
        // Polling checks every 10s if workspaces exist (for when deep link callback is missed)
        const POLLING_INTERVAL_MS = 10_000;
        
        const authPromise = window.slackApi.startAuth()
          .then(r => ({ ...r, polled: false as const }))
          .catch(err => ({
            success: false as const,
            teamName: undefined as string | undefined,
            error: err instanceof Error ? err.message : 'Slack OAuth failed',
            // A thrown error carries no structured guidance; declare it so the race-union stays a
            // shape `handleResult` (MaybeSetupGuidanceResult) accepts without the weak-type error.
            setupGuidance: undefined as MaybeSetupGuidanceResult['setupGuidance'],
            polled: false as const,
          }));
        
        const pollingPromise = pollForSlackAuth(
          POLLING_INTERVAL_MS,
          slackPollingAbortRef.current.signal
        ).then(r => ({
          success: true as const,
          teamName: r.teamName,
          error: undefined as string | undefined,
          polled: true as const,
        })).catch(() => null); // Polling abort shouldn't reject the race
        
        const result = await Promise.race([authPromise, pollingPromise]);
        
        // Abort polling if auth promise won (cleanup)
        slackPollingAbortRef.current?.abort();
        
        if (result && result.success) {
          dispatchToolAuthEvent({ type: 'LOCAL_OAUTH_CONNECTED', tools: ['slack'] });
          tracking.onboarding.toolAuthLinkGenerated(TOOL_TO_TRACKING_CATEGORY[tool]);
          tracking.onboarding.toolAuthVerified(TOOL_TO_TRACKING_CATEGORY[tool], true);
        } else if (result && !result.success) {
          // Broken-by-default (no OAuth client credentials): open the shared setup dialog instead
          // of surfacing the credentials-not-configured guidance as a generic GENERATE_FAILED.
          if (!setupGuidanceDialog.handleResult(result)) {
            dispatchToolAuthEvent({
              type: 'GENERATE_FAILED',
              tool,
              error: result.error ?? 'Slack OAuth failed',
            });
          }
          tracking.onboarding.toolAuthError(TOOL_TO_TRACKING_CATEGORY[tool], result.error ?? 'OAuth failed');
        }
        // If result is null (polling aborted early), the auth promise will still resolve/reject
      } catch (error) {
        slackPollingAbortRef.current?.abort();
        const errorMsg = error instanceof Error ? error.message : 'Slack OAuth failed';
        dispatchToolAuthEvent({ type: 'GENERATE_FAILED', tool, error: errorMsg });
        tracking.onboarding.toolAuthError(TOOL_TO_TRACKING_CATEGORY[tool], errorMsg);
      } finally {
        setIsGeneratingAuthLinks(false);
      }
      return;
    }

    // Use local Microsoft OAuth for Outlook Mail, Outlook Calendar, and Teams
    // Single OAuth flow grants all Microsoft 365 permissions (Mail, Calendar, Files, Teams)
    // Includes polling fallback to detect auth completion when deep link callback is missed
    if (tool === 'outlook-mail' || tool === 'outlook-calendar' || tool === 'teams') {
      setActiveAuthTool(tool);
      dispatchToolAuthEvent({ type: 'GENERATE_REQUESTED', tool });
      setIsGeneratingAuthLinks(true);
      
      // Abort any previous polling
      microsoftPollingAbortRef.current?.abort();
      microsoftPollingAbortRef.current = new AbortController();
      
      try {
        // Race between normal OAuth flow and polling fallback
        // Polling checks every 10s if tokens exist (for when deep link callback is missed)
        // The 10s interval is a balance: fast enough to feel responsive, slow enough to be polite
        const POLLING_INTERVAL_MS = 10_000;
        
        const authPromise = window.microsoftApi.startAuth()
          .then(r => ({ ...r, polled: false as const }))
          .catch(err => ({
            success: false as const,
            email: undefined as string | undefined,
            error: err instanceof Error ? err.message : 'Microsoft OAuth failed',
            // A thrown error carries no structured guidance; declare it so the race-union stays a
            // shape `handleResult` (MaybeSetupGuidanceResult) accepts without the weak-type error.
            setupGuidance: undefined as MaybeSetupGuidanceResult['setupGuidance'],
            polled: false as const,
          }));
        
        const pollingPromise = pollForMicrosoftAuth(
          POLLING_INTERVAL_MS,
          microsoftPollingAbortRef.current.signal
        ).then(() => ({
          success: true as const,
          email: undefined as string | undefined,
          error: undefined as string | undefined,
          polled: true as const,
        })).catch(() => null); // Polling abort shouldn't reject the race
        
        const result = await Promise.race([authPromise, pollingPromise]);
        
        // Abort polling if auth promise won (cleanup)
        microsoftPollingAbortRef.current?.abort();
        
        if (result && result.success) {
          // Mark all Microsoft tools as connected (they share the same token)
          dispatchToolAuthEvent({
            type: 'LOCAL_OAUTH_CONNECTED',
            tools: ['outlook-mail', 'outlook-calendar', 'teams'],
          });
          tracking.onboarding.toolAuthLinkGenerated(TOOL_TO_TRACKING_CATEGORY[tool]);
          tracking.onboarding.toolAuthVerified(TOOL_TO_TRACKING_CATEGORY[tool], true);
        } else if (result && !result.success) {
          // Broken-by-default (no OAuth client credentials): open the shared setup dialog instead
          // of surfacing the credentials-not-configured guidance as a generic GENERATE_FAILED.
          if (!setupGuidanceDialog.handleResult(result)) {
            dispatchToolAuthEvent({
              type: 'GENERATE_FAILED',
              tool,
              error: result.error ?? 'Microsoft OAuth failed',
            });
          }
          tracking.onboarding.toolAuthError(TOOL_TO_TRACKING_CATEGORY[tool], result.error ?? 'OAuth failed');
        }
        // If result is null (polling aborted early), the auth promise will still resolve/reject
      } catch (error) {
        microsoftPollingAbortRef.current?.abort();
        const errorMsg = error instanceof Error ? error.message : 'Microsoft OAuth failed';
        dispatchToolAuthEvent({ type: 'GENERATE_FAILED', tool, error: errorMsg });
        tracking.onboarding.toolAuthError(TOOL_TO_TRACKING_CATEGORY[tool], errorMsg);
      } finally {
        setIsGeneratingAuthLinks(false);
      }
      return;
    }

    // Prevent starting auth for an alternate provider in the same category if one is already in-progress or connected
    const category = TOOL_CATEGORY[tool];
    const blockingInCategory = toolAuthStatesRef.current.find((t) => {
      if (TOOL_CATEGORY[t.tool] !== category) return false;
      if (t.tool === tool) return false;
      // Treat generating/awaiting_auth/verifying/connected as in-flight blockers.
      // Allow switching away from ready_to_connect (UI clears that provider first) so users can pick another provider.
      return isInFlight(t.status) || isConnectedStatus(t.status);
    });
    if (blockingInCategory) {
      return;
    }
    
    // Check if tool is already connected (background verify might have succeeded)
    const currentState = toolAuthStatesRef.current.find(t => t.tool === tool);
    if (currentState && isConnectedStatus(currentState.status)) {
      return;
    }

    
    // Set this tool as the active auth tool (for polling and tracking)
    setActiveAuthTool(tool);
    dispatchToolAuthEvent({ type: 'GENERATE_REQUESTED', tool });
    setIsGeneratingAuthLinks(true);

    let lastError: string | null = null;
    let lastAuthUrlResponse: unknown = null;
    const maxAttempts = 2; // Original + 1 retry

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const result = await window.miscApi.getToolAuthUrl({ tool, serverName: toolState.serverName, companyName: companyName || undefined });
        lastAuthUrlResponse = result;

        if (result.success && result.authUrl) {
          // Check if tool state changed while we were generating (e.g., background verify marked it connected)
          const stateAfterGenerate = toolAuthStatesRef.current.find(t => t.tool === tool);
          if (!stateAfterGenerate || !isGeneratingStatus(stateAfterGenerate.status)) {
            setIsGeneratingAuthLinks(false);
            return;
          }

          if (options?.autoStart) {
            dispatchToolAuthEvent(
              toolAuthEventFromAuthUrlResponse(tool, result, {
                autoStart: true,
                awaitingSince: Date.now(),
              }),
            );
            void window.appApi.openUrl(result.authUrl);
            tracking.onboarding.toolAuthLinkGenerated(TOOL_TO_TRACKING_CATEGORY[tool]);
            setIsGeneratingAuthLinks(false);
            return;
          }

          dispatchToolAuthEvent(toolAuthEventFromAuthUrlResponse(tool, result));
          tracking.onboarding.toolAuthLinkGenerated(TOOL_TO_TRACKING_CATEGORY[tool]);
          setIsGeneratingAuthLinks(false);
          return;
        }
        
        lastError = result.error ?? 'Failed to generate auth link';
        
        // Don't retry non-transient errors
        if (!isTransientError(lastError)) {
          break;
        }
        
        // Brief delay before retry
        if (attempt < maxAttempts - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Failed to generate auth link';
        
        if (!isTransientError(lastError)) {
          break;
        }
        
        if (attempt < maxAttempts - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
    
    // All attempts failed - use friendly error message
    const friendlyError = friendlyErrorMessage(lastError);
    dispatchToolAuthEvent(
      toolAuthEventFromAuthUrlResponse(
        tool,
        lastAuthUrlResponse ?? { success: false, error: friendlyError },
        { fallbackError: friendlyError },
      ),
    );
    tracking.onboarding.toolAuthError(TOOL_TO_TRACKING_CATEGORY[tool], lastError || 'Unknown error');
    setIsGeneratingAuthLinks(false);
  }, [toolAuthStates, companyName, setupGuidanceDialog]);

  /**
   * Start the OAuth flow for a tool - opens the auth URL and starts polling.
   * Called when user clicks the "Connect" button.
   */
  const startOAuthFlow = useCallback((tool: ToolType) => {
    const toolState = toolAuthStates.find((t) => t.tool === tool);
    if (!toolState || !toolState.authUrl) {
      return;
    }
    
    
    // Open the OAuth URL in browser
    void window.appApi.openUrl(toolState.authUrl);
    
    // Transition to awaiting_auth - this triggers polling
    setActiveAuthTool(tool);
    dispatchToolAuthEvent({
      type: 'USER_CLICKED_CONNECT',
      tool,
      authUrl: toolState.authUrl,
      awaitingSince: Date.now(),
    });
  }, [toolAuthStates]);

  const verifyToolAuth = useCallback(async (tool: ToolType) => {
    const toolState = toolAuthStates.find((t) => t.tool === tool);
    if (!toolState) return false;

    dispatchToolAuthEvent({ type: 'VERIFY_REQUESTED', tool });
    setIsVerifyingAuth(true);

    let lastError: string | null = null;
    let lastVerifyResponse: unknown = null;
    const maxAttempts = 2; // Original + 1 retry
    
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        
        const result = await window.miscApi.verifyToolAuth({ tool, serverName: toolState.serverName, companyName: companyName || undefined });
        lastVerifyResponse = result;
        
        if (result.success) {
          const event = toolAuthEventFromVerifyResponse(tool, result, {
            source: 'verify' satisfies VerifyResponseSource,
          });
          dispatchToolAuthEvent(event);

          if (result.isAuthenticated) {
            tracking.onboarding.toolAuthVerified(TOOL_TO_TRACKING_CATEGORY[tool], true);
            setIsVerifyingAuth(false);
            return true;
          } else {
            setIsVerifyingAuth(false);
            return false;
          }
        }
        
        lastError = result.error ?? 'Failed to verify authentication';
        
        if (!isTransientError(lastError)) break;
        
        if (attempt < maxAttempts - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Failed to verify authentication';
        
        if (!isTransientError(lastError)) break;
        
        if (attempt < maxAttempts - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
    
    // All attempts failed - use friendly error message
    const friendlyError = friendlyErrorMessage(lastError);
    dispatchToolAuthEvent(
      toolAuthEventFromVerifyResponse(
        tool,
        lastVerifyResponse ?? { success: false, error: friendlyError },
        { source: 'verify', fallbackError: friendlyError },
      ),
    );
    tracking.onboarding.toolAuthError(TOOL_TO_TRACKING_CATEGORY[tool], lastError || 'Unknown error');
    setIsVerifyingAuth(false);
    return false;
  }, [toolAuthStates, companyName]);

  // Use case generation action
  const startUseCaseGeneration = useCallback(async () => {
    if (useCaseGenerationStatus === 'generating') return;
    
    setUseCaseGenerationStatus('generating');
    setUseCaseGenerationError(null);
    
    try {
      const result = await window.dashboardApi.generateUseCases();
      
      if (result.success && result.useCases && result.useCases.length > 0) {
        setGeneratedUseCases(result.useCases);
        setUseCaseGenerationStatus('success');
      } else {
        const errorMsg = result.error ?? 'No use cases were generated';
        setUseCaseGenerationError(errorMsg);
        setUseCaseGenerationStatus('error');
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to generate use cases';
      setUseCaseGenerationError(errorMsg);
      setUseCaseGenerationStatus('error');
      console.error('[useOnboardingFlow] Use case generation error:', error);
    }
  }, [useCaseGenerationStatus]);

  const retryUseCaseGeneration = useCallback(async () => {
    setUseCaseGenerationStatus('idle');
    setUseCaseGenerationError(null);
    setGeneratedUseCases([]);
    await startUseCaseGeneration();
  }, [startUseCaseGeneration]);

  // Reset use case generation state when onboarding opens (always regenerate)
  useEffect(() => {
    if (isOpen) {
      setUseCaseGenerationStatus('idle');
      setUseCaseGenerationError(null);
      setGeneratedUseCases([]);
      useCaseGenerationInitiatedRef.current = false;
    }
  }, [isOpen]);

  // NOTE: Auto-start use case generation has been moved to App.tsx level
  // This ensures the IPC call survives OnboardingWizard unmount.
  // App.tsx receives the `onFinalSetupStepEntered` callback from OnboardingWizard
  // and starts generation there. The hook's startUseCaseGeneration is kept as
  // a fallback for manual retry but is no longer auto-invoked.

  const resolveOnboardingOrganisationName = useCallback(() => {
    return (draftSettings?.companyName?.trim() || companyName.trim()) || null;
  }, [companyName, draftSettings?.companyName]);

  const seedFirstWorkSpaceOrganisationName = useCallback(async () => {
    const companyNameForSeed = resolveOnboardingOrganisationName();
    if (!companyNameForSeed) return;

    const firstWorkSpace = connectedSpaces.find(space => space.type !== 'chief-of-staff' && space.type !== 'personal');
    if (!firstWorkSpace) return;

    const recordFailure = (error: unknown) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      recordRendererBreadcrumb({
        category: 'onboarding.organisation-seed',
        level: 'error',
        message: 'Onboarding: failed to seed organisation_name on first work space',
        data: {
          companyName: companyNameForSeed,
          spacePath: firstWorkSpace.path,
          error: errorMessage,
        },
      });
      console.error('Onboarding: failed to seed organisation_name on first work space', {
        companyName: companyNameForSeed,
        spacePath: firstWorkSpace.path,
        error,
      });
      showToast({
        title: ONBOARDING_ORGANISATION_SEED_FAILURE_TOAST,
        variant: 'warning',
        duration: 8000,
      });
    };

    try {
      const result = await window.libraryApi.updateSpaceFrontmatter({
        spacePath: firstWorkSpace.path,
        updates: {
          organisation_name: companyNameForSeed,
        },
      });
      if (!result.success) {
        recordFailure(new Error(result.error ?? 'Unknown frontmatter write failure'));
      } else if (draftSettings?.coreDirectory) {
        invalidateSpaces(draftSettings.coreDirectory);
      }
    } catch (error) {
      recordFailure(error);
    }
  }, [connectedSpaces, draftSettings?.coreDirectory, resolveOnboardingOrganisationName, showToast]);

  const completeOnboardingWithOrganisationSeed = useCallback(async (options?: { skipAudioIntro?: boolean }) => {
    // Seed README frontmatter BEFORE completing onboarding so the wizard does
    // not close (and the app does not switch to the main view) until the
    // organisation_name write has landed. Reversing this caused a race where
    // waitForMainAppReady returned before the frontmatter IPC resolved.
    await seedFirstWorkSpaceOrganisationName();
    await completeOnboarding(options);
  }, [completeOnboarding, seedFirstWorkSpaceOrganisationName]);

  const handleFinish = useCallback(async () => {
    if (isCompleting) return;
    setIsCompleting(true);
    setCompletionError(null);

    try {
      const durationOnStepMs = Date.now() - stepStartTimeRef.current;
      if (isTrackedOnboardingStep(activeStep)) {
        tracking.onboarding.stepCompleted(activeStep, durationOnStepMs, false);
      }
      
      const totalDurationMs = Date.now() - onboardingStartTime;
      tracking.onboarding.completed(totalDurationMs, stepSequence.filter(isTrackedOnboardingStep));
      tracking.onboarding.stageCompleted('wizard', totalDurationMs / 1000);

      await completeOnboardingWithOrganisationSeed();
    } catch (error) {
      if (error instanceof Error && error.name === 'WorkspaceValidationError') {
        const apiStepIndex = stepSequence.indexOf('api');
        if (apiStepIndex >= 0) {
          setStepIndex(apiStepIndex);
        }
      }
      setCompletionError(
        error instanceof Error ? error.message : 'Failed to finish onboarding.'
      );
    } finally {
      setIsCompleting(false);
    }
  }, [completeOnboardingWithOrganisationSeed, isCompleting, activeStep, onboardingStartTime, stepSequence]);

  // Notify parent when user name is fetched
  useEffect(() => {
    if (userFirstName && onUserNameFetched) {
      onUserNameFetched(userFirstName);
    }
  }, [userFirstName, onUserNameFetched]);

  // Connected Spaces actions (unified - replaces legacy Google Drive symlink actions)
  
  /**
   * Add a space to the connected spaces list.
   * Called when AddSpaceWizard completes successfully.
   */
  const addConnectedSpace = useCallback((space: SpaceInfo) => {
    setConnectedSpaces((prev) => {
      // Don't add duplicates (by path)
      if (prev.some((s) => s.path === space.path)) {
        return prev;
      }
      return [...prev, space];
    });
    setGoogleDriveError(null);
  }, []);

  /**
   * Remove a space from the connected spaces list by path.
   * Note: This only removes from the onboarding display, not from the actual workspace.
   * The actual removal is handled by the AddSpaceWizard or Settings.
   */
  const removeConnectedSpace = useCallback((path: string) => {
    setConnectedSpaces((prev) => prev.filter((s) => s.path !== path));
  }, []);

  /**
   * Refresh connected spaces from workspace scan.
   * Called after creating or removing a space to sync state.
   */
  const refreshConnectedSpaces = useCallback(async () => {
    if (!draftSettings?.coreDirectory) {
      setConnectedSpaces([]);
      return;
    }

    try {
      const userSpaces = await getUserSpacesFromSharedCache(draftSettings.coreDirectory);
      setConnectedSpaces(userSpaces);
    } catch (error) {
      ignoreBestEffortCleanup(error, {
        operation: 'useOnboardingFlow.refreshConnectedSpaces',
        reason: 'Best-effort refresh — keep existing connected spaces on failure',
      });
    }
  }, [draftSettings?.coreDirectory]);

  return {
    state: {
      stepIndex,
      activeStep,
      totalSteps,
      canProceed,
      triedContinue,
      stepSequence,
      // API key validation state
      apiKeyValidationStatus,
      canSkipApiStep,
      microphoneStatus,
      isCompleting,
      completionError,
      // Tool Auth skip state
      canSkipToolAuth,
      // Tool Auth state
      toolAuthStates,
      isGeneratingAuthLinks,
      isVerifyingAuth,
      toolAuthReady,
      activeAuthTool,
      // User info
      userFirstName,
      fetchingUserName,
      workspaceReady,
      workspaceValidation,
      claudeReady,
      voiceReady,
      voiceProvider,
      // Google Drive / Spaces state
      googleDriveInstalled,
      companyName,
      googleDriveError,
      googleDriveReady,
      connectedSpaces,
      // Org config onboarding streamlining
      orgCompanyDisplayName,
      orgHasSpaces,
      orgSharedDriveProvider,
      // OneDrive state
      oneDriveInstalled,
      oneDriveConfigured,
      // Use case generation state
      useCaseGenerationStatus,
      useCaseGenerationError,
      generatedUseCases,
      useCasesReady,
      // EULA acceptance
      eulaAccepted,
      // Connector setup guidance (broken-by-default OAuth)
      setupGuidance: setupGuidanceDialog,
    },
    actions: {
      setStepIndex,
      goNext,
      goBack,
      completeOnboardingWithOrganisationSeed,
      setMicrophoneStatus,
      setIsCompleting,
      setCompletionError,
      // Tool Auth actions
      updateToolAuthState,
      setToolAuthStatusForTest,
      clearToolAuthError,
      observeCatalogConnection,
      markToolAuthConnected,
      disconnectToolAuth,
      generateAuthLink,
      startOAuthFlow,
      verifyToolAuth,
      skipTool,
      // User info actions
      setUserFirstName,
      setFetchingUserName,
      handleFinish,
      // Google Drive / Spaces actions
      setGoogleDriveInstalled,
      setCompanyName,
      setGoogleDriveError,
      addConnectedSpace,
      removeConnectedSpace,
      refreshConnectedSpaces,
      // Use case generation actions
      startUseCaseGeneration,
      retryUseCaseGeneration,
      // EULA acceptance actions
      setEulaAccepted,
      startMigrationImportBranch,
      startStandardSetupBranch,
    }
  };
};

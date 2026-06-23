import { useCallback, useEffect, useMemo, useState } from 'react';
import { useVisibilityAwareInterval } from '@renderer/hooks/useVisibilityAwareInterval';
import { useSpacesData } from '@renderer/hooks/useSpacesData';
import {
  Button,
  DecisionCardGroup,
  Input,
  MaturityBadge,
  Notice,
} from '@renderer/components/ui';
import {
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Loader2,
  MessageCircleQuestion,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import type { RebelAvatarId, MeetingBotSettings } from '@shared/types';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import styles from '../SettingsSurface.module.css';
import { SettingRow } from '../SettingRow';
import { SettingSection } from '../SettingSection';
import type { MeetingsTabProps } from './types';
import { VoiceRecordersSection } from './VoiceRecordersSection';
import { LocalRecordingTriggerToggle } from '../LocalRecordingTriggerToggle';
import { RecorderInstallDialog } from './RecorderInstallDialog';
import {
  shouldShowRecorderInstallAffordance,
  type RecorderInstallationStatus,
} from './recorderInstallState';

/** Teams URL permission status */
interface TeamsUrlPermissionStatus {
  required: boolean;
  granted: boolean;
  platform: string;
}

/** R2 bucket URL for avatar images */
const AVATAR_BASE_URL = 'https://pub-15a8bb8fa4a2468086761a85641af2c8.r2.dev/rebel-avatars';

/** Avatar options with display names */
const AVATAR_OPTIONS: { id: RebelAvatarId; name: string }[] = [
  { id: 'dash', name: 'Dash' },
  { id: 'glitch', name: 'Glitch' },
  { id: 'rogue', name: 'Rogue' },
  { id: 'scout', name: 'Scout' },
  { id: 'spark', name: 'Spark' },
];

/** External provider options */
const EXTERNAL_PROVIDERS = [
  { id: 'fireflies', name: 'Fireflies', url: 'https://fireflies.ai' },
  { id: 'fathom', name: 'Fathom', url: 'https://fathom.video' },
] as const;

const RECALL_API_KEY_URL = 'https://us-west-2.recall.ai/dashboard/developers/api-keys';

type ExternalProvider = (typeof EXTERNAL_PROVIDERS)[number]['id'];

export const MeetingsTab = ({
  draftSettings,
  updateDraft,
}: MeetingsTabProps) => {
  const meetingBot = useMemo(() => draftSettings.meetingBot ?? {}, [draftSettings.meetingBot]);
  const selectedAvatar = meetingBot.rebelAvatar ?? 'spark';

  // Load available spaces for transcript routing from the shared Spaces cache.
  const { spaces } = useSpacesData(draftSettings.coreDirectory);

  // Find default spaces for transcript routing
  const chiefOfStaffSpace = spaces.find(s => s.type === 'chief-of-staff');
  const defaultGroupSpace = spaces.find(s => s.type === 'team' || s.type === 'company') ?? chiefOfStaffSpace;
  const defaultOneOnOneName = chiefOfStaffSpace?.displayName || 'Private Space';
  const defaultGroupName = defaultGroupSpace?.displayName || defaultGroupSpace?.name || defaultOneOnOneName;

  const updateMeetingBot = useCallback((updates: Partial<MeetingBotSettings>) => {
    updateDraft('meetingBot', { ...meetingBot, ...updates });
  }, [meetingBot, updateDraft]);

  // Persist default space paths when spaces are loaded and settings are empty
  // This ensures the backend has explicit paths rather than relying on scanSpaces() fallback
  useEffect(() => {
    if (spaces.length === 0) return;
    
    const updates: Partial<MeetingBotSettings> = {};
    
    // If 1:1 space is not set but we have a Chief of Staff, persist it
    if (!meetingBot.oneOnOneSpaceId && chiefOfStaffSpace) {
      updates.oneOnOneSpaceId = chiefOfStaffSpace.path;
    }
    
    // If group space is not set but we have a default, persist it
    if (!meetingBot.groupMeetingSpaceId && defaultGroupSpace) {
      updates.groupMeetingSpaceId = defaultGroupSpace.path;
    }
    
    if (Object.keys(updates).length > 0) {
      updateMeetingBot(updates);
    }
  }, [spaces, chiefOfStaffSpace, defaultGroupSpace, meetingBot.oneOnOneSpaceId, meetingBot.groupMeetingSpaceId, updateMeetingBot]);

  // External provider state
  const [selectedProvider, setSelectedProvider] = useState<ExternalProvider | ''>(() => {
    if (meetingBot.firefliesApiKey) return 'fireflies';
    if (meetingBot.fathomApiKey) return 'fathom';
    return '';
  });
  const [apiKey, setApiKey] = useState(() => {
    if (meetingBot.firefliesApiKey) return meetingBot.firefliesApiKey;
    if (meetingBot.fathomApiKey) return meetingBot.fathomApiKey;
    return '';
  });
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionResult, setConnectionResult] = useState<{ success: boolean; message?: string } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ success: boolean; message?: string } | null>(null);
  const [recallApiKey, setRecallApiKey] = useState(() => meetingBot.recallApiKey ?? '');
  const [testingRecallConnection, setTestingRecallConnection] = useState(false);
  const [recallConnectionResult, setRecallConnectionResult] = useState<{ success: boolean; message?: string } | null>(null);
  const [recorderInstallationStatus, setRecorderInstallationStatus] = useState<RecorderInstallationStatus | null>(null);
  const [recorderInstallDialogOpen, setRecorderInstallDialogOpen] = useState(false);

  // Teams URL permission state (macOS Full Disk Access)
  const [teamsUrlPermission, setTeamsUrlPermission] = useState<TeamsUrlPermissionStatus | null>(null);
  const [teamsPermissionDismissed, setTeamsPermissionDismissed] = useState(false);
  const [requestingTeamsPermission, setRequestingTeamsPermission] = useState(false);

  // Check Teams URL permission on mount and periodically (until granted)
  // Uses visibility-aware interval: pauses when tab is hidden (permission checking is UI-only)
  useVisibilityAwareInterval(
    async () => {
      // Stop polling once permission is granted or banner is dismissed
      if (teamsUrlPermission?.granted || teamsPermissionDismissed) return;

      try {
        const status = await window.meetingBotApi.getTeamsUrlPermissionStatus();
        setTeamsUrlPermission(status);
      } catch {
        // Ignore errors - permission check is optional
      }
    },
    15000, // foreground: 15s
    null,  // background: pause when hidden
    [teamsUrlPermission?.granted, teamsPermissionDismissed]
  );

  const recheckRecorderInstallation = useCallback(async () => {
    try {
      const status = await window.meetingBotApi.isRecorderInstalled();
      setRecorderInstallationStatus(status);
    } catch (error) {
      console.warn('Failed to check meeting recorder installation state', error);
      ignoreBestEffortCleanup(error, {
        operation: 'checkRecorderInstallation',
        reason: 'settings keeps existing recorder controls unless the desktop query explicitly reports absent',
      });
    }
  }, []);

  useEffect(() => {
    void recheckRecorderInstallation();
  }, [recheckRecorderInstallation]);

  const handleRequestTeamsPermission = useCallback(async () => {
    setRequestingTeamsPermission(true);
    try {
      await window.meetingBotApi.requestTeamsUrlPermission();
      // Re-check permission status after request
      const status = await window.meetingBotApi.getTeamsUrlPermissionStatus();
      setTeamsUrlPermission(status);
    } catch {
      // Ignore errors
    } finally {
      setRequestingTeamsPermission(false);
    }
  }, []);

  const handleAvatarSelect = useCallback((avatarId: RebelAvatarId) => {
    updateMeetingBot({ rebelAvatar: avatarId });
  }, [updateMeetingBot]);

  const handleProviderChange = useCallback((providerId: string) => {
    setSelectedProvider(providerId as ExternalProvider | '');
    setApiKey('');
    setConnectionResult(null);
    setSyncResult(null);
    // Clear both API keys when changing provider
    updateMeetingBot({ firefliesApiKey: undefined, fathomApiKey: undefined });
  }, [updateMeetingBot]);

  const handleApiKeyChange = useCallback((value: string) => {
    setApiKey(value);
    setConnectionResult(null);
    setSyncResult(null);
  }, []);

  const handleTestConnection = useCallback(async () => {
    if (!selectedProvider || !apiKey) return;
    setTestingConnection(true);
    setConnectionResult(null);

    try {
      const result = await window.meetingBotApi.testExternalProvider({
        provider: selectedProvider,
        apiKey,
      });

      setConnectionResult({
        success: result.success,
        message: result.success ? result.message : result.error,
      });

      // Save API key on successful connection
      if (result.success) {
        if (selectedProvider === 'fireflies') {
          updateMeetingBot({ firefliesApiKey: apiKey, fathomApiKey: undefined });
        } else if (selectedProvider === 'fathom') {
          updateMeetingBot({ fathomApiKey: apiKey, firefliesApiKey: undefined });
        }
      }
    } catch (error) {
      setConnectionResult({
        success: false,
        message: error instanceof Error ? error.message : 'Connection failed',
      });
    } finally {
      setTestingConnection(false);
    }
  }, [selectedProvider, apiKey, updateMeetingBot]);

  const handleRecallApiKeyChange = useCallback((value: string) => {
    setRecallApiKey(value);
    setRecallConnectionResult(null);
  }, []);

  const handleTestRecallApiKey = useCallback(async () => {
    const trimmedKey = recallApiKey.trim();
    if (!trimmedKey) return;

    setTestingRecallConnection(true);
    setRecallConnectionResult(null);

    try {
      const result = await window.meetingBotApi.testRecallApiKey({
        apiKey: trimmedKey,
      });

      setRecallConnectionResult({
        success: result.success,
        message: result.success ? result.message : result.error,
      });

      if (result.success) {
        updateMeetingBot({ recallApiKey: trimmedKey });
        setRecallApiKey(trimmedKey);
      }
    } catch (error) {
      setRecallConnectionResult({
        success: false,
        message: error instanceof Error
          ? error.message
          : 'Could not reach Recall to check the key. Check your connection and try again. Nothing was saved.',
      });
    } finally {
      setTestingRecallConnection(false);
    }
  }, [recallApiKey, updateMeetingBot]);

  const handleRemoveRecallApiKey = useCallback(() => {
    setRecallApiKey('');
    setRecallConnectionResult(null);
    updateMeetingBot({ recallApiKey: undefined });
  }, [updateMeetingBot]);

  const handleSyncNow = useCallback(async () => {
    setSyncing(true);
    setSyncResult(null);

    try {
      const result = await window.meetingBotApi.syncExternalProvider();
      setSyncResult({
        success: result.success,
        message: result.success ? result.message : result.error,
      });
    } catch (error) {
      setSyncResult({
        success: false,
        message: error instanceof Error ? error.message : 'Sync failed',
      });
    } finally {
      setSyncing(false);
    }
  }, []);

  const hasConfiguredProvider = !!(meetingBot.firefliesApiKey || meetingBot.fathomApiKey);
  const isEnabled = meetingBot.enabled !== false;
  const rawJoinMode = meetingBot.joinMode ?? 'never';
  const joinMode = rawJoinMode === 'ask' ? 'prompt' : rawJoinMode;
  // Bot is "actively joining" only when enabled AND not in 'never' mode
  const isActivelyJoining = isEnabled && rawJoinMode !== 'never';
  const [showAdvanced, setShowAdvanced] = useState(false);
  const selectedAvatarName = AVATAR_OPTIONS.find(a => a.id === selectedAvatar)?.name ?? 'Spark';
  const savedRecallApiKey = meetingBot.recallApiKey?.trim() ?? '';
  const hasSavedRecallApiKey = savedRecallApiKey.length > 0;
  const recallInputMatchesSaved = recallApiKey.trim() === savedRecallApiKey;
  const showRecorderInstallAffordance = isEnabled
    && shouldShowRecorderInstallAffordance(recorderInstallationStatus);
  const showLocalRecorderControls = isEnabled && !showRecorderInstallAffordance;

  // Check if Plaud transcription is available based on provider setup
  const voiceProvider = draftSettings.voice?.provider ?? 'openai-whisper';
  const canTranscribePlaud = (() => {
    if (voiceProvider === 'local-parakeet' || voiceProvider === 'local-moonshine') {
      // Local model availability is checked at runtime by the sync service
      // We assume it's available here since user explicitly selected it
      return true;
    }
    if (voiceProvider === 'elevenlabs-scribe') {
      // ElevenLabs Scribe has 1GB limit - works for Plaud, just needs API key
      return !!draftSettings.voice?.elevenlabsApiKey;
    }
    // OpenAI Whisper - need API key
    return !!draftSettings.voice?.openaiApiKey;
  })();
  const transcriptionBlockedReason = !canTranscribePlaud
    ? voiceProvider === 'elevenlabs-scribe'
      ? 'ElevenLabs API key required. Add it in Settings > Agents.'
      : 'OpenAI API key required. Add it in Settings > Agents.'
    : undefined;

  // Show Teams permission banner when: macOS + FDA required + not granted + not dismissed + actively joining
  const showTeamsPermissionBanner = 
    teamsUrlPermission?.required && 
    !teamsUrlPermission?.granted && 
    !teamsPermissionDismissed && 
    isActivelyJoining;

  return (
    <>
      <RecorderInstallDialog
        open={recorderInstallDialogOpen}
        onOpenChange={setRecorderInstallDialogOpen}
        onInstalled={recheckRecorderInstallation}
      />

      {showTeamsPermissionBanner && (
        <Notice
          tone="warning"
          placement="section"
          role="alert"
          title="Enable Full Disk Access for Teams meetings"
          actions={[
            {
              label: requestingTeamsPermission ? 'Opening...' : 'Open Settings',
              onClick: () => void handleRequestTeamsPermission(),
              disabled: requestingTeamsPermission,
            },
          ]}
          dismissible
          onDismiss={() => setTeamsPermissionDismissed(true)}
        >
          Rebel needs Full Disk Access on this computer to detect Microsoft Teams meeting links.
          Without it, your notetaker may join the wrong meeting or miss Teams calls.
        </Notice>
      )}

      {/* Main Notetaker Section - Avatar-forward design */}
      <SettingSection
        title={isActivelyJoining ? `${selectedAvatarName} is ready` : 'Meeting Notetaker'}
        description={isActivelyJoining ? 'Taking notes in your meetings' : 'Choose a Rebel to take notes for you'}
        badge={<MaturityBadge level="beta" featureName="Meeting Notetaker" />}
        data-section="notetaker"
      >

        {/* Avatar selection as the hero element */}
        <div className={styles.avatarHeroGrid}>
          {AVATAR_OPTIONS.map((avatar) => {
            const isSelected = selectedAvatar === avatar.id;
            return (
              <button
                key={avatar.id}
                type="button"
                className={`${styles.avatarHeroCard} ${isSelected && isEnabled ? styles.avatarHeroSelected : ''} ${!isEnabled ? styles.avatarHeroDisabled : ''}`}
                onClick={() => {
                  handleAvatarSelect(avatar.id);
                  if (!isEnabled) {
                    updateMeetingBot({ enabled: true });
                  }
                }}
              >
                <img
                  src={`${AVATAR_BASE_URL}/${avatar.id}.png`}
                  alt={avatar.name}
                  className={styles.avatarHeroImage}
                />
                <span className={styles.avatarHeroName}>{avatar.name}</span>
                {isSelected && isEnabled && (
                  <span className={styles.avatarHeroCheck}>
                    <Check size={12} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
        
        {/* Trigger phrase customization - only when enabled */}
        {isEnabled && (
          <div className={styles.triggerPhraseSection}>
            <SettingRow
              label="Trigger phrase"
              tooltip="Sets the phrase Rebel listens for. Say “hey [phrase]” to ask a question and “stop [phrase]” to interrupt."
              description={'Say "hey [phrase]" to ask a question, "stop [phrase]" to interrupt. Also the bot\'s name in meetings.'}
              variant="stacked"
              htmlFor="trigger-phrase"
            >
              <div>
                <Input
                  id="trigger-phrase"
                  type="text"
                  value={meetingBot.triggerPhrase ?? ''}
                  onChange={(e) => updateMeetingBot({ triggerPhrase: e.target.value || null })}
                  placeholder={`${draftSettings.userFirstName || 'Your'}'s Rebel`}
                  className={styles.triggerPhraseInput}
                  maxLength={80}
                />
                {!draftSettings.userFirstName?.trim() && (
                  <Notice tone="warning" placement="embedded" density="compact">
                    Your name is not set, so the bot cannot detect your voice. Go to <strong>Account</strong> to set it.
                  </Notice>
                )}
              </div>
            </SettingRow>
          </div>
        )}
        
        {/* Voice/Chat response toggle - only when enabled */}
        {isEnabled && (
          <SettingRow
            label="Speak responses aloud"
            tooltip="When enabled, Rebel answers with voice. When disabled, answers are posted in the meeting chat."
            description={
              (meetingBot.respondViaVoice ?? true)
                ? 'Rebel will speak answers using your TTS voice'
                : 'Rebel will write answers to the meeting chat'
            }
            htmlFor="respond-via-voice"
          >
            <input
              id="respond-via-voice"
              type="checkbox"
              checked={meetingBot.respondViaVoice ?? true}
              onChange={(e) => updateMeetingBot({ respondViaVoice: e.target.checked })}
              className={styles.responseTypeCheckbox}
            />
          </SettingRow>
        )}

        {showRecorderInstallAffordance && (
          <div className={styles.recorderInstallPrompt}>
            <SettingRow
              label="Meeting recorder"
              description="The meeting recorder runs on Recall's software, which isn't installed yet. Rebel can set it up for you in about a minute."
              variant="stacked"
            >
              <Button
                type="button"
                onClick={() => setRecorderInstallDialogOpen(true)}
                data-testid="meeting-recorder-enable-button"
              >
                Set up recorder
              </Button>
            </SettingRow>
          </div>
        )}

        {showLocalRecorderControls && (
          <LocalRecordingTriggerToggle
            meetingBot={meetingBot}
            updateMeetingBot={updateMeetingBot}
          />
        )}

        {isEnabled && (
          <div className={styles.recallAccountSection}>
            <SettingRow
              label="Recall account (optional)"
              description="Connect your own Recall account to record meetings directly. Recordings go to Recall and Recall bills you, pay-as-you-go (about $0.50/hour). Rebel works fine without this."
              variant="stacked"
              htmlFor="recall-api-key"
            >
              <div>
                <div className={styles.providerRow}>
                  <a
                    href={RECALL_API_KEY_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.getKeyLink}
                  >
                    Get a Recall key <ExternalLink size={12} />
                  </a>
                </div>
                <div className={styles.apiKeyRow}>
                  <Input
                    id="recall-api-key"
                    type="password"
                    value={recallApiKey}
                    onChange={(e) => handleRecallApiKeyChange(e.target.value)}
                    placeholder="Recall API key"
                    className={styles.apiKeyInput}
                    disabled={testingRecallConnection}
                    data-testid="recall-api-key-input"
                  />
                  <Button
                    onClick={() => void handleTestRecallApiKey()}
                    disabled={!recallApiKey.trim() || testingRecallConnection || (hasSavedRecallApiKey && recallInputMatchesSaved)}
                    variant="ghost"
                    size="sm"
                    data-testid="recall-api-key-test-button"
                  >
                    {testingRecallConnection
                      ? <Loader2 size={14} className={styles.spinning} />
                      : hasSavedRecallApiKey && recallInputMatchesSaved
                        ? 'Connected'
                        : 'Connect'}
                  </Button>
                  {hasSavedRecallApiKey && (
                    <Button
                      onClick={handleRemoveRecallApiKey}
                      disabled={testingRecallConnection}
                      variant="ghost"
                      size="sm"
                    >
                      Remove
                    </Button>
                  )}
                </div>

                {recallConnectionResult ? (
                  <p className={recallConnectionResult.success ? styles.successMessage : styles.errorMessage}>
                    {recallConnectionResult.message}
                  </p>
                ) : hasSavedRecallApiKey && recallInputMatchesSaved ? (
                  <p className={styles.successMessage}>Connected to your Recall account.</p>
                ) : null}
              </div>
            </SettingRow>
          </div>
        )}
      </SettingSection>

      {/* Join Behavior - Card-based selection */}
      {isEnabled && (
        <SettingSection
          title="Join behavior"
          description="Choose when Rebel should join your meetings."
          data-section="join-behavior"
        >
          <DecisionCardGroup
            aria-label="Meeting join behavior"
            value={joinMode}
            onValueChange={(value) => updateMeetingBot({ joinMode: value })}
            options={[
              {
                id: 'prompt',
                icon: MessageCircleQuestion,
                title: 'Ask me first',
                description: 'Rebel asks before joining each meeting.',
                selectedContent: (
                  <div className={styles.joinModeTimingRow}>
                    <span>Ask</span>
                    <select
                      value={String(meetingBot.promptMinutesBefore ?? 5)}
                      onChange={(e) => updateMeetingBot({ promptMinutesBefore: parseInt(e.target.value, 10), joinMode: 'prompt' })}
                      className={styles.inlineSelectTiny}
                      aria-label="Minutes before meeting to ask"
                    >
                      <option value="2">2</option>
                      <option value="5">5</option>
                      <option value="10">10</option>
                      <option value="15">15</option>
                    </select>
                    <span>min before each meeting</span>
                  </div>
                ),
                footer: 'Prompt before joining',
              },
              {
                id: 'auto',
                icon: Sparkles,
                title: 'Auto-join',
                description: 'Automatically join all meetings with video links',
                footer: 'Joins automatically',
              },
              {
                id: 'never',
                icon: Ban,
                title: "Don't join",
                description: "Don't show meeting detection prompts",
                footer: 'Manual only',
              },
            ]}
          />

          {/* Transcript storage - natural sentence flow (hidden when joinMode is 'never') */}
          {joinMode !== 'never' && (
            <SettingRow label="Transcript storage" variant="stacked">
              <div className={styles.transcriptSentence}>
                <p className={styles.transcriptSentenceText}>
                  Your meeting notes are saved to{' '}
                  <select
                    value={meetingBot.oneOnOneSpaceId ?? ''}
                    onChange={(e) => updateMeetingBot({ oneOnOneSpaceId: e.target.value || undefined })}
                    className={styles.transcriptInlineSelect}
                    disabled={spaces.length === 0}
                    aria-label="Space for 1:1 meeting transcripts"
                  >
                    <option value="">{defaultOneOnOneName}</option>
                    {spaces.filter(s => s.name !== defaultOneOnOneName).map((space) => (
                      <option key={space.path} value={space.path}>
                        {space.name}
                      </option>
                    ))}
                  </select>
                  {' '}for 1:1s, and{' '}
                  <select
                    value={meetingBot.groupMeetingSpaceId ?? ''}
                    onChange={(e) => updateMeetingBot({ groupMeetingSpaceId: e.target.value || undefined })}
                    className={styles.transcriptInlineSelect}
                    disabled={spaces.length === 0}
                    aria-label="Space for group meeting transcripts"
                  >
                    <option value="">{defaultGroupName}</option>
                    {spaces.filter(s => s.name !== defaultGroupName).map((space) => (
                      <option key={space.path} value={space.path}>
                        {space.name}
                      </option>
                    ))}
                  </select>
                  {' '}for group calls.
                </p>
              </div>
            </SettingRow>
          )}
        </SettingSection>
      )}

      {/* Voice Recorders Section (Limitless + Plaud) */}
      <VoiceRecordersSection
        meetingBot={meetingBot}
        updateMeetingBot={updateMeetingBot}
        spaces={spaces}
        defaultOneOnOneName={defaultOneOnOneName}
        chiefOfStaffSpace={chiefOfStaffSpace}
        canTranscribe={canTranscribePlaud}
        transcriptionBlockedReason={transcriptionBlockedReason}
      />

      {/* Advanced Settings - Collapsed, includes import and disable */}
      <SettingSection title="" data-section="advanced">
        <button
          type="button"
          className={styles.advancedToggle}
          onClick={() => setShowAdvanced(!showAdvanced)}
        >
          {showAdvanced ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          <span>More options</span>
        </button>

        {showAdvanced && (
          <div className={styles.advancedContent}>
            {/* Import from other services */}
            <div className={styles.advancedGroup}>
              <label className={styles.advancedLabel}>Import from other services</label>
              <div className={styles.providerRow}>
                <select
                  value={selectedProvider}
                  onChange={(e) => handleProviderChange(e.target.value)}
                  className={styles.inlineSelect}
                >
                  <option value="">None</option>
                  {EXTERNAL_PROVIDERS.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name}
                    </option>
                  ))}
                </select>

                {selectedProvider && !hasConfiguredProvider && (
                  <a
                    href={EXTERNAL_PROVIDERS.find(p => p.id === selectedProvider)?.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.getKeyLink}
                  >
                    Get API key <ExternalLink size={12} />
                  </a>
                )}
              </div>

              {selectedProvider && (
                <div className={styles.apiKeyRow}>
                  <Input
                    type="password"
                    value={apiKey}
                    onChange={(e) => handleApiKeyChange(e.target.value)}
                    placeholder="API key"
                    className={styles.apiKeyInput}
                  />
                  <Button
                    onClick={() => void handleTestConnection()}
                    disabled={!apiKey || testingConnection}
                    variant="ghost"
                    size="sm"
                  >
                    {testingConnection ? <Loader2 size={14} className={styles.spinning} /> : 'Connect'}
                  </Button>
                </div>
              )}

              {connectionResult && (
                <p className={connectionResult.success ? styles.successMessage : styles.errorMessage}>
                  {connectionResult.message}
                </p>
              )}

              {hasConfiguredProvider && (
                <div className={styles.syncRow}>
                  <Button
                    onClick={() => void handleSyncNow()}
                    disabled={syncing}
                    variant="ghost"
                    size="sm"
                  >
                    {syncing ? <Loader2 size={14} className={styles.spinning} /> : <RefreshCw size={14} />}
                    Sync now
                  </Button>
                  {syncResult && (
                    <span className={syncResult.success ? styles.successMessage : styles.errorMessage}>
                      {syncResult.message}
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Disable notetaker */}
            {isEnabled && (
              <div className={styles.advancedGroup}>
                <button
                  type="button"
                  className={styles.disableButton}
                  onClick={() => updateMeetingBot({ enabled: false })}
                >
                  Turn off notetaker
                </button>
              </div>
            )}
          </div>
        )}
      </SettingSection>
    </>
  );
};

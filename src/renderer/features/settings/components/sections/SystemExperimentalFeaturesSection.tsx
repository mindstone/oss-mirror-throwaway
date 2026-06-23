import { MaturityBadge, Notice, Toggle } from '@renderer/components/ui';
import styles from '../SettingsSurface.module.css';
import { SettingRow } from '../SettingRow';
import { SettingSection } from '../SettingSection';
import type { SystemTabProps } from '../tabs/types';

/** Meeting Notetaker unlock — composed into Meetings destination. */
export const MeetingNotetakerUnlockSection = ({
  draftSettings,
  updateDraft,
}: Pick<SystemTabProps, 'draftSettings' | 'updateDraft'>) => (
  <SettingSection
    title="Meeting Notetaker access"
    badge={<MaturityBadge level="labs" featureName="Experimental Features" />}
    data-section="experimental-meetings"
    data-testid="settings-section-meeting-notetaker-unlock"
  >
    <SettingRow label="Meeting Notetaker" htmlFor="meeting-notetaker-toggle">
      <Toggle
        id="meeting-notetaker-toggle"
        data-testid="settings-meeting-notetaker-toggle"
        checked={draftSettings.meetingBotUnlocked === true}
        onCheckedChange={(checked) => {
          updateDraft('meetingBotUnlocked', checked);
          if (!checked) {
            updateDraft('meetingBot', { ...draftSettings.meetingBot, joinMode: 'never' });
          }
        }}
      />
    </SettingRow>
    <Notice tone="warning" placement="inline" density="compact">
      This feature is experimental and may be unstable. Rebel can join your meetings to take notes, but you may experience issues with bot
      reliability or transcript quality. Also enables physical recording device settings.
    </Notice>
    {draftSettings.meetingBotUnlocked === true && <p className={styles.groupDescription}>Restart Rebel to activate meeting services.</p>}
  </SettingSection>
);

/** Local Inference toggle — composed into Advanced destination. */
export const LocalInferenceToggleSection = ({
  draftSettings,
  updateDraft,
}: Pick<SystemTabProps, 'draftSettings' | 'updateDraft'>) => (
  <SettingSection
    title="Local Models"
    description="Download and run AI models on your device. No internet required."
    badge={<MaturityBadge level="labs" featureName="Experimental Features" />}
    data-section="localInference"
    data-testid="settings-section-local-inference"
  >
    <SettingRow
      label="Local models"
      tooltip="Download and run AI models entirely on your machine. Conversations stay on your device."
      htmlFor="local-inference-toggle"
    >
      <Toggle
        id="local-inference-toggle"
        data-testid="settings-local-inference-toggle"
        checked={draftSettings.experimental?.localInferenceEnabled === true}
        onCheckedChange={() => {
          updateDraft('experimental', {
            ...draftSettings.experimental,
            localInferenceEnabled: !draftSettings.experimental?.localInferenceEnabled,
          });
        }}
      />
    </SettingRow>
    {draftSettings.experimental?.localInferenceEnabled && (
      <p className={styles.groupDescription}>
        Head to Settings → Model to set up and download local models.
      </p>
    )}
  </SettingSection>
);

/** Server-side context compaction toggle — composed into Advanced destination. */
export const ContextCompactionSection = ({
  draftSettings,
  updateDraft,
}: Pick<SystemTabProps, 'draftSettings' | 'updateDraft'>) => (
  <SettingSection
    title="Context Compaction"
    description="Let the API summarise long conversations to reclaim context window space. Preserves key decisions, artifacts, and progress."
    badge={<MaturityBadge level="labs" featureName="Experimental Features" />}
    data-section="contextCompaction"
    data-testid="settings-section-context-compaction"
  >
    <SettingRow
      label="Enable context compaction"
      tooltip="When enabled, Anthropic's compact_20260112 API will automatically summarise older parts of very long conversations so the agent can keep working without losing track of important information. This is experimental and the API may not support it for all models yet."
      htmlFor="context-compaction-toggle"
    >
      <Toggle
        id="context-compaction-toggle"
        data-testid="settings-context-compaction-toggle"
        checked={draftSettings.experimental?.compactEnabled === true}
        onCheckedChange={() => {
          updateDraft('experimental', {
            ...draftSettings.experimental,
            compactEnabled: !draftSettings.experimental?.compactEnabled,
          });
        }}
      />
    </SettingRow>
  </SettingSection>
);

/** Smart model picking signpost — the toggle lives with the Model team section. */
export const AdaptiveRoutingToggleSection = (
  _props: Pick<SystemTabProps, 'draftSettings' | 'updateDraft'>,
) => (
  <SettingSection
    title="Smart model picking"
    badge={<MaturityBadge level="labs" featureName="Experimental Features" />}
    data-section="adaptiveRouting"
    data-testid="settings-section-adaptive-routing"
  >
    <p className={styles.groupDescription}>
      Smart model picking now lives in AI &amp; Models → Available models.
    </p>
  </SettingSection>
);

/** Prevent sleep during agent turns toggle — composed into Advanced destination. */
export const PowerSaveToggleSection = ({
  draftSettings,
  updateDraft,
}: Pick<SystemTabProps, 'draftSettings' | 'updateDraft'>) => (
  <SettingSection
    title="Prevent Sleep"
    description="Keep your computer awake while Rebel is working so long-running tasks complete uninterrupted."
    data-section="preventSleep"
    data-testid="settings-section-prevent-sleep"
  >
    <SettingRow
      label="Prevent sleep during agent turns"
      tooltip="When enabled, your computer won't go to sleep while Rebel is actively running a task. Your display can still turn off. A 30-minute safety limit prevents runaway wake locks."
      htmlFor="prevent-sleep-toggle"
    >
      <Toggle
        id="prevent-sleep-toggle"
        data-testid="settings-prevent-sleep-toggle"
        checked={draftSettings.preventSleepDuringTurns === true}
        onCheckedChange={() => {
          updateDraft('preventSleepDuringTurns', !draftSettings.preventSleepDuringTurns);
        }}
      />
    </SettingRow>
  </SettingSection>
);

/** @deprecated Prefer {@link MeetingNotetakerUnlockSection} in composed destinations. */
export const SystemExperimentalFeaturesSection = ({
  draftSettings,
  updateDraft,
}: Pick<SystemTabProps, 'draftSettings' | 'updateDraft'>) => (
  <>
    <MeetingNotetakerUnlockSection draftSettings={draftSettings} updateDraft={updateDraft} />
  </>
);

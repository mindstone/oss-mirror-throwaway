import type { MeetingBotSettings } from '@shared/types';
import { SettingRow } from './SettingRow';
import styles from './SettingsSurface.module.css';

interface LocalRecordingTriggerToggleProps {
  meetingBot: MeetingBotSettings;
  updateMeetingBot: (updates: Partial<MeetingBotSettings>) => void;
}

export function LocalRecordingTriggerToggle({
  meetingBot,
  updateMeetingBot,
}: LocalRecordingTriggerToggleProps) {
  const hasExplicitTriggerPhrase = typeof meetingBot.triggerPhrase === 'string'
    && meetingBot.triggerPhrase.trim().length > 0;
  const enabled = meetingBot.localRecordingTriggerListening ?? hasExplicitTriggerPhrase;

  return (
    <SettingRow
      label="Listen for trigger phrase during local recording"
      description="When on, saying 'hey [your trigger phrase]' during local recordings asks Spark in your conversation."
      htmlFor="local-recording-trigger-listening"
    >
      <input
        id="local-recording-trigger-listening"
        type="checkbox"
        checked={enabled}
        onChange={(event) => {
          updateMeetingBot({ localRecordingTriggerListening: event.target.checked });
        }}
        className={styles.responseTypeCheckbox}
      />
    </SettingRow>
  );
}

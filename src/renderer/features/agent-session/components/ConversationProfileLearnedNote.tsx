import { useMemo } from 'react';
import { useSessionStore } from '../store/sessionStore';
import { useSettingsSafe } from '@renderer/features/settings';
import { useProfileLearnedEvents } from '@renderer/features/settings/hooks/useProfileLearnedEvents';
import { ProfileLearnedNotices } from '@renderer/features/settings/components/ProfileLearnedNotices';
import { resolveModelSettings } from '@shared/utils/modelSettingsResolver';

interface ConversationProfileLearnedNoteProps {
  hasMessages: boolean;
}

export function ConversationProfileLearnedNote({ hasMessages }: ConversationProfileLearnedNoteProps) {
  const sessionWorkingProfileId = useSessionStore((s) => s.sessionWorkingProfileId);
  const sessionThinkingProfileId = useSessionStore((s) => s.sessionThinkingProfileId);

  const settings = useSettingsSafe();
  const profiles = useMemo(
    () => settings?.draftSettings?.localModel?.profiles ?? [],
    [settings?.draftSettings?.localModel?.profiles],
  );

  const resolvedDefaults = useMemo(
    () => resolveModelSettings(settings?.draftSettings),
    [settings?.draftSettings],
  );

  const activeProfileIds = useMemo(() => {
    const ids = new Set<string>();
    const working = sessionWorkingProfileId ?? resolvedDefaults.workingProfileId;
    const thinking = sessionThinkingProfileId ?? resolvedDefaults.thinkingProfileId;
    if (working) ids.add(working);
    if (thinking) ids.add(thinking);
    return ids;
  }, [
    sessionWorkingProfileId,
    sessionThinkingProfileId,
    resolvedDefaults.workingProfileId,
    resolvedDefaults.thinkingProfileId,
  ]);

  const { events, dismissEvent } = useProfileLearnedEvents(profiles);

  const filteredEvents = useMemo(
    () => events.filter((event) => activeProfileIds.has(event.profileId)),
    [events, activeProfileIds],
  );

  if (!hasMessages) return null;
  if (filteredEvents.length === 0) return null;

  return (
    <div data-testid="conversation-profile-learned-note">
      <ProfileLearnedNotices events={filteredEvents} onDismiss={dismissEvent} />
    </div>
  );
}

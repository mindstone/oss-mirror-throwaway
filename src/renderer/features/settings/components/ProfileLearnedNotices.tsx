import { useState } from 'react';
import { Button, Notice } from '@renderer/components/ui';
import type { ProfileLearnedEvent } from '../hooks/useProfileLearnedEvents';

interface ProfileLearnedNoticesProps {
  events: readonly ProfileLearnedEvent[];
  onDismiss: (eventId: string) => void;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M tokens`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K tokens`;
  return `${tokens} tokens`;
}

export function buildProfileLearnedNoticeCopy(event: ProfileLearnedEvent): string {
  // Only the output-cap notice survives: it reports the exact value the API
  // stated. The context-window banner was retired (PLAN.md Stage 3).
  return `${event.model} said its output limit is ${formatTokenCount(event.observedCap)}. Rebel updated ${event.profileName}; future requests will stay under it automatically.`;
}

function dismissAllEvents(
  events: readonly ProfileLearnedEvent[],
  onDismiss: (eventId: string) => void,
): void {
  for (const event of events) onDismiss(event.id);
}

function CollapsedLearnedNotice({
  events,
  onDismiss,
}: {
  events: readonly ProfileLearnedEvent[];
  onDismiss: (eventId: string) => void;
}) {
  const [showDetails, setShowDetails] = useState(false);

  return (
    <Notice
      tone="info"
      placement="inline"
      density="compact"
      title={`Rebel learned ${events.length} model limits`}
      dismissible
      onDismiss={() => dismissAllEvents(events, onDismiss)}
      data-testid="settings-models-learned-notice-collapsed"
    >
      <div>
        <span>
          Models reported their actual ceilings; Rebel updated the affected profiles so
          future requests stay within them automatically.
        </span>
        <div style={{ marginTop: 8 }}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowDetails((prev) => !prev)}
            data-testid="settings-models-learned-notice-toggle-details"
          >
            {showDetails ? 'Hide details' : 'Show details'}
          </Button>
        </div>
        {showDetails && (
          <ul
            style={{ marginTop: 8, paddingLeft: 20 }}
            data-testid="settings-models-learned-notice-details"
          >
            {events.map((event) => (
              <li key={event.id} data-testid={`settings-models-learned-notice-detail-${event.id}`}>
                {buildProfileLearnedNoticeCopy(event)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Notice>
  );
}

export function ProfileLearnedNotices({ events, onDismiss }: ProfileLearnedNoticesProps) {
  if (events.length === 0) return null;

  if (events.length > 1) {
    return (
      <div data-testid="settings-models-learned-notice-list">
        <CollapsedLearnedNotice events={events} onDismiss={onDismiss} />
      </div>
    );
  }

  const event = events[0];
  return (
    <div data-testid="settings-models-learned-notice-list">
      <Notice
        key={event.id}
        tone="info"
        placement="inline"
        density="compact"
        title="Rebel got smarter"
        dismissible
        onDismiss={() => onDismiss(event.id)}
        data-testid={`settings-models-learned-notice-${event.id}`}
      >
        {buildProfileLearnedNoticeCopy(event)}
      </Notice>
    </div>
  );
}

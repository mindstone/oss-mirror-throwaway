import { MessageCircle, MessagesSquare, Send, type LucideIcon } from 'lucide-react';
import { Badge, Button } from '@renderer/components/ui';
import { tracking } from '@renderer/src/tracking';
import { SettingRow } from '../SettingRow';

export type MessagingPlatform = 'telegram' | 'whatsapp' | 'teams';

export interface MessagingComingSoonRowProps {
  platform: MessagingPlatform;
}

const PLATFORM_COPY: Record<MessagingPlatform, {
  label: string;
  description: string;
  Icon: LucideIcon;
}> = {
  telegram: {
    label: 'Telegram',
    description: 'Message Rebel from Telegram chats and keep the conversation in context.',
    Icon: Send,
  },
  whatsapp: {
    label: 'WhatsApp',
    description: 'Send quick WhatsApp messages to Rebel without opening the app.',
    Icon: MessageCircle,
  },
  teams: {
    label: 'Microsoft Teams',
    description: 'Mention Rebel in Teams chats and channels, with replies staying in the thread.',
    Icon: MessagesSquare,
  },
};

export function MessagingComingSoonRow({ platform }: MessagingComingSoonRowProps) {
  const { label, description, Icon } = PLATFORM_COPY[platform];
  const badgeId = `messaging-${platform}-coming-soon-badge`;

  return (
    <SettingRow
      label={label}
      description={description}
      badge={(
        <Badge id={badgeId} variant="muted" size="sm">
          Coming soon
        </Badge>
      )}
      data-testid={`messaging-coming-soon-${platform}`}
    >
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-disabled="true"
        aria-describedby={badgeId}
        onClick={() => tracking.settings.messagingChannelInterestClicked({ channel: platform })}
        style={{ alignSelf: 'flex-end', cursor: 'not-allowed', opacity: 0.72 }}
      >
        <Icon size={14} aria-hidden="true" />
        Connect
      </Button>
    </SettingRow>
  );
}

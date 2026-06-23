import { useCallback, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { MessageCircleIcon, ShieldIcon, ZapIcon } from './icons';
import styles from './QuickStartChips.module.css';
import { fireAndForget } from '../utils/fireAndForget';

interface QuickStartChipsProps {
  approvalCount: number;
  todayActionCount: number;
  hasAnySessions: boolean;
}

interface ChipDescriptor {
  key: string;
  label: string;
  to?: string;
  onPress?: () => void;
  icon: 'shield' | 'zap' | 'message-circle';
}

function ChipIcon({ icon }: Pick<ChipDescriptor, 'icon'>) {
  if (icon === 'shield') return <ShieldIcon size={14} />;
  if (icon === 'zap') return <ZapIcon size={14} />;
  return <MessageCircleIcon size={14} />;
}

export function QuickStartChips({ approvalCount, todayActionCount, hasAnySessions }: QuickStartChipsProps) {
  const navigate = useNavigate();

  const startNewConversation = useCallback(() => {
    const sessionId = `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    fireAndForget(navigate(`/conversations/${sessionId}?compose=text`), 'QuickStartChips:startNewConversation:navigate');
  }, [navigate]);

  const chips = useMemo<ChipDescriptor[]>(() => {
    const result: ChipDescriptor[] = [];

    if (approvalCount > 0) {
      result.push({
        key: 'approvals',
        icon: 'shield',
        label: `Review ${approvalCount} approval${approvalCount === 1 ? '' : 's'}`,
        to: '/approvals',
      });
    }

    if (todayActionCount > 0) {
      result.push({
        key: 'actions',
        icon: 'zap',
        label: `${todayActionCount} action${todayActionCount === 1 ? '' : 's'} need${
          todayActionCount === 1 ? 's' : ''
        } attention`,
        to: '/inbox',
      });
    }

    if (!hasAnySessions && result.length === 0) {
      result.push({
        key: 'new-conversation',
        icon: 'message-circle',
        label: 'Ask Rebel anything',
        onPress: startNewConversation,
      });
    }

    return result;
  }, [approvalCount, todayActionCount, hasAnySessions, startNewConversation]);

  if (chips.length === 0) return null;

  return (
    <div className={styles.row} data-testid="quick-start-chips">
      {chips.map((chip) => {
        if (chip.to) {
          return (
            <Link
              key={chip.key}
              to={chip.to}
              className={styles.chip}
              data-testid={`quick-start-chip-${chip.key}`}
            >
              <span className={styles.iconWrap}>
                <ChipIcon icon={chip.icon} />
              </span>
              <span>{chip.label}</span>
            </Link>
          );
        }

        return (
          <button
            key={chip.key}
            type="button"
            className={styles.chip}
            data-testid={`quick-start-chip-${chip.key}`}
            onClick={chip.onPress}
          >
            <span className={styles.iconWrap}>
              <ChipIcon icon={chip.icon} />
            </span>
            <span>{chip.label}</span>
          </button>
        );
      })}
    </div>
  );
}

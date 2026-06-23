import { memo } from 'react';
import { MessageCircleQuestion } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import type { QuestionWaitingItem } from '../hooks/usePendingQuestionWaiting';
import './DrawerApprovalCard.css';
import './DrawerQuestionWaitingCard.css';

interface DrawerQuestionWaitingCardProps {
  item: QuestionWaitingItem;
  onOpen: () => void;
}

export const DrawerQuestionWaitingCard = memo(function DrawerQuestionWaitingCard({
  item,
  onOpen,
}: DrawerQuestionWaitingCardProps) {
  const timeAgo = formatDistanceToNow(item.timestamp, { addSuffix: true });
  const sourceLabel = item.sourceLabel === 'Conversation'
    ? null
    : item.sourceLabel;

  return (
    <div className="drawer-card" data-testid="drawer-card-question-waiting">
      <div className="drawer-card__headline-row">
        <div className="drawer-card__type-icon drawer-question-waiting__type-icon">
          <MessageCircleQuestion size={18} aria-hidden="true" />
        </div>
        <div className="drawer-card__headline-copy">
          <span className="drawer-card__time-row">
            <span className="drawer-card__time">{timeAgo}</span>
            {sourceLabel && (
              <span className="drawer-question-waiting__source">
                {sourceLabel}
              </span>
            )}
          </span>
          <p className="drawer-card__headline-title">Rebel needs one detail</p>
        </div>
      </div>

      <div className="drawer-card__body">
        <p className="drawer-card__description">
          {item.questionText}
        </p>
        <p className="drawer-question-waiting__note">
          Answering clarifies what you meant. It does not approve the action.
        </p>
      </div>

      <div className="drawer-card__links drawer-question-waiting__links">
        <button
          type="button"
          className="drawer-card__link"
          onClick={onOpen}
          data-testid="drawer-card-question-waiting-open"
        >
          Answer detail
        </button>
      </div>
    </div>
  );
});

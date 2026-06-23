// Invariant #4: DrawerApprovalCard and DrawerSkillNotificationCard MUST remain
// separate components. They share primitives (FileLocationBadge) but have
// different lifecycles. See docs/plans/260419_file_location_centralisation.md
// §Invariants #4.

import { memo } from 'react';
import { BellRing } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { Button, FileLocationBadge } from '@renderer/components/ui';
import { legacyMissingLocation } from '@rebel/shared';
import type { SkillChangeNotificationItem } from '../hooks/useSkillChangeNotifications';
import './DrawerApprovalCard.css';
import './DrawerSkillNotificationCard.css';

interface DrawerSkillNotificationCardProps {
  notification: SkillChangeNotificationItem;
  onView: () => void;
  onDismiss: () => void;
}

export const DrawerSkillNotificationCard = memo(function DrawerSkillNotificationCard({
  notification,
  onView,
  onDismiss,
}: DrawerSkillNotificationCardProps) {
  const timeAgo = formatDistanceToNow(notification.updatedAt, { addSuffix: true });
  const actorLabel = notification.actorLabel || 'Someone';
  const location = notification.location
    ?? legacyMissingLocation({
      spaceName: notification.spaceName,
      legacyPath: notification.skillWorkspacePath,
    });

  return (
    <div className="drawer-card" data-testid="drawer-card-skill-notification">
      <div className="drawer-card__headline-row">
        <div className="drawer-card__type-icon drawer-skill-notification__type-icon">
          <BellRing size={18} aria-hidden="true" />
        </div>
        <div className="drawer-card__headline-copy">
          <span className="drawer-card__time">{timeAgo}</span>
          <p className="drawer-card__headline-title">
            {notification.skillName}
          </p>
        </div>
      </div>

      <div className="drawer-card__body">
        <div className="drawer-skill-notification__body">
          <p className="drawer-card__description">
            {actorLabel} changed this skill. Want to review the changes?
          </p>
          <div className="drawer-card__destination-badges">
            <FileLocationBadge
              location={location}
              compact
              className="drawer-card__file-location"
            />
          </div>
        </div>

        <div className="drawer-card__actions">
          <div className="drawer-card__inline-row">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="drawer-card__action-button drawer-card__btn-main-action"
              onClick={onView}
              data-testid="drawer-card-skill-notification-open"
            >
              View skill
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="drawer-card__action-button drawer-card__btn-tertiary"
              onClick={onDismiss}
              data-testid="drawer-card-skill-notification-dismiss"
            >
              Dismiss
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
});

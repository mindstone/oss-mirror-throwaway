/**
 * AvatarPopover
 *
 * Simple floating popover for meeting bot avatar quick settings.
 * Shows avatar name, tagline, and links to change avatar or open full settings.
 */

import { type FC } from 'react';
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  FloatingPortal,
  useDismiss,
  useInteractions,
} from '@floating-ui/react';
import { Settings, Sparkles } from 'lucide-react';
import { Button } from '@renderer/components/ui/Button';
import type { RebelAvatarId } from '@shared/types';
import './AvatarPopover.css';

/** R2 bucket URL for avatar images */
const AVATAR_BASE_URL = 'https://pub-15a8bb8fa4a2468086761a85641af2c8.r2.dev/rebel-avatars';

/** Avatar display names and taglines */
const AVATAR_INFO: Record<RebelAvatarId, { name: string; tagline: string }> = {
  dash: { name: 'Dash', tagline: 'Quick and to the point.' },
  glitch: { name: 'Glitch', tagline: 'Expects the unexpected.' },
  rogue: { name: 'Rogue', tagline: 'Plays by their own rules.' },
  scout: { name: 'Scout', tagline: 'Always one step ahead.' },
  spark: { name: 'Spark', tagline: 'Brings energy to every meeting.' },
};

export interface AvatarPopoverProps {
  isOpen: boolean;
  avatarId: RebelAvatarId;
  referenceElement: HTMLElement | null;
  onClose: () => void;
  onOpenSettings: () => void;
}

export const AvatarPopover: FC<AvatarPopoverProps> = ({
  isOpen,
  avatarId,
  referenceElement,
  onClose,
  onOpenSettings,
}) => {
  const {
    refs,
    floatingStyles,
    context,
  } = useFloating({
    open: isOpen,
    onOpenChange: (open) => {
      if (!open) onClose();
    },
    placement: 'bottom-start',
    middleware: [
      offset(8),
      flip({ fallbackAxisSideDirection: 'start', padding: 8 }),
      shift({ padding: 8 }),
    ],
    whileElementsMounted: autoUpdate,
    elements: {
      reference: referenceElement,
    },
  });

  const dismiss = useDismiss(context, {
    escapeKey: true,
    outsidePress: true,
  });

  const { getFloatingProps } = useInteractions([dismiss]);

  if (!isOpen || !referenceElement) {
    return null;
  }

  const info = AVATAR_INFO[avatarId];
  const avatarUrl = `${AVATAR_BASE_URL}/${avatarId}.png`;

  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        style={floatingStyles}
        className="avatar-popover"
        {...getFloatingProps()}
      >
        <div className="avatar-popover__header">
          <img
            src={avatarUrl}
            alt={info.name}
            className="avatar-popover__image"
          />
          <div className="avatar-popover__info">
            <span className="avatar-popover__name">{info.name}</span>
            <span className="avatar-popover__tagline">{info.tagline}</span>
          </div>
        </div>

        <div className="avatar-popover__actions">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onOpenSettings();
              onClose();
            }}
            className="avatar-popover__btn"
          >
            <Sparkles size={14} />
            Change Rebel
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onOpenSettings();
              onClose();
            }}
            className="avatar-popover__btn"
          >
            <Settings size={14} />
            Meeting Settings
          </Button>
        </div>
      </div>
    </FloatingPortal>
  );
};

AvatarPopover.displayName = 'AvatarPopover';

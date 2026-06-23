import { memo } from 'react';
import { Flag } from 'lucide-react';
import { IconButton, Tooltip } from '@renderer/components/ui';

export type FinishLineButtonProps = {
  hasFinishLine: boolean;
  isEditing: boolean;
  onClick: () => void;
};

const FinishLineButtonComponent = ({
  hasFinishLine,
  isEditing,
  onClick,
}: FinishLineButtonProps) => {
  const ariaLabel = hasFinishLine ? 'Edit finish line' : 'Set a finish line';
  const tooltip = hasFinishLine
    ? 'Edit finish line'
    : 'Tell Rebel what finished looks like.';

  return (
    <Tooltip content={tooltip} placement="top" delayShow={300}>
      <IconButton
        size="md"
        variant="framed"
        active={hasFinishLine || isEditing}
        onClick={onClick}
        aria-label={ariaLabel}
        aria-expanded={isEditing}
        data-testid="finish-line-button"
      >
        <Flag size={16} aria-hidden="true" />
      </IconButton>
    </Tooltip>
  );
};

export const FinishLineButton = memo(FinishLineButtonComponent);
FinishLineButton.displayName = 'FinishLineButton';

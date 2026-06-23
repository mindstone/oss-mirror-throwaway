import { Clapperboard } from 'lucide-react';
import { Tooltip } from '@renderer/components/ui';
import { useFlowPanels } from '@renderer/features/flow-panels/FlowPanelsProvider';
import './InsightsPill.css';

type InsightsPillProps = {
  turnId: string;
};

export const InsightsPill = ({ turnId }: InsightsPillProps) => {
  const { openInsightsDrawer, insightsDrawerOpen, selectedInsightsTurnId } = useFlowPanels();

  const isActive = insightsDrawerOpen && selectedInsightsTurnId === turnId;

  const handleClick = (event: React.MouseEvent) => {
    event.stopPropagation();
    openInsightsDrawer(turnId);
  };

  return (
    <Tooltip content="See how Rebel worked through this turn" placement="top" delayShow={300}>
      <button
        type="button"
        className={`insights-pill ${isActive ? 'insights-pill--active' : ''}`.trim()}
        onClick={handleClick}
        aria-label="Behind the scenes"
        aria-pressed={isActive}
      >
        <Clapperboard className="insights-pill__icon-left" size={12} aria-hidden />
        <span className="insights-pill__label">Behind the scenes</span>
      </button>
    </Tooltip>
  );
};


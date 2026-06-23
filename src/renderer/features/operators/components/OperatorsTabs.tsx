import { type ReactNode } from 'react';
import { Tabs, TabsList, TabsTrigger } from '@renderer/components/ui';
import styles from '../OperatorsPanel.module.css';

export type OperatorsTabValue = 'operators' | 'live-coaches';

interface OperatorsTabsProps {
  value: OperatorsTabValue;
  onValueChange: (next: OperatorsTabValue) => void;
  operatorsCount: number;
  liveCoachesCount: number;
}

export function OperatorsTabs({ value, onValueChange, operatorsCount, liveCoachesCount }: OperatorsTabsProps): ReactNode {
  return (
    <Tabs
      value={value}
      onValueChange={(next) => onValueChange(next as OperatorsTabValue)}
      className={styles.operatorsTabs}
    >
      <TabsList variant="underline">
        <TabsTrigger value="operators" data-testid="operators-tab-trigger">
          <span className={styles.tabLabel}>Operators</span>
          <span className={styles.tabCount} aria-hidden>
            {operatorsCount}
          </span>
          <span className="sr-only">{operatorsCount} operators</span>
        </TabsTrigger>
        <TabsTrigger value="live-coaches" data-testid="live-coaches-tab-trigger">
          <span className={styles.tabLabel}>Live coaches</span>
          <span className={styles.tabCount} aria-hidden>
            {liveCoachesCount}
          </span>
          <span className="sr-only">{liveCoachesCount} live coaches</span>
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

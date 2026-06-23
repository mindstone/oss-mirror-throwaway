import { useCallback, useState } from 'react';
import { Button } from '@renderer/components/ui';
import { useAppContext } from '@renderer/contexts';
import styles from '../SettingsSurface.module.css';

type SuperMcpRestartButtonProps = {
  onRestarted?: () => Promise<void> | void;
};

export function SuperMcpRestartButton({ onRestarted }: SuperMcpRestartButtonProps) {
  const { showToast } = useAppContext();
  const [isRestarting, setIsRestarting] = useState(false);

  const handleRestart = useCallback(async () => {
    setIsRestarting(true);
    try {
      const result = await window.settingsApi.mcpRestartSuperMcp();
      if (!result.success) {
        console.error('Failed to restart Super-MCP:', result.error);
        showToast({ title: 'Failed to restart Super-MCP' });
        return;
      }

      showToast({ title: 'Super-MCP restarted' });
      await onRestarted?.();
    } finally {
      setIsRestarting(false);
    }
  }, [onRestarted, showToast]);

  return (
    <Button
      variant="outline"
      size="lg"
      className={styles.actionButton}
      onClick={() => void handleRestart()}
      disabled={isRestarting}
    >
      {isRestarting ? 'Restarting...' : 'Restart Super-MCP'}
    </Button>
  );
}

/**
 * PluginSurface
 *
 * Main-pane tab wrapper that renders a plugin using the shared PluginRenderer.
 * Includes a settings overlay button specific to the tab context.
 *
 * @see docs/plans/260322_plugin_extension_system.md
 * @see docs/plans/260327_plugin_wave5_infrastructure.md — Stage C1 (PluginRenderer extraction)
 */

import { useCallback } from 'react';
import { Settings } from 'lucide-react';
import { IconButton, Tooltip } from '@renderer/components/ui';
import { useNavigationSafe } from '@renderer/contexts/NavigationContext';
import { fireAndForget } from '@shared/utils/fireAndForget';
import type { PluginSurfaceId } from '../types';
import { getPluginIdFromSurface } from '../types';
import { PluginRenderer } from './PluginRenderer';
import styles from './PluginSurface.module.css';

interface PluginSurfaceProps {
  surfaceId: PluginSurfaceId;
  source?: string;
}

export const PluginSurface = ({ surfaceId, source }: PluginSurfaceProps) => {
  const pluginId = getPluginIdFromSurface(surfaceId) ?? 'unknown';
  const navigation = useNavigationSafe();

  const openPluginSettings = useCallback(() => {
    fireAndForget(navigation?.navigate({ type: 'settings', tab: 'plugins' }), 'navigateToPluginSettings');
  }, [navigation]);

  return (
    <div className={styles.surface} data-plugin-id={pluginId}>
      <div className={styles.settingsOverlay}>
        <Tooltip content="Plugin settings" placement="left" delayShow={250}>
          <IconButton
            size="xs"
            className={styles.settingsButton}
            aria-label="Open plugin settings"
            onClick={openPluginSettings}
          >
            <Settings size={14} />
          </IconButton>
        </Tooltip>
      </div>
      <div className={styles.scrollArea}>
        <PluginRenderer pluginId={pluginId} source={source} />
      </div>
    </div>
  );
};

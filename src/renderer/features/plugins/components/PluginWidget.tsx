/**
 * PluginWidget
 *
 * Compact widget container for rendering a plugin on the homepage.
 * Applies size constraints and a card-like visual treatment.
 *
 * Widget sizes:
 *   - small  — ~120px max height
 *   - medium — ~200px max height
 *   - large  — ~300px max height
 *
 * @see docs/plans/260327_plugin_wave5_infrastructure.md — Stage C1
 */

import type { WidgetSize } from '../manifest/pluginManifest';
import { PluginRenderer } from './PluginRenderer';
import styles from './PluginWidget.module.css';

const WIDGET_HEIGHT: Record<WidgetSize, number> = {
  small: 120,
  medium: 200,
  large: 300,
};

export interface PluginWidgetProps {
  pluginId: string;
  pluginName: string;
  source: string;
  size?: WidgetSize;
}

export function PluginWidget({ pluginId, pluginName, source, size = 'medium' }: PluginWidgetProps) {
  const maxHeight = WIDGET_HEIGHT[size];

  return (
    <div
      className={styles.widget}
      style={{ maxHeight }}
      data-plugin-id={pluginId}
      data-widget-size={size}
    >
      <div className={styles.header}>
        <span className={styles.headerTitle}>{pluginName}</span>
      </div>
      <div className={styles.content}>
        <PluginRenderer
          pluginId={pluginId}
          source={source}
          compact
          loadingFallback={
            <div className={styles.placeholder}>Loading…</div>
          }
          emptyFallback={
            <div className={styles.placeholder}>No content</div>
          }
        />
      </div>
    </div>
  );
}

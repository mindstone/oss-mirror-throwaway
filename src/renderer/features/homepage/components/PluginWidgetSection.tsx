/**
 * PluginWidgetSection
 *
 * Homepage integration that queries the plugin registry for plugins
 * declaring `surfaces.homepageWidget.enabled: true` and renders them
 * in a responsive grid below the Hero Chat area.
 *
 * @see docs/plans/260327_plugin_wave5_infrastructure.md — Stage C1
 */

import { useMemo } from 'react';
import { useRegisteredPlugins } from '../../plugins/hooks/useRegisteredPlugins';
import { PluginWidget } from '../../plugins/components/PluginWidget';
import styles from './PluginWidgetSection.module.css';

export function PluginWidgetSection() {
  const plugins = useRegisteredPlugins();

  const widgetPlugins = useMemo(() => {
    return plugins.filter(p => p.manifest.surfaces?.homepageWidget?.enabled === true);
  }, [plugins]);

  if (widgetPlugins.length === 0) return null;

  return (
    <div className={styles.section}>
      <div className={styles.grid}>
        {widgetPlugins.map(p => (
          <PluginWidget
            key={p.manifest.id}
            pluginId={p.manifest.id}
            pluginName={p.manifest.name}
            source={p.source}
            size={p.manifest.surfaces?.homepageWidget?.defaultSize}
          />
        ))}
      </div>
    </div>
  );
}

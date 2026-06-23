/**
 * Plugin BarChart
 *
 * Simple SVG bar chart for `@rebel/plugin-ui`.
 * Pure rendering component with theme-aware defaults.
 *
 * @see docs/plans/260327_plugin_wave5_infrastructure.md — Stage C2
 */

import styles from './PluginBarChart.module.css';

export interface PluginBarChartDatum {
  label: string;
  value: number;
  color?: string;
}

export interface PluginBarChartProps {
  data: PluginBarChartDatum[];
  height?: number;
  showLabels?: boolean;
}

const MIN_VIEW_WIDTH = 240;
const SLOT_WIDTH = 72;

export function BarChart({ data, height = 220, showLabels = true }: PluginBarChartProps) {
  if (!Array.isArray(data) || data.length === 0) {
    return <div className={styles.emptyState}>No chart data available.</div>;
  }

  const chartHeight = Number.isFinite(height) && height > 80 ? Math.floor(height) : 220;
  const marginTop = 16;
  const marginRight = 16;
  const marginBottom = showLabels ? 56 : 24;
  const marginLeft = 16;
  const viewWidth = Math.max(MIN_VIEW_WIDTH, data.length * SLOT_WIDTH);
  const plotWidth = Math.max(1, viewWidth - marginLeft - marginRight);
  const plotHeight = Math.max(20, chartHeight - marginTop - marginBottom);
  const slotWidth = plotWidth / Math.max(data.length, 1);
  const barWidth = Math.max(4, slotWidth * 0.72);

  const normalizedValues = data.map((item) => (
    Number.isFinite(item.value) ? Math.max(0, item.value) : 0
  ));
  const maxValue = Math.max(...normalizedValues, 0);

  return (
    <div className={styles.chartContainer}>
      <svg
        className={styles.chart}
        viewBox={`0 0 ${viewWidth} ${chartHeight}`}
        role="img"
        aria-label={`Bar chart with ${data.length} data points`}
      >
        <title>{`Bar chart: ${data.map((d) => `${d.label} = ${Number.isFinite(d.value) ? d.value : 0}`).join(', ')}`}</title>
        <line
          className={styles.axis}
          x1={marginLeft}
          y1={marginTop + plotHeight}
          x2={viewWidth - marginRight}
          y2={marginTop + plotHeight}
        />

        {data.map((item, index) => {
          const value = normalizedValues[index];
          const barHeight = maxValue > 0 ? (value / maxValue) * plotHeight : 0;
          const x = marginLeft + (index * slotWidth) + ((slotWidth - barWidth) / 2);
          const y = marginTop + (plotHeight - barHeight);
          const fill = item.color ?? 'var(--color-primary)';
          const valueY = Math.max(marginTop + 10, y - 6);
          const labelY = chartHeight - 16;

          return (
            <g key={`${item.label}-${index}`}>
              <rect
                className={styles.bar}
                data-bar-index={index}
                x={x}
                y={y}
                width={barWidth}
                height={barHeight}
                fill={fill}
                rx={4}
                aria-label={`${item.label}: ${value}`}
              />
              {showLabels && (
                <>
                  <text
                    className={styles.valueLabel}
                    x={x + (barWidth / 2)}
                    y={valueY}
                    textAnchor="middle"
                  >
                    {value}
                  </text>
                  <text
                    className={styles.axisLabel}
                    x={x + (barWidth / 2)}
                    y={labelY}
                    textAnchor="middle"
                  >
                    {item.label}
                  </text>
                </>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

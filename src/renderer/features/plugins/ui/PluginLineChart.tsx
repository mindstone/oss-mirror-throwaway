/**
 * Plugin LineChart
 *
 * Simple SVG line chart for `@rebel/plugin-ui`.
 * Pure rendering component with optional data point markers.
 *
 * @see docs/plans/260327_plugin_wave5_infrastructure.md — Stage C2
 */

import styles from './PluginLineChart.module.css';

export interface PluginLineChartDatum {
  label: string;
  value: number;
}

export interface PluginLineChartProps {
  data: PluginLineChartDatum[];
  height?: number;
  showDots?: boolean;
  color?: string;
}

const MIN_VIEW_WIDTH = 240;
const SLOT_WIDTH = 72;

export function LineChart({
  data,
  height = 220,
  showDots = true,
  color = 'var(--color-primary)',
}: PluginLineChartProps) {
  if (!Array.isArray(data) || data.length === 0) {
    return <div className={styles.emptyState}>No chart data available.</div>;
  }

  const chartHeight = Number.isFinite(height) && height > 80 ? Math.floor(height) : 220;
  const marginTop = 16;
  const marginRight = 16;
  const marginBottom = 44;
  const marginLeft = 16;
  const viewWidth = Math.max(MIN_VIEW_WIDTH, Math.max(data.length, 2) * SLOT_WIDTH);
  const plotWidth = Math.max(1, viewWidth - marginLeft - marginRight);
  const plotHeight = Math.max(20, chartHeight - marginTop - marginBottom);

  const normalizedValues = data.map((item) => (
    Number.isFinite(item.value) ? item.value : 0
  ));
  const maxValue = Math.max(...normalizedValues, 0);
  const minValue = Math.min(...normalizedValues, 0);
  const range = Math.max(maxValue - minValue, 1);

  const points = data.map((item, index) => {
    const x = data.length === 1
      ? marginLeft + (plotWidth / 2)
      : marginLeft + ((index / (data.length - 1)) * plotWidth);
    const value = normalizedValues[index];
    const y = marginTop + (((maxValue - value) / range) * plotHeight);

    return { x, y, label: item.label, value };
  });

  const pathD = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
    .join(' ');

  const zeroY = marginTop + (((maxValue - 0) / range) * plotHeight);
  const showZeroAxis = zeroY >= marginTop && zeroY <= (marginTop + plotHeight);

  return (
    <div className={styles.chartContainer}>
      <svg
        className={styles.chart}
        viewBox={`0 0 ${viewWidth} ${chartHeight}`}
        role="img"
        aria-label={`Line chart with ${data.length} data points`}
      >
        <title>{`Line chart: ${data.map((d) => `${d.label} = ${Number.isFinite(d.value) ? d.value : 0}`).join(', ')}`}</title>
        {showZeroAxis && (
          <line
            className={styles.axis}
            x1={marginLeft}
            y1={zeroY}
            x2={viewWidth - marginRight}
            y2={zeroY}
          />
        )}

        <path className={styles.line} d={pathD} style={{ stroke: color }} />

        {showDots && points.map((point, index) => (
          <circle
            key={`${point.label}-${index}`}
            className={styles.dot}
            data-dot-index={index}
            cx={point.x}
            cy={point.y}
            r={4}
            style={{ fill: color }}
          />
        ))}

        {points.map((point, index) => (
          <text
            key={`${point.label}-${index}-label`}
            className={styles.axisLabel}
            x={point.x}
            y={chartHeight - 14}
            textAnchor="middle"
          >
            {point.label}
          </text>
        ))}
      </svg>
    </div>
  );
}

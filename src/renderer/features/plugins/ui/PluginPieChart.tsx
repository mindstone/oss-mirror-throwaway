/**
 * Plugin PieChart
 *
 * Simple SVG pie chart for `@rebel/plugin-ui` with optional legend labels.
 * Pure rendering component (no internal state).
 *
 * @see docs/plans/260327_plugin_wave5_infrastructure.md — Stage C2
 */

import styles from './PluginPieChart.module.css';

export interface PluginPieChartDatum {
  label: string;
  value: number;
  color?: string;
}

export interface PluginPieChartProps {
  data: PluginPieChartDatum[];
  size?: number;
  showLabels?: boolean;
}

const DEFAULT_COLORS = [
  'var(--color-primary)',
  'var(--color-info, #22d3ee)',
  'var(--color-success, #10b981)',
  'var(--color-warning, #f97316)',
  'var(--color-brand-indigo, #4f46e5)',
];

const START_ANGLE = -Math.PI / 2;
const FULL_CIRCLE = Math.PI * 2;

function describeArcPath(
  cx: number,
  cy: number,
  radius: number,
  startAngle: number,
  endAngle: number,
) {
  const startX = cx + (radius * Math.cos(startAngle));
  const startY = cy + (radius * Math.sin(startAngle));
  const endX = cx + (radius * Math.cos(endAngle));
  const endY = cy + (radius * Math.sin(endAngle));
  const largeArcFlag = endAngle - startAngle > Math.PI ? 1 : 0;

  return `M ${cx} ${cy} L ${startX} ${startY} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${endX} ${endY} Z`;
}

export function PieChart({ data, size = 220, showLabels = true }: PluginPieChartProps) {
  if (!Array.isArray(data) || data.length === 0) {
    return <div className={styles.emptyState}>No chart data available.</div>;
  }

  const chartSize = Number.isFinite(size) && size > 80 ? Math.floor(size) : 220;
  const center = chartSize / 2;
  const radius = Math.max(8, center - 8);
  const normalizedData = data
    .map((item) => ({
      ...item,
      value: Number.isFinite(item.value) ? Math.max(0, item.value) : 0,
    }))
    .filter((item) => item.value > 0);

  const total = normalizedData.reduce((sum, item) => sum + item.value, 0);

  if (normalizedData.length === 0 || total <= 0) {
    return <div className={styles.emptyState}>No chart data available.</div>;
  }

  let currentAngle = START_ANGLE;
  const slices = normalizedData.map((item, index) => {
    const sliceAngle = (item.value / total) * FULL_CIRCLE;
    const startAngle = currentAngle;
    const endAngle = startAngle + sliceAngle;
    currentAngle = endAngle;

    return {
      ...item,
      index,
      color: item.color ?? DEFAULT_COLORS[index % DEFAULT_COLORS.length],
      percentage: (item.value / total) * 100,
      path: describeArcPath(center, center, radius, startAngle, endAngle),
    };
  });

  return (
    <div className={styles.container}>
      <svg
        className={styles.chart}
        width={chartSize}
        height={chartSize}
        viewBox={`0 0 ${chartSize} ${chartSize}`}
        role="img"
        aria-label={`Pie chart with ${slices.length} slices`}
      >
        <title>{`Pie chart: ${slices.map((s) => `${s.label} = ${s.value} (${Math.round(s.percentage)}%)`).join(', ')}`}</title>
        {slices.map((slice) => (
          <path
            key={`${slice.label}-${slice.index}`}
            className={styles.slice}
            data-slice-index={slice.index}
            d={slice.path}
            fill={slice.color}
            aria-label={`${slice.label}: ${slice.value} (${Math.round(slice.percentage)}%)`}
          >
            <title>{`${slice.label}: ${slice.value} (${Math.round(slice.percentage)}%)`}</title>
          </path>
        ))}
      </svg>

      {showLabels && (
        <ul className={styles.legend}>
          {slices.map((slice) => (
            <li key={`${slice.label}-${slice.index}-legend`} className={styles.legendItem}>
              <span className={styles.legendSwatch} style={{ backgroundColor: slice.color }} />
              <span className={styles.legendLabel}>{slice.label}</span>
              <span className={styles.legendValue}>
                {slice.value} ({Math.round(slice.percentage)}%)
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

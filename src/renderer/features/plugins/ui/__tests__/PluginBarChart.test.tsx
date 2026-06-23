import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BarChart } from '../PluginBarChart';

describe('PluginBarChart', () => {
  it('renders an empty state when no data is provided', () => {
    const html = renderToStaticMarkup(<BarChart data={[]} />);
    expect(html).toContain('No chart data available.');
  });

  it('renders one bar per datum', () => {
    const html = renderToStaticMarkup(
      <BarChart
        data={[
          { label: 'A', value: 10 },
          { label: 'B', value: 20 },
          { label: 'C', value: 30 },
        ]}
      />,
    );

    const barCount = (html.match(/data-bar-index=/g) ?? []).length;
    expect(barCount).toBe(3);
  });

  it('applies custom bar colors when provided', () => {
    const html = renderToStaticMarkup(
      <BarChart
        data={[
          { label: 'A', value: 10, color: '#ff0000' },
          { label: 'B', value: 20 },
        ]}
      />,
    );

    expect(html).toContain('fill="#ff0000"');
  });
});

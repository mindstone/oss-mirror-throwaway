import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DataTable,
  filterDataTableRows,
  sortDataTableRows,
  paginateDataTableRows,
  type PluginDataTableColumn,
} from '../PluginDataTable';

describe('PluginDataTable', () => {
  const columns: PluginDataTableColumn[] = [
    { key: 'name', label: 'Name', sortable: true },
    { key: 'score', label: 'Score', sortable: true },
    { key: 'team', label: 'Team' },
  ];

  const rows = [
    { name: 'Ada', score: 15, team: 'Platform' },
    { name: 'Grace', score: 3, team: 'Research' },
    { name: 'Linus', score: 21, team: 'Platform' },
  ];

  it('filters rows case-insensitively across visible columns', () => {
    const filtered = filterDataTableRows(rows, columns, 'platform');
    expect(filtered).toHaveLength(2);
    expect(filtered.map((row) => row.name)).toEqual(['Ada', 'Linus']);
  });

  it('sorts numeric rows in ascending and descending order', () => {
    const ascending = sortDataTableRows(rows, 'score', 'asc');
    const descending = sortDataTableRows(rows, 'score', 'desc');

    expect(ascending.map((row) => row.score)).toEqual([3, 15, 21]);
    expect(descending.map((row) => row.score)).toEqual([21, 15, 3]);
  });

  it('paginates rows by page size', () => {
    const paged = paginateDataTableRows(rows, 2, 2);
    expect(paged).toHaveLength(1);
    expect(paged[0].name).toBe('Linus');
  });

  it('renders an empty state row when no rows are available', () => {
    const html = renderToStaticMarkup(<DataTable columns={columns} rows={[]} />);
    expect(html).toContain('No rows to display.');
  });

  it('renders a configuration empty state when no columns are provided', () => {
    const html = renderToStaticMarkup(<DataTable columns={[]} rows={rows} />);
    expect(html).toContain('No table columns configured.');
  });
});

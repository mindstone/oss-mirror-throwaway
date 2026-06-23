/**
 * Plugin DataTable
 *
 * Sortable, filterable, paginated table for `@rebel/plugin-ui`.
 *
 * @see docs/plans/260327_plugin_wave5_infrastructure.md — Stage C2
 */

import { useEffect, useMemo, useState } from 'react';
import { Button, Input } from '@renderer/components/ui';
import styles from './PluginDataTable.module.css';

export type PluginDataTableRow = Record<string, string | number>;

export interface PluginDataTableColumn {
  key: string;
  label: string;
  sortable?: boolean;
}

export interface PluginDataTableProps {
  columns: PluginDataTableColumn[];
  rows: PluginDataTableRow[];
  pageSize?: number;
}

export type DataTableSortDirection = 'asc' | 'desc';

const DEFAULT_PAGE_SIZE = 10;

function normalizeCellValue(value: string | number | undefined): string {
  if (value == null) return '';
  return String(value).toLowerCase();
}

export function filterDataTableRows(
  rows: PluginDataTableRow[],
  columns: PluginDataTableColumn[],
  query: string,
): PluginDataTableRow[] {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return rows;
  }

  return rows.filter((row) => (
    columns.some((column) => normalizeCellValue(row[column.key]).includes(normalizedQuery))
  ));
}

export function sortDataTableRows(
  rows: PluginDataTableRow[],
  sortKey: string,
  direction: DataTableSortDirection,
): PluginDataTableRow[] {
  const multiplier = direction === 'asc' ? 1 : -1;
  const sorted = [...rows];

  sorted.sort((a, b) => {
    const left = a[sortKey];
    const right = b[sortKey];

    if (typeof left === 'number' && typeof right === 'number') {
      return multiplier * (left - right);
    }

    return multiplier * String(left ?? '').localeCompare(String(right ?? ''), undefined, {
      sensitivity: 'base',
      numeric: true,
    });
  });

  return sorted;
}

export function paginateDataTableRows(
  rows: PluginDataTableRow[],
  page: number,
  pageSize: number,
): PluginDataTableRow[] {
  const safePage = Math.max(1, page);
  const safePageSize = Math.max(1, pageSize);
  const start = (safePage - 1) * safePageSize;
  const end = start + safePageSize;

  return rows.slice(start, end);
}

export function DataTable({ columns, rows, pageSize = DEFAULT_PAGE_SIZE }: PluginDataTableProps) {
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(1);
  const [sortState, setSortState] = useState<{ key: string; direction: DataTableSortDirection } | null>(null);
  const normalizedPageSize = Number.isFinite(pageSize) && pageSize > 0
    ? Math.floor(pageSize)
    : DEFAULT_PAGE_SIZE;

  const filteredRows = useMemo(
    () => filterDataTableRows(rows, columns, filter),
    [rows, columns, filter],
  );

  const sortedRows = useMemo(() => {
    if (!sortState) {
      return filteredRows;
    }

    return sortDataTableRows(filteredRows, sortState.key, sortState.direction);
  }, [filteredRows, sortState]);

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / normalizedPageSize));

  useEffect(() => {
    setPage(1);
  }, [filter, sortState?.key, sortState?.direction, normalizedPageSize]);

  useEffect(() => {
    setPage((current) => (current > totalPages ? totalPages : current));
  }, [totalPages]);

  const currentPage = Math.min(page, totalPages);
  const paginatedRows = useMemo(
    () => paginateDataTableRows(sortedRows, currentPage, normalizedPageSize),
    [sortedRows, currentPage, normalizedPageSize],
  );

  const handleSort = (column: PluginDataTableColumn) => {
    if (!column.sortable) return;

    setSortState((current) => {
      if (!current || current.key !== column.key) {
        return { key: column.key, direction: 'asc' };
      }

      return {
        key: column.key,
        direction: current.direction === 'asc' ? 'desc' : 'asc',
      };
    });
  };

  const getSortIndicator = (columnKey: string) => {
    if (!sortState || sortState.key !== columnKey) return '↕';
    return sortState.direction === 'asc' ? '▲' : '▼';
  };

  if (!Array.isArray(columns) || columns.length === 0) {
    return <div className={styles.emptyState}>No table columns configured.</div>;
  }

  return (
    <div className={styles.tableContainer}>
      <div className={styles.toolbar}>
        <Input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter rows..."
          className={styles.filterInput}
        />
        <span className={styles.rowCount}>
          {sortedRows.length} row{sortedRows.length === 1 ? '' : 's'}
        </span>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              {columns.map((column) => {
                const isSorted = sortState?.key === column.key;
                const sortValue = isSorted
                  ? (sortState?.direction === 'asc' ? 'ascending' : 'descending')
                  : 'none';

                return (
                  <th key={column.key} scope="col" aria-sort={sortValue}>
                    {column.sortable ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        className={styles.sortButton}
                        onClick={() => handleSort(column)}
                        aria-label={`Sort by ${column.label}`}
                      >
                        <span>{column.label}</span>
                        <span className={styles.sortIndicator} aria-hidden>{getSortIndicator(column.key)}</span>
                      </Button>
                    ) : (
                      <span>{column.label}</span>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {paginatedRows.length === 0 ? (
              <tr className={styles.emptyRow}>
                <td colSpan={columns.length}>
                  {filter.trim() ? 'No rows match this filter.' : 'No rows to display.'}
                </td>
              </tr>
            ) : (
              paginatedRows.map((row, rowIndex) => (
                <tr key={`row-${currentPage}-${rowIndex}`}>
                  {columns.map((column) => (
                    <td key={`${rowIndex}-${column.key}`}>
                      {row[column.key] ?? '—'}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className={styles.pagination}>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            disabled={currentPage <= 1}
          >
            Previous
          </Button>
          <span className={styles.pageInfo}>
            Page {currentPage} of {totalPages}
          </span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
            disabled={currentPage >= totalPages}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}

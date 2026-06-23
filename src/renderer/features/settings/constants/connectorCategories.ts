/**
 * Connector category constants - Single source of truth
 *
 * Used by:
 * - connectorIcons.ts (icons and colors)
 * - useUnifiedConnections.ts (filtering and tabs)
 * - UnifiedConnectionsPanel.tsx (grouping UI)
 */

/**
 * All connector categories in display order.
 * This ordering is used for category filters, grouping UI, and type definitions.
 */
export const CONNECTOR_CATEGORY_ORDER = [
  'productivity',
  'communication',
  'development',
  'analytics',
  'design',
  'storage',
  'media',
  'sales',
  'payments',
  'automation',
  'research',
  'other',
] as const;

/** Union type of all connector categories */
export type ConnectorCategory = (typeof CONNECTOR_CATEGORY_ORDER)[number];

/** Category filter ID includes 'all' plus all categories */
export type CategoryFilterId = 'all' | ConnectorCategory;

/** Human-readable labels for each category */
export const CATEGORY_LABELS: Record<CategoryFilterId, string> = {
  all: 'All',
  productivity: 'Productivity',
  communication: 'Communication',
  development: 'Development',
  analytics: 'Analytics',
  design: 'Design',
  storage: 'Storage',
  media: 'Media',
  sales: 'Sales',
  payments: 'Payments',
  automation: 'Automation',
  research: 'Research',
  other: 'Other',
};

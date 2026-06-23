/**
 * Connector Icon Utilities
 *
 * Maps icon strings from connector-catalog.json to Lucide icon components,
 * and provides category-based color theming for visual differentiation.
 */

import {
  Mail,
  Calendar,
  MessageSquare,
  MessageCircle,
  FileText,
  Target,
  Github,
  Gitlab,
  Database,
  HardDrive,
  Folder,
  Cloud,
  Globe,
  Users,
  Video,
  Mic,
  Image,
  CreditCard,
  DollarSign,
  BarChart2,
  BarChart,
  TrendingUp,
  ChartLine,
  Layout,
  LayoutGrid,
  CheckSquare,
  Presentation,
  Brain,
  Archive,
  Volume2,
  Triangle,
  Trello,
  Plug,
  Search,
  Activity,
  Figma,
  Code2,
  Palette,
  Zap,
  Building2,
  MapPin,
  Megaphone,
  ShoppingBag,
  ShieldCheck,
  UserSearch,
  type LucideIcon,
} from 'lucide-react';

import { N8nIcon } from './brandIcons';
import type { ConnectorCategory } from '../constants/connectorCategories';

// Re-export for backward compatibility
export type { ConnectorCategory } from '../constants/connectorCategories';

/**
 * Map of icon string names to Lucide icon components.
 * These match the "icon" field values in connector-catalog.json.
 */
const ICON_MAP: Record<string, LucideIcon> = {
  mail: Mail,
  calendar: Calendar,
  'message-square': MessageSquare,
  'message-circle': MessageCircle,
  'file-text': FileText,
  target: Target,
  github: Github,
  gitlab: Gitlab,
  database: Database,
  'hard-drive': HardDrive,
  folder: Folder,
  cloud: Cloud,
  globe: Globe,
  users: Users,
  video: Video,
  mic: Mic,
  image: Image,
  'credit-card': CreditCard,
  'dollar-sign': DollarSign,
  'bar-chart-2': BarChart2,
  'bar-chart': BarChart,
  'trending-up': TrendingUp,
  'chart-line': ChartLine,
  layout: Layout,
  'layout-grid': LayoutGrid,
  'check-square': CheckSquare,
  presentation: Presentation,
  brain: Brain,
  archive: Archive,
  'volume-2': Volume2,
  triangle: Triangle,
  trello: Trello,
  plug: Plug,
  search: Search,
  activity: Activity,
  figma: Figma,
  'building-2': Building2,
  'map-pin': MapPin,
  megaphone: Megaphone,
  'shopping-bag': ShoppingBag,
  'shield-check': ShieldCheck,
  'user-search': UserSearch,
  n8n: N8nIcon,
};

/**
 * Get the Lucide icon component for a connector icon string.
 * Falls back to Plug icon if not found.
 */
export function getConnectorIcon(iconName: string | undefined): LucideIcon {
  if (!iconName) return Plug;
  return ICON_MAP[iconName] ?? Plug;
}

interface CategoryColors {
  bg: string;
  border: string;
  hoverBg: string;
  hoverBorder: string;
  iconColor: string;
}

/**
 * Neutral color palette for all connectors.
 * 
 * DESIGN DECISION: All categories use the same neutral color to reduce visual noise.
 * The connector name and status indicator provide sufficient differentiation.
 * Category-based coloring was permanently removed because:
 * - Users couldn't learn the color-to-category mapping
 * - Rainbow of colors created visual chaos
 * - Status (connected/error) should be the most prominent visual signal
 */
const NEUTRAL_COLORS: CategoryColors = {
  bg: 'rgba(148, 163, 184, 0.06)',
  border: 'rgba(148, 163, 184, 0.12)',
  hoverBg: 'rgba(148, 163, 184, 0.12)',
  hoverBorder: 'rgba(148, 163, 184, 0.20)',
  iconColor: 'var(--color-muted-foreground)',
};

/**
 * Get the color configuration for a category.
 * Returns neutral colors for all categories (category colors permanently removed).
 */
export function getCategoryColors(_category: string | undefined): CategoryColors {
  return NEUTRAL_COLORS;
}

/**
 * Category icon mapping - representative icons for each category.
 * Used in category headers and connected chips for visual consistency.
 */
const CATEGORY_ICONS: Record<ConnectorCategory, LucideIcon> = {
  productivity: CheckSquare,
  communication: MessageSquare,
  development: Code2,
  analytics: BarChart2,
  design: Palette,
  storage: HardDrive,
  media: Video,
  sales: Target,
  payments: CreditCard,
  automation: Zap,
  research: Search,
  other: Plug,
};

/**
 * Get the icon for a category.
 * Falls back to Plug icon for unknown categories.
 */
export function getCategoryIcon(category: string | undefined): LucideIcon {
  if (!category) return CATEGORY_ICONS.other;
  return CATEGORY_ICONS[category as ConnectorCategory] ?? CATEGORY_ICONS.other;
}

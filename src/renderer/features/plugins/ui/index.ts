/**
 * Plugin UI Components
 *
 * Themed wrappers around `@renderer/components/ui` for plugin authors.
 * These are registered as `@rebel/plugin-ui` in the module registry.
 *
 * Plugins import like: `import { Card, Button, Stack } from '@rebel/plugin-ui'`
 *
 * @see docs/plans/260322_plugin_extension_system.md — Stage 13
 */

export { Button, type PluginButtonProps } from './PluginButton';
export { Card, type PluginCardProps } from './PluginCard';
export { Input, type PluginInputProps } from './PluginInput';
export { Stack, type PluginStackProps } from './PluginStack';
export { Badge, type PluginBadgeProps } from './PluginBadge';
export { Textarea, type PluginTextareaProps } from './PluginTextarea';
export { LoadingCard } from './LoadingCard';
export { ErrorCard, type PluginErrorCardProps } from './ErrorCard';
export {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  type PluginTabsProps,
  type PluginTabsListProps,
  type PluginTabsTriggerProps,
  type PluginTabsContentProps,
} from './PluginTabs';
export { Select, type PluginSelectProps } from './PluginSelect';
export {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
  type PluginDialogProps,
  type PluginDialogContentProps,
  type PluginDialogHeaderProps,
  type PluginDialogTitleProps,
  type PluginDialogDescriptionProps,
  type PluginDialogBodyProps,
  type PluginDialogFooterProps,
} from './PluginDialog';
export {
  BarChart,
  type PluginBarChartProps,
  type PluginBarChartDatum,
} from './PluginBarChart';
export {
  LineChart,
  type PluginLineChartProps,
  type PluginLineChartDatum,
} from './PluginLineChart';
export {
  PieChart,
  type PluginPieChartProps,
  type PluginPieChartDatum,
} from './PluginPieChart';
export {
  DataTable,
  type PluginDataTableProps,
  type PluginDataTableColumn,
  type PluginDataTableRow,
} from './PluginDataTable';
export { IframeView, type PluginIframeViewProps } from './PluginIframeView';

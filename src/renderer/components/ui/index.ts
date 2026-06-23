/**
 * UI Components
 *
 * ShadCN-based primitives themed to match Mindstone Rebel's design system.
 * All components use design tokens from styles/foundations/tokens.css.
 *
 * @example
 * import { Button, Dialog, Input, Tabs } from '@renderer/components/ui';
 */

export { Button, type ButtonProps } from './Button';
export { IconButton, type IconButtonProps } from './IconButton';
export { IconTile, type IconTileProps, type IconTileTone } from './IconTile';
export { ConversationPill, type ConversationPillProps } from './ConversationPill';
export { DecisionCardGroup, type DecisionCardGroupProps, type DecisionCardOption } from './DecisionCardGroup';
export { PageHeader, type PageHeaderProps } from './PageHeader';
export { SectionHeader, type SectionHeaderProps } from './SectionHeader';

export {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
  type DialogProps,
  type DialogContentProps,
  type DialogHeaderProps
} from './Dialog';

export { Input, Textarea, Label, type InputProps, type TextareaProps } from './Input';
export { Toggle, type ToggleProps } from './Toggle';
export { InlineToggle, type InlineToggleProps } from './InlineToggle';

export { Select, SelectGroup, type SelectProps, type SelectGroupProps } from './Select';

export { RichSelect, type RichSelectProps, type RichSelectOption } from './RichSelect';

export {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  type TabsProps,
  type TabsListProps,
  type TabsTriggerProps,
  type TabsContentProps
} from './Tabs';

export {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  type CardProps
} from './Card';

export { Badge, type BadgeProps } from './Badge';
export { BillingBadge, type BillingBadgeProps } from './BillingBadge';

export {
  ToastProvider,
  useToast,
  type ToastProps,
  type ToastVariant
} from './Toast';

export { Tooltip, type TooltipProps, type TooltipPlacement } from './Tooltip';
export { FileLocationBadge, type FileLocationBadgeProps } from './FileLocationBadge';

export { ThemeToggle, type ThemeToggleProps } from './ThemeToggle';

export { Spinner, type SpinnerProps, type SpinnerSize } from './Spinner';
export {
  RebelLoadingIndicator,
  type RebelLoadingIndicatorLayout,
  type RebelLoadingIndicatorMotion,
  type RebelLoadingIndicatorProps,
  type RebelLoadingIndicatorSize
} from './RebelLoadingIndicator';

export { SplitButton, type SplitButtonProps, type DropdownItem } from './SplitButton';

export { PrivacyIndicator, type PrivacyIndicatorProps } from './PrivacyIndicator';

export { MaturityBadge, type MaturityBadgeProps, type MaturityLevel } from './MaturityBadge';

export {
  Notice,
  type NoticeProps,
  type NoticeAction,
  type NoticeTone,
  type NoticeDensity,
  type NoticePlacement
} from './Notice';

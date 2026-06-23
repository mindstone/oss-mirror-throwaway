/**
 * Plugin Tabs
 *
 * Simplified wrappers around `@renderer/components/ui/Tabs` for use by plugins.
 * Exposes a curated subset of props so plugin authors don't need internal knowledge.
 *
 * @see docs/plans/260325_sources_plugin_and_api_extensions.md — Stage 6
 */

import type { ReactNode } from 'react';
import {
  Tabs as UiTabs,
  TabsList as UiTabsList,
  TabsTrigger as UiTabsTrigger,
  TabsContent as UiTabsContent,
} from '@renderer/components/ui';

export interface PluginTabsProps {
  defaultValue?: string;
  value?: string;
  onValueChange?: (value: string) => void;
  children?: ReactNode;
}

export function Tabs({ defaultValue, value, onValueChange, children }: PluginTabsProps) {
  return (
    <UiTabs defaultValue={defaultValue} value={value} onValueChange={onValueChange}>
      {children}
    </UiTabs>
  );
}

export interface PluginTabsListProps {
  children?: ReactNode;
  variant?: 'default' | 'pills' | 'underline';
}

export function TabsList({ children, variant }: PluginTabsListProps) {
  return <UiTabsList variant={variant}>{children}</UiTabsList>;
}

export interface PluginTabsTriggerProps {
  value: string;
  children?: ReactNode;
}

export function TabsTrigger({ value, children }: PluginTabsTriggerProps) {
  return <UiTabsTrigger value={value}>{children}</UiTabsTrigger>;
}

export interface PluginTabsContentProps {
  value: string;
  children?: ReactNode;
}

export function TabsContent({ value, children }: PluginTabsContentProps) {
  return <UiTabsContent value={value}>{children}</UiTabsContent>;
}

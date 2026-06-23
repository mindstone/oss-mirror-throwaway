/**
 * Plugin Dialog
 *
 * Simplified wrappers around `@renderer/components/ui/Dialog` for use by plugins.
 * Exposes a curated subset of props so plugin authors don't need internal knowledge.
 *
 * @see docs/plans/260325_sources_plugin_and_api_extensions.md — Stage 6
 */

import type { ReactNode } from 'react';
import {
  Dialog as UiDialog,
  DialogContent as UiDialogContent,
  DialogHeader as UiDialogHeader,
  DialogTitle as UiDialogTitle,
  DialogDescription as UiDialogDescription,
  DialogBody as UiDialogBody,
  DialogFooter as UiDialogFooter,
} from '@renderer/components/ui';

export interface PluginDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children?: ReactNode;
}

export function Dialog({ open, onOpenChange, children }: PluginDialogProps) {
  return (
    <UiDialog open={open} onOpenChange={onOpenChange}>
      {children}
    </UiDialog>
  );
}

export interface PluginDialogContentProps {
  children?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

export function DialogContent({ children, size }: PluginDialogContentProps) {
  return <UiDialogContent size={size}>{children}</UiDialogContent>;
}

export interface PluginDialogHeaderProps {
  children?: ReactNode;
  onClose?: () => void;
}

export function DialogHeader({ children, onClose }: PluginDialogHeaderProps) {
  return <UiDialogHeader onClose={onClose}>{children}</UiDialogHeader>;
}

export interface PluginDialogTitleProps {
  children?: ReactNode;
}

export function DialogTitle({ children }: PluginDialogTitleProps) {
  return <UiDialogTitle>{children}</UiDialogTitle>;
}

export interface PluginDialogDescriptionProps {
  children?: ReactNode;
}

export function DialogDescription({ children }: PluginDialogDescriptionProps) {
  return <UiDialogDescription>{children}</UiDialogDescription>;
}

export interface PluginDialogBodyProps {
  children?: ReactNode;
}

export function DialogBody({ children }: PluginDialogBodyProps) {
  return <UiDialogBody>{children}</UiDialogBody>;
}

export interface PluginDialogFooterProps {
  children?: ReactNode;
}

export function DialogFooter({ children }: PluginDialogFooterProps) {
  return <UiDialogFooter>{children}</UiDialogFooter>;
}

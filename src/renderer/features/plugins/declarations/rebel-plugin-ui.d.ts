/**
 * Type declarations for the @rebel/plugin-ui module.
 *
 * These types describe the themed UI components available to plugins.
 * Used by the LLM for code generation context and by IDE autocompletion.
 *
 * IMPORTANT: Keep in sync with src/renderer/features/plugins/ui/*.tsx.
 *
 * @see src/renderer/features/plugins/ui/ — implementations
 */

declare module '@rebel/plugin-ui' {
  import type { ReactNode, ChangeEvent } from 'react';

  export function Button(props: {
    children?: ReactNode;
    onClick?: () => void;
    variant?: 'default' | 'secondary' | 'ghost' | 'destructive';
    disabled?: boolean;
  }): JSX.Element;

  export function Card(props: {
    children?: ReactNode;
    onClick?: () => void;
    className?: string;
  }): JSX.Element;

  export function Input(props: {
    value?: string;
    onChange?: (e: ChangeEvent<HTMLInputElement>) => void;
    onKeyDown?: (e: import('react').KeyboardEvent) => void;
    placeholder?: string;
    disabled?: boolean;
    type?: string;
  }): JSX.Element;

  export function Stack(props: {
    children?: ReactNode;
    gap?: 'sm' | 'md' | 'lg';
    direction?: 'column' | 'row';
  }): JSX.Element;

  export function Badge(props: {
    children?: ReactNode;
    variant?: 'default' | 'secondary' | 'destructive' | 'outline';
  }): JSX.Element;

  export function Textarea(props: {
    value?: string;
    onChange?: (e: ChangeEvent<HTMLTextAreaElement>) => void;
    placeholder?: string;
    disabled?: boolean;
    rows?: number;
  }): JSX.Element;

  export function LoadingCard(): JSX.Element;

  export function ErrorCard(props: {
    title?: string;
    message?: string;
  }): JSX.Element;

  // ── Tabs ─────────────────────────────────────────────────────────────

  export function Tabs(props: {
    defaultValue?: string;
    value?: string;
    onValueChange?: (value: string) => void;
    children?: ReactNode;
  }): JSX.Element;

  export function TabsList(props: {
    children?: ReactNode;
    variant?: 'default' | 'pills' | 'underline';
  }): JSX.Element;

  export function TabsTrigger(props: {
    value: string;
    children?: ReactNode;
  }): JSX.Element;

  export function TabsContent(props: {
    value: string;
    children?: ReactNode;
  }): JSX.Element;

  // ── Select ───────────────────────────────────────────────────────────

  export function Select(props: {
    value?: string;
    onChange?: (e: ChangeEvent<HTMLSelectElement>) => void;
    children?: ReactNode;
    disabled?: boolean;
  }): JSX.Element;

  // ── Dialog ───────────────────────────────────────────────────────────

  export function Dialog(props: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children?: ReactNode;
  }): JSX.Element;

  export function DialogContent(props: {
    children?: ReactNode;
    size?: 'sm' | 'md' | 'lg';
  }): JSX.Element;

  export function DialogHeader(props: {
    children?: ReactNode;
    onClose?: () => void;
  }): JSX.Element;

  export function DialogTitle(props: { children?: ReactNode }): JSX.Element;

  export function DialogDescription(props: { children?: ReactNode }): JSX.Element;

  export function DialogBody(props: { children?: ReactNode }): JSX.Element;

  export function DialogFooter(props: { children?: ReactNode }): JSX.Element;

  // ── Rich visualization ───────────────────────────────────────────────

  export function BarChart(props: {
    data: { label: string; value: number; color?: string }[];
    height?: number;
    showLabels?: boolean;
  }): JSX.Element;

  export function LineChart(props: {
    data: { label: string; value: number }[];
    height?: number;
    showDots?: boolean;
    color?: string;
  }): JSX.Element;

  export function PieChart(props: {
    data: { label: string; value: number; color?: string }[];
    size?: number;
    showLabels?: boolean;
  }): JSX.Element;

  export function DataTable(props: {
    columns: { key: string; label: string; sortable?: boolean }[];
    rows: Record<string, string | number>[];
    pageSize?: number;
  }): JSX.Element;

  export function IframeView(props: {
    html: string;
    height?: number | string;
    onMessage?: (data: unknown) => void;
  }): JSX.Element;
}

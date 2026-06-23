import { Loader2 } from 'lucide-react';
import { cn } from '@renderer/lib/utils';

export type SpinnerSize = 'xs' | 'sm' | 'md' | 'lg';

export interface SpinnerProps {
  size?: SpinnerSize;
  className?: string;
  label?: string;
  decorative?: boolean;
}

const sizeMap: Record<SpinnerSize, number> = {
  xs: 12,
  sm: 14,
  md: 20,
  lg: 32
};

export function Spinner({ size = 'md', className, label, decorative = false }: SpinnerProps) {
  return (
    <div
      className={cn('inline-flex items-center gap-2', className)}
      role={decorative ? undefined : 'status'}
      aria-label={decorative ? undefined : label ?? 'Loading'}
      aria-hidden={decorative ? true : undefined}
    >
      <Loader2 size={sizeMap[size]} className="animate-spin" />
      {label && <span className="text-sm text-muted-foreground">{label}</span>}
    </div>
  );
}

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';
import './Button.css';

const buttonVariants = cva(
  'btn-shimmer inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-medium cursor-pointer transition-all duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed [border-radius:12px] active:scale-[0.98] [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default:
          'btn-default bg-primary text-primary-foreground hover:bg-[#7c3aed] hover:border-[color:color-mix(in_srgb,var(--color-primary)_75%,white)]',
        secondary:
          'btn-secondary border border-transparent bg-[rgba(99,102,241,0.10)] text-[#818cf8] hover:bg-[rgba(99,102,241,0.18)] hover:border-transparent hover:text-[#a5b4fc]',
        destructive:
          'btn-destructive bg-[color:color-mix(in_srgb,var(--color-destructive)_84%,transparent)] text-white border border-[color:color-mix(in_srgb,var(--color-destructive)_88%,transparent)] hover:bg-[color:color-mix(in_srgb,var(--color-destructive)_100%,transparent)] hover:border-[color:color-mix(in_srgb,var(--color-destructive)_100%,white)]',
        ghost:
          'btn-shimmer-subtle btn-ghost bg-transparent text-foreground hover:bg-[rgba(139,92,246,0.16)] hover:text-white',
        outline:
          'btn-shimmer-subtle btn-outline border border-[color:color-mix(in_srgb,var(--color-border)_78%,transparent)] bg-[color:color-mix(in_srgb,var(--color-background)_94%,transparent)] text-[color:var(--color-muted-foreground)] hover:bg-[rgba(139,92,246,0.10)] hover:text-foreground hover:border-[rgba(139,92,246,0.30)]'
      },
      size: {
        default: 'h-10 px-4 py-2 [&_svg]:size-4',
        xxs: 'h-6 [border-radius:6px] gap-1 px-2 text-[0.68rem] [&_svg]:size-2.5',
        xs: 'h-7 [border-radius:6px] gap-1.5 px-2.5 text-xs [&_svg]:size-3',
        sm: 'h-8 [border-radius:8px] gap-1.5 px-3 text-xs [&_svg]:size-3.5',
        lg: 'h-12 px-8 text-base [&_svg]:size-4',
        icon: 'h-10 w-10'
      }
    },
    defaultVariants: {
      variant: 'default',
      size: 'default'
    }
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return (
      <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
    );
  }
);
Button.displayName = 'Button';



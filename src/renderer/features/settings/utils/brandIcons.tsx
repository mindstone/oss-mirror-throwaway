import { forwardRef, type SVGAttributes } from 'react';
import type { LucideIcon } from 'lucide-react';

import n8nSvgUrl from '@renderer/assets/brand/n8n.svg';

interface BrandIconProps extends Omit<SVGAttributes<SVGSVGElement>, 'children'> {
  size?: number | string;
  strokeWidth?: number | string;
  color?: string;
}

const makeBrandIcon = (src: string, displayName: string): LucideIcon => {
  const Icon = forwardRef<SVGSVGElement, BrandIconProps>(({ size = 24, className, color, style }, _ref) => {
    const dimension = typeof size === 'number' ? `${size}px` : size;
    return (
      <img
        src={src}
        width={dimension}
        height={dimension}
        className={className}
        alt=""
        aria-hidden="true"
        style={{
          objectFit: 'contain',
          display: 'inline-block',
          color,
          ...style,
        }}
      />
    );
  });
  Icon.displayName = displayName;
  return Icon as unknown as LucideIcon;
};

export const N8nIcon = makeBrandIcon(n8nSvgUrl, 'N8nIcon');

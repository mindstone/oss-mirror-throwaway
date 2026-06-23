import { useEffect, type ReactNode } from 'react';

export type BtsTaskOverridesStoryTheme = 'light' | 'dark';

export function BtsTaskOverridesStoryBodyTheme({
  theme,
  children,
}: {
  theme: BtsTaskOverridesStoryTheme;
  children: ReactNode;
}) {
  useEffect(() => {
    document.body.classList.remove(theme === 'light' ? 'dark' : 'light');
    document.body.classList.add(theme);
    return () => {
      document.body.classList.remove(theme);
    };
  }, [theme]);

  return (
    <div
      className={theme}
      style={{
        background: 'var(--color-background)',
        color: 'var(--color-text-primary)',
        padding: 16,
      }}
    >
      {children}
    </div>
  );
}

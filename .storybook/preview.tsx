import * as React from 'react';
import type { Decorator, Preview } from '@storybook/react';
import { themes } from '@storybook/theming';
import '../src/renderer/styles/index.css';

const withRebelTheme: Decorator = (Story, context) => {
  const theme = context.globals.theme ?? 'dark';

  if (typeof document !== 'undefined') {
    document.documentElement.classList.remove('light', 'dark');
    document.body.classList.remove('light', 'dark');
    document.documentElement.classList.add(theme);
    document.body.classList.add(theme);
    document.documentElement.style.height = 'auto';
    document.documentElement.style.overflow = 'auto';
    document.body.style.background = theme === 'dark' ? '#0b1020' : '#f4f7fb';
    document.body.style.color = 'var(--color-text-primary)';
    document.body.style.fontFamily = 'var(--font-family-sans)';
    document.body.style.margin = '0';
    document.body.style.height = 'auto';
    document.body.style.minHeight = '100vh';
    document.body.style.overflow = 'auto';
  }

  return (
    <div
      className={theme}
      style={{
        minHeight: '100vh',
        padding: '24px',
        background:
          theme === 'dark'
            ? 'radial-gradient(circle at top left, rgba(139,92,246,0.14), transparent 30%), #0b1020'
            : 'radial-gradient(circle at top left, rgba(139,92,246,0.08), transparent 30%), #f4f7fb',
        color: 'var(--color-text-primary)',
      }}
    >
      <Story />
    </div>
  );
};

const preview: Preview = {
  decorators: [withRebelTheme],
  globalTypes: {
    theme: {
      description: 'Global theme for component previews',
      toolbar: {
        title: 'Theme',
        icon: 'mirror',
        items: [
          { value: 'dark', title: 'Dark' },
          { value: 'light', title: 'Light' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: {
    theme: 'dark',
  },
  parameters: {
    layout: 'fullscreen',
    controls: {
      expanded: true,
    },
    options: {
      storySort: {
        // FOX-3131 Stage 1: `Start Here` is the editorial landing page
        // and `Registry` is the map of every family. Everything else
        // under `Design System/` sorts after them in the natural order
        // Storybook picks.
        order: ['Design System', ['Start Here', 'Registry', '*']],
      },
    },
    backgrounds: {
      disable: true,
    },
    docs: {
      theme: themes.dark,
    },
  },
};

export default preview;

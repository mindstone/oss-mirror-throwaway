import { resolve } from 'node:path';
import { mergeConfig, type UserConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import type { StorybookConfig } from '@storybook/react-vite';

import { buildStorybookStoriesGlob } from '../scripts/storybookManifestContract';
import { RENDERER_SINGLETON_DEPS } from '../scripts/renderer-singleton-deps.mjs';

const rootDir = resolve(__dirname, '..');

const config: StorybookConfig = {
  // The stories glob is derived from the shared contract helper so
  // Storybook discovery and the Stage-0 anti-drift guard cannot
  // silently diverge about which files count as stories. See
  // `scripts/storybookManifestContract.ts` for the canonical surface.
  stories: [buildStorybookStoriesGlob(__dirname)],
  addons: ['@storybook/addon-essentials', '@storybook/addon-a11y'],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  docs: {
    autodocs: 'tag',
  },
  async viteFinal(baseConfig) {
    return mergeConfig(baseConfig, {
      plugins: [tailwindcss()],
      resolve: {
        dedupe: [...RENDERER_SINGLETON_DEPS],
        alias: {
          '@rebel/shared': resolve(rootDir, 'packages/shared/src'),
          '@rebel/cloud-client': resolve(rootDir, 'cloud-client/src'),
          '@renderer': resolve(rootDir, 'src/renderer'),
          '@shared': resolve(rootDir, 'src/shared'),
          '@core': resolve(rootDir, 'src/core'),
          '@': resolve(rootDir, 'src/renderer'),
        },
      },
    } satisfies UserConfig);
  },
};

export default config;

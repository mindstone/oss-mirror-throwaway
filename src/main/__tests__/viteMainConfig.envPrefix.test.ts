import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ConfigEnv } from 'vite';
import { loadConfigFromFile } from 'vite';

describe('Forge main Vite config env exposure', () => {
  it('exposes MAIN_VITE_* only through the main bundle config', async () => {
    const root = process.cwd();
    const configPath = path.resolve(root, 'vite.main.config.mjs');
    const forgeConfig: ConfigEnv['forgeConfig'] = {
      build: [
        {
          entry: 'src/main/bootstrap.ts',
          config: 'vite.main.config.mjs',
          target: 'main',
        },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.mjs' }],
      concurrent: 2,
    };
    const forgeConfigSelf = forgeConfig.build[0];
    if (!forgeConfigSelf) {
      throw new Error('Forge main build config fixture is missing');
    }

    const loaded = await loadConfigFromFile(
      {
        command: 'build',
        mode: 'production',
        root,
        forgeConfig,
        forgeConfigSelf,
      },
      configPath,
    );

    const envPrefix = loaded?.config.envPrefix;
    expect(Array.isArray(envPrefix)).toBe(true);
    expect(envPrefix).toContain('VITE_');
    expect(envPrefix).toContain('MAIN_VITE_');
    expect(envPrefix).not.toContain('');
  });
});

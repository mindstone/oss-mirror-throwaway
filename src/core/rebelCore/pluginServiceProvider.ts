import type { PluginService } from './types';

let pluginService: PluginService | undefined;

export const setBuiltinPluginService = (service: PluginService | undefined): void => {
  pluginService = service;
};

export const getBuiltinPluginService = (): PluginService | undefined => pluginService;

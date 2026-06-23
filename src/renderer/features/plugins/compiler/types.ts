export interface PluginCompileError {
  type: 'compile' | 'validation' | 'runtime';
  message: string;
  line?: number;
  column?: number;
  snippet?: string;
  fullSource: string;
}

export interface PluginCompileWarning {
  type: string;
  message: string;
}

export type PluginCompileResult =
  | { ok: true; code: string; warnings?: PluginCompileWarning[] }
  | { ok: false; errors: PluginCompileError[] };

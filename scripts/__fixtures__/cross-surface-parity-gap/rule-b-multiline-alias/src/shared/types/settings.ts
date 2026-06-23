export type ActiveProvider =
  | 'anthropic'
  | 'codex';

export type AppSettings = {
  coreDirectory: string | null;
  cloudInstance: string | null;
  activeProvider?: ActiveProvider;
};

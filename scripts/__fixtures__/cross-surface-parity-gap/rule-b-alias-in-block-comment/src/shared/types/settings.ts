/*
export type FakeAlias = 'anthropic' | 'codex';
*/

export type AppSettings = {
  coreDirectory: string | null;
  cloudInstance: string | null;
  activeProvider?: string;
  someProvider?: FakeAlias;
};

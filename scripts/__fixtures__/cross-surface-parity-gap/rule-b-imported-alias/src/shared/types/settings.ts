import type { X } from './foo';

export type AppSettings = {
  coreDirectory: string | null;
  cloudInstance: string | null;
  activeProvider?: X;
};

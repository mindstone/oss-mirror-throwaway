export type AppSettings = {
  coreDirectory: string | null;
  cloudInstance: string | null;
  activeProvider?: string;
  // CROSS_SURFACE_PARITY_EXEMPT: Desktop-only TODO add the real reason for this exemption
  someProvider?: 'a' | 'b';

};

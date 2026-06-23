export type AppSettings = {
  coreDirectory: string | null;
  cloudInstance: string | null;
  activeProvider?: string;
  // CROSS_SURFACE_PARITY_EXEMPT: intentionally local-only test fixture
  someProvider?: 'a' | 'b';

};

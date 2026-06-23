declare module 'graceful-fs' {
  import type fs from 'node:fs';
  const gracefulFs: typeof fs & {
    gracefulify(fsModule: typeof fs): void;
  };
  export default gracefulFs;
}

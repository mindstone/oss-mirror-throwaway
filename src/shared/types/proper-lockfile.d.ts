declare module 'proper-lockfile' {
  export interface LockOptions {
    stale?: number;
    update?: number;
    retries?: number | {
      retries?: number;
      minTimeout?: number;
      maxTimeout?: number;
      factor?: number;
    };
    lockfilePath?: string;
    realpath?: boolean;
    onCompromised?: (err: Error) => void;
  }

  export type Release = () => Promise<void>;

  export function lock(file: string, options?: LockOptions): Promise<Release>;
  export function unlock(file: string, options?: { realpath?: boolean }): Promise<void>;
  export function check(file: string, options?: LockOptions): Promise<boolean>;
  export function lockSync(file: string, options?: LockOptions): Release;
  export function unlockSync(file: string, options?: { realpath?: boolean }): void;
  export function checkSync(file: string, options?: LockOptions): boolean;

  const properLockfile: {
    lock: typeof lock;
    unlock: typeof unlock;
    check: typeof check;
    lockSync: typeof lockSync;
    unlockSync: typeof unlockSync;
    checkSync: typeof checkSync;
  };
  export default properLockfile;
}

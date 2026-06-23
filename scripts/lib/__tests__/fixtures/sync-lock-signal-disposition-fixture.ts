/**
 * Fixture for the signal-disposition regression test (Phase-6 GPT F1):
 * installs the scoped lock-wait signal handlers, immediately uninstalls them
 * (as git-safe-sync does after acquisition), prints READY, then blocks in a
 * synchronous child section. A SIGTERM delivered now must KILL the process
 * via the restored default disposition — if the uninstall failed to restore
 * it, the signal would be swallowed (handler can't run during spawnSync) and
 * the process would survive to exit 0, or the handler would fire (exit 99).
 */
import { spawnSync } from 'node:child_process';
import { installLockWaitSignalHandlers } from '../../same-host-sync-lock';

const uninstall = installLockWaitSignalHandlers(() => {
  process.stdout.write('HANDLER_RAN\n');
  process.exit(99);
});
uninstall();
process.stdout.write('READY\n');
spawnSync('sleep', ['8'], { stdio: 'ignore' }); // simulated synchronous child section
process.exit(0);

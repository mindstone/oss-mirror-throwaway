import {
  configureCliPlatformDeps,
  initCliRuntime,
  parseCliFlagsBeforeRuntime,
  runCli,
} from '@core/cli/runCli';
import { loadAttachmentsFromPaths } from './utils/cliAttachments';
import { createCliApprovalHandler } from './cli/ttyApprovalPrompt';
import { startMcpServer } from './mcpServer';

configureCliPlatformDeps({
  loadAttachmentsFromPaths,
  createCliApprovalHandler,
  startMcpServer,
});

export {
  initCliRuntime,
  parseCliFlagsBeforeRuntime,
  runCli,
};

import { workspaceAccessStateFromErrno, type WorkspaceAccessState } from '@shared/workspace/workspaceAccessState';
import { assertNever } from '@shared/utils/assertNever';

export interface WorkspaceRecoveryDialogDescriptor {
  state: WorkspaceAccessState;
  title: string;
  message: string;
  detail: string;
}

function workspaceNotFoundDescriptor(
  state: WorkspaceAccessState,
  configuredWorkspace: string,
): WorkspaceRecoveryDialogDescriptor {
  return {
    state,
    title: 'Workspace Not Found',
    message: 'Your workspace folder could not be found',
    detail: `Expected: ${configuredWorkspace}\n\nThis can happen if the folder was moved, renamed, or if an external drive was disconnected.`,
  };
}

export function workspaceStartupRecoveryDescriptor(
  errnoCode: string | undefined,
  configuredWorkspace: string,
): WorkspaceRecoveryDialogDescriptor {
  const state = workspaceAccessStateFromErrno(errnoCode);

  switch (state.status) {
    case 'denied':
      return {
        state,
        title: 'Workspace Access Denied',
        message: 'Your workspace folder cannot be accessed',
        detail: `Location: ${configuredWorkspace}\n\nYour organisation's security policy may be preventing access to this folder. Choose a different location, or ask your IT admin to allow Rebel access.`,
      };
    case 'missing':
      return workspaceNotFoundDescriptor(state, configuredWorkspace);
    case 'accessible':
    case 'invalid':
      return workspaceNotFoundDescriptor(state, configuredWorkspace);
    default:
      return assertNever(state, 'workspaceStartupRecoveryDescriptor');
  }
}

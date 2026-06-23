import { describe, expect, it } from 'vitest';
import { workspaceStartupRecoveryDescriptor } from '../workspaceStartupRecovery';

describe('workspaceStartupRecoveryDescriptor', () => {
  it('maps EACCES to access-denied copy', () => {
    const descriptor = workspaceStartupRecoveryDescriptor('EACCES', '/ws');

    expect(descriptor.state.status).toBe('denied');
    expect(descriptor.title).toBe('Workspace Access Denied');
    expect(descriptor.detail).toContain('security policy');
    expect(descriptor.detail).toContain('/ws');
  });

  it('maps EPERM to access-denied copy', () => {
    const descriptor = workspaceStartupRecoveryDescriptor('EPERM', '/ws');

    expect(descriptor.state.status).toBe('denied');
    expect(descriptor.title).toBe('Workspace Access Denied');
    expect(descriptor.detail).toContain('security policy');
    expect(descriptor.detail).toContain('/ws');
  });

  it('maps ENOENT to workspace-not-found copy', () => {
    const descriptor = workspaceStartupRecoveryDescriptor('ENOENT', '/ws');

    expect(descriptor.state.status).toBe('missing');
    expect(descriptor.title).toBe('Workspace Not Found');
    expect(descriptor.detail).toContain('moved, renamed');
    expect(descriptor.detail).toContain('/ws');
  });

  it('maps undefined errno to workspace-not-found copy', () => {
    const descriptor = workspaceStartupRecoveryDescriptor(undefined, '/ws');

    expect(descriptor.state.status).toBe('missing');
    expect(descriptor.title).toBe('Workspace Not Found');
    expect(descriptor.detail).toContain('/ws');
  });

  it('maps unknown errno to workspace-not-found copy', () => {
    const descriptor = workspaceStartupRecoveryDescriptor('EBUSY', '/ws');

    expect(descriptor.state.status).toBe('missing');
    expect(descriptor.title).toBe('Workspace Not Found');
    expect(descriptor.detail).toContain('/ws');
  });
});

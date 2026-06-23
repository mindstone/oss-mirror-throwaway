import { describe, expect, it } from 'vitest';
import {
  getFolderPinnedState,
  getFolderSessionIdsToSetActiveState,
  type FolderSessionStateEntry,
} from '../folderSessionState';

const makeEntry = (
  id: string,
  overrides: Partial<FolderSessionStateEntry> = {},
): FolderSessionStateEntry => ({
  id,
  isActive: true,
  isDeleted: false,
  ...overrides,
});

describe('folderSessionState', () => {
  it('reports empty when the folder has no live conversations', () => {
    const entries = [makeEntry('s1')];
    expect(getFolderPinnedState(entries, {}, 'folder-1')).toBe('empty');
  });

  it('reports active when all live folder conversations are active', () => {
    const entries = [makeEntry('s1'), makeEntry('s2')];
    const membership = { s1: 'folder-1', s2: 'folder-1' };
    expect(getFolderPinnedState(entries, membership, 'folder-1')).toBe('active');
  });

  it('reports done when all live folder conversations are done', () => {
    const entries = [makeEntry('s1', { isActive: false }), makeEntry('s2', { isActive: false })];
    const membership = { s1: 'folder-1', s2: 'folder-1' };
    expect(getFolderPinnedState(entries, membership, 'folder-1')).toBe('done');
  });

  it('reports mixed when folder conversations do not share one pinned state', () => {
    const entries = [makeEntry('s1', { isActive: true }), makeEntry('s2', { isActive: false })];
    const membership = { s1: 'folder-1', s2: 'folder-1' };
    expect(getFolderPinnedState(entries, membership, 'folder-1')).toBe('mixed');
  });

  it('ignores deleted conversations when deriving folder state', () => {
    const entries = [
      makeEntry('s1', { isActive: true }),
      makeEntry('s2', { isActive: false, isDeleted: true }),
    ];
    const membership = { s1: 'folder-1', s2: 'folder-1' };
    expect(getFolderPinnedState(entries, membership, 'folder-1')).toBe('active');
  });

  it('ignores background conversations when deriving folder state', () => {
    const entries = [
      makeEntry('automation-source-capture--run-1', { isActive: false }),
      makeEntry('conversation-1', { isActive: true }),
      makeEntry('meeting-analysis--run-1', { isActive: false }),
    ];
    const membership = {
      'automation-source-capture--run-1': 'folder-1',
      'conversation-1': 'folder-1',
      'meeting-analysis--run-1': 'folder-1',
    };

    expect(getFolderPinnedState(entries, membership, 'folder-1')).toBe('active');
  });

  it('reports empty when a folder contains only background conversations', () => {
    const entries = [
      makeEntry('automation-source-capture--run-1', { isActive: false }),
      makeEntry('use-case-discovery--run-1', { isActive: true }),
    ];
    const membership = {
      'automation-source-capture--run-1': 'folder-1',
      'use-case-discovery--run-1': 'folder-1',
    };

    expect(getFolderPinnedState(entries, membership, 'folder-1')).toBe('empty');
  });

  it('returns only sessions that need to change for a bulk pin-state update', () => {
    const entries = [
      makeEntry('s1', { isActive: true }),
      makeEntry('s2', { isActive: false }),
      makeEntry('s3', { isActive: false, isDeleted: true }),
      makeEntry('s4', { isActive: false }),
    ];
    const membership = {
      s1: 'folder-1',
      s2: 'folder-1',
      s3: 'folder-1',
      s4: 'folder-2',
    };

    expect(getFolderSessionIdsToSetActiveState(entries, membership, 'folder-1', false)).toEqual(['s1']);
    expect(getFolderSessionIdsToSetActiveState(entries, membership, 'folder-1', true)).toEqual(['s2']);
  });

  it('excludes background conversations from bulk pin-state updates', () => {
    const entries = [
      makeEntry('conversation-1', { isActive: false }),
      makeEntry('automation-source-capture--run-1', { isActive: false }),
      makeEntry('meeting-analysis--run-1', { isActive: false }),
      makeEntry('conversation-2', { isActive: true }),
    ];
    const membership = {
      'conversation-1': 'folder-1',
      'automation-source-capture--run-1': 'folder-1',
      'meeting-analysis--run-1': 'folder-1',
      'conversation-2': 'folder-1',
    };

    expect(getFolderSessionIdsToSetActiveState(entries, membership, 'folder-1', true)).toEqual(['conversation-1']);
    expect(getFolderSessionIdsToSetActiveState(entries, membership, 'folder-1', false)).toEqual(['conversation-2']);
  });
});

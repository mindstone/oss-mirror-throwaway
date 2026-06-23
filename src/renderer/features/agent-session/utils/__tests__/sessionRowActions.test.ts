import { describe, it, expect, vi } from 'vitest';
import {
  buildSessionRowActionsProps,
  type SessionRowActionsContext,
  type SessionRowActionsHandlers,
} from '../sessionRowActions';

function makeHandlers(): SessionRowActionsHandlers {
  return {
    onToggleStar: vi.fn(),
    onTogglePin: vi.fn(),
    onToggleCloudContinuity: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onFindSimilar: vi.fn(),
    onCopyMarkdown: vi.fn(),
    onExportMarkdown: vi.fn(),
    onCopyLink: vi.fn(),
    onShareConversation: vi.fn(),
    onDiagnose: vi.fn(),
    onExportLogs: vi.fn(),
    onMoveToFolder: vi.fn(),
    onRemoveFromFolder: vi.fn(),
  };
}

function makeCtx(overrides: Partial<SessionRowActionsContext> = {}): SessionRowActionsContext {
  return {
    sessionId: 's1',
    sessionTitle: 'Title',
    isActive: true,
    isStarred: false,
    isCloudActive: false,
    isInFolder: false,
    hasContinuityApi: true,
    isSearchContext: false,
    ...overrides,
  };
}

describe('buildSessionRowActionsProps', () => {
  it('active + not-in-folder + main (isSearchContext false): cloudToggle present, folder actions present', () => {
    const handlers = makeHandlers();
    const props = buildSessionRowActionsProps(
      makeCtx({ isActive: true, isInFolder: false, hasContinuityApi: true, isCloudActive: false }),
      handlers,
    );

    // cloudToggle present because hasContinuityApi && isActive
    expect(props.cloudToggle).toBeDefined();
    expect(props.cloudToggle?.isCloudActive).toBe(false);
    expect(props.cloudToggle?.onToggle).toBe(handlers.onToggleCloudContinuity);

    // identity pass-throughs
    expect(props.sessionId).toBe('s1');
    expect(props.sessionTitle).toBe('Title');
    expect(props.isCloudActive).toBe(false);
    expect(props.doneToggle).toEqual({ isActive: true, onToggle: handlers.onTogglePin });
    expect(props.star).toEqual({ isStarred: false, onToggle: handlers.onToggleStar });

    // menu has folder actions in non-search context
    expect('onMoveToFolder' in props.menu!).toBe(true);
    expect('onRemoveFromFolder' in props.menu!).toBe(true);
    expect(props.menu!.onMoveToFolder).toBe(handlers.onMoveToFolder);
    expect(props.menu!.onRemoveFromFolder).toBe(handlers.onRemoveFromFolder);

    // onShareConversation undefined because not cloud active; onToggleCloudContinuity present (active)
    expect(props.menu!.onShareConversation).toBeUndefined();
    expect(props.menu!.onToggleCloudContinuity).toBe(handlers.onToggleCloudContinuity);

    // isInFolder always set
    expect(props.menu!.isInFolder).toBe(false);
  });

  it('active + isCloudActive true: onShareConversation present', () => {
    const handlers = makeHandlers();
    const props = buildSessionRowActionsProps(makeCtx({ isCloudActive: true }), handlers);
    expect(props.menu!.onShareConversation).toBe(handlers.onShareConversation);
    expect(props.cloudToggle?.isCloudActive).toBe(true);
    expect(props.isCloudActive).toBe(true);
  });

  it('done (isActive false): cloudToggle undefined, menu.onToggleCloudContinuity undefined, doneToggle.isActive false', () => {
    const handlers = makeHandlers();
    const props = buildSessionRowActionsProps(makeCtx({ isActive: false }), handlers);
    expect(props.cloudToggle).toBeUndefined();
    expect(props.menu!.onToggleCloudContinuity).toBeUndefined();
    expect(props.doneToggle).toEqual({ isActive: false, onToggle: handlers.onTogglePin });
  });

  it('isCloudActive false: menu.onShareConversation undefined', () => {
    const handlers = makeHandlers();
    const props = buildSessionRowActionsProps(makeCtx({ isCloudActive: false }), handlers);
    expect(props.menu!.onShareConversation).toBeUndefined();
  });

  it('hasContinuityApi false: cloudToggle undefined even when active', () => {
    const handlers = makeHandlers();
    const props = buildSessionRowActionsProps(
      makeCtx({ hasContinuityApi: false, isActive: true }),
      handlers,
    );
    expect(props.cloudToggle).toBeUndefined();
    // menu.onToggleCloudContinuity still keyed on isActive only (matches original gating)
    expect(props.menu!.onToggleCloudContinuity).toBe(handlers.onToggleCloudContinuity);
  });

  it('isSearchContext true: menu has NO folder actions, but isInFolder still set', () => {
    const handlers = makeHandlers();
    const props = buildSessionRowActionsProps(
      makeCtx({ isSearchContext: true, isInFolder: true }),
      handlers,
    );
    expect('onMoveToFolder' in props.menu!).toBe(false);
    expect('onRemoveFromFolder' in props.menu!).toBe(false);
    expect(props.menu!.isInFolder).toBe(true);
  });

  it('star.onToggle and menu.onToggleStar are the SAME passed handler', () => {
    const handlers = makeHandlers();
    const props = buildSessionRowActionsProps(makeCtx(), handlers);
    expect(props.star!.onToggle).toBe(handlers.onToggleStar);
    expect(props.menu!.onToggleStar).toBe(handlers.onToggleStar);
    expect(props.star!.onToggle).toBe(props.menu!.onToggleStar);
  });

  it('background rows omit done/reopen affordances but keep star', () => {
    const handlers = makeHandlers();
    const props = buildSessionRowActionsProps(
      makeCtx({ sessionId: 'automation-source-capture--abc123', isActive: false, isStarred: true }),
      handlers,
    );

    expect(props.doneToggle).toBeUndefined();
    expect(props.menu!.onTogglePin).toBeUndefined();
    expect(props.star).toEqual({ isStarred: true, onToggle: handlers.onToggleStar });
    expect(props.menu!.onToggleStar).toBe(handlers.onToggleStar);
  });

  it('manual conversation rows keep done/reopen affordances and star', () => {
    const handlers = makeHandlers();
    const props = buildSessionRowActionsProps(
      makeCtx({ sessionId: 'conversation-abc123', isActive: false, isStarred: true }),
      handlers,
    );

    expect(props.doneToggle).toEqual({ isActive: false, onToggle: handlers.onTogglePin });
    expect(props.menu!.onTogglePin).toBe(handlers.onTogglePin);
    expect(props.star).toEqual({ isStarred: true, onToggle: handlers.onToggleStar });
  });

  it('non-search menu emits exactly the expected key set', () => {
    const handlers = makeHandlers();
    const props = buildSessionRowActionsProps(makeCtx({ isSearchContext: false }), handlers);
    expect(Object.keys(props.menu!).sort()).toEqual(
      [
        'onRename',
        'onDelete',
        'onFindSimilar',
        'onToggleStar',
        'onTogglePin',
        'onCopyMarkdown',
        'onExportMarkdown',
        'onCopyLink',
        'onShareConversation',
        'onDiagnose',
        'onExportLogs',
        'onToggleCloudContinuity',
        'onMoveToFolder',
        'onRemoveFromFolder',
        'isInFolder',
      ].sort(),
    );
  });

  it('search menu emits expected key set (no folder actions)', () => {
    const handlers = makeHandlers();
    const props = buildSessionRowActionsProps(makeCtx({ isSearchContext: true }), handlers);
    expect(Object.keys(props.menu!).sort()).toEqual(
      [
        'onRename',
        'onDelete',
        'onFindSimilar',
        'onToggleStar',
        'onTogglePin',
        'onCopyMarkdown',
        'onExportMarkdown',
        'onCopyLink',
        'onShareConversation',
        'onDiagnose',
        'onExportLogs',
        'onToggleCloudContinuity',
        'isInFolder',
      ].sort(),
    );
  });
});

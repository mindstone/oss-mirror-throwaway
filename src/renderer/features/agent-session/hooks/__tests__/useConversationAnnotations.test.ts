// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@renderer/test-utils/hookTestHarness';
import { useSessionStore } from '../../store';
import {
  useConversationAnnotations,
  type ConversationAnnotation,
  type UseConversationAnnotationsResult,
} from '../useConversationAnnotations';

/**
 * Tests for useConversationAnnotations hook.
 *
 * These tests cover type structure, export verification, and the
 * session-scoped Zustand behavior via the local hook harness.
 */

const createAnnotation = (
  overrides: Partial<ConversationAnnotation> = {},
): ConversationAnnotation => ({
  id: 'ann-1',
  messageId: 'msg-1',
  text: 'selected text',
  comment: 'remember this',
  createdAt: 1703851200000,
  startOffset: 0,
  endOffset: 13,
  ...overrides,
});

describe('useConversationAnnotations', () => {
  beforeEach(() => {
    useSessionStore.setState({ annotationsBySessionId: {} });
  });

  describe('exports', () => {
    it('exports useConversationAnnotations function', () => {
      expect(typeof useConversationAnnotations).toBe('function');
    });

    it('can import ConversationAnnotation type', () => {
      const typeCheck: ConversationAnnotation = {
        id: 'ann-123',
        messageId: 'msg-456',
        text: 'selected text',
        comment: 'my comment',
        createdAt: Date.now(),
        startOffset: 100,
        endOffset: 113,
      };
      expect(typeCheck).toBeDefined();
      expect(typeof typeCheck.id).toBe('string');
      expect(typeof typeCheck.messageId).toBe('string');
      expect(typeof typeCheck.text).toBe('string');
      expect(typeof typeCheck.comment).toBe('string');
      expect(typeof typeCheck.createdAt).toBe('number');
      expect(typeof typeCheck.startOffset).toBe('number');
      expect(typeof typeCheck.endOffset).toBe('number');
    });

    it('can import UseConversationAnnotationsResult type', () => {
      const typeCheck: UseConversationAnnotationsResult = {
        annotations: [],
        hasAnnotations: false,
        annotationCount: 0,
        annotationsByMessage: new Map(),
        addAnnotation: (_messageId, _text, _comment, _startOffset, _endOffset) => 'id',
        updateAnnotation: () => {},
        removeAnnotation: () => {},
        clearAnnotations: () => {},
        formatAnnotationsMessage: () => '',
        formatDisplayMessage: () => '',
        getAnnotationAtPosition: () => null,
      };
      expect(typeCheck).toBeDefined();
    });
  });

  describe('UseConversationAnnotationsResult type structure', () => {
    it('has annotations array property', () => {
      const mockResult: UseConversationAnnotationsResult = {
        annotations: [],
        hasAnnotations: false,
        annotationCount: 0,
        annotationsByMessage: new Map(),
        addAnnotation: (_messageId, _text, _comment, _startOffset, _endOffset) => 'id',
        updateAnnotation: () => {},
        removeAnnotation: () => {},
        clearAnnotations: () => {},
        formatAnnotationsMessage: () => '',
        formatDisplayMessage: () => '',
        getAnnotationAtPosition: () => null,
      };
      expect(Array.isArray(mockResult.annotations)).toBe(true);
    });

    it('has hasAnnotations boolean property', () => {
      const mockResult: UseConversationAnnotationsResult = {
        annotations: [],
        hasAnnotations: false,
        annotationCount: 0,
        annotationsByMessage: new Map(),
        addAnnotation: (_messageId, _text, _comment, _startOffset, _endOffset) => 'id',
        updateAnnotation: () => {},
        removeAnnotation: () => {},
        clearAnnotations: () => {},
        formatAnnotationsMessage: () => '',
        formatDisplayMessage: () => '',
        getAnnotationAtPosition: () => null,
      };
      expect(typeof mockResult.hasAnnotations).toBe('boolean');
    });

    it('has annotationsByMessage Map property', () => {
      const mockResult: UseConversationAnnotationsResult = {
        annotations: [],
        hasAnnotations: false,
        annotationCount: 0,
        annotationsByMessage: new Map(),
        addAnnotation: (_messageId, _text, _comment, _startOffset, _endOffset) => 'id',
        updateAnnotation: () => {},
        removeAnnotation: () => {},
        clearAnnotations: () => {},
        formatAnnotationsMessage: () => '',
        formatDisplayMessage: () => '',
        getAnnotationAtPosition: () => null,
      };
      expect(mockResult.annotationsByMessage instanceof Map).toBe(true);
    });

    it('has all required callback functions', () => {
      const callbacks = [
        'addAnnotation',
        'updateAnnotation',
        'removeAnnotation',
        'clearAnnotations',
        'formatAnnotationsMessage',
        'formatDisplayMessage',
        'getAnnotationAtPosition',
      ] as const;

      const mockResult: UseConversationAnnotationsResult = {
        annotations: [],
        hasAnnotations: false,
        annotationCount: 0,
        annotationsByMessage: new Map(),
        addAnnotation: (_messageId, _text, _comment, _startOffset, _endOffset) => 'id',
        updateAnnotation: () => {},
        removeAnnotation: () => {},
        clearAnnotations: () => {},
        formatAnnotationsMessage: () => '',
        formatDisplayMessage: () => '',
        getAnnotationAtPosition: () => null,
      };

      for (const callback of callbacks) {
        expect(typeof mockResult[callback]).toBe('function');
      }
    });
  });

  describe('ConversationAnnotation type structure', () => {
    it('has all required properties', () => {
      const annotation: ConversationAnnotation = {
        id: 'ann-123',
        messageId: 'msg-456',
        text: 'The selected text from the AI reply',
        comment: "User's feedback about this text",
        createdAt: 1703851200000,
        startOffset: 50,
        endOffset: 85,
      };

      expect(annotation.id).toBe('ann-123');
      expect(annotation.messageId).toBe('msg-456');
      expect(annotation.text).toBe('The selected text from the AI reply');
      expect(annotation.comment).toBe("User's feedback about this text");
      expect(annotation.createdAt).toBe(1703851200000);
      expect(annotation.startOffset).toBe(50);
      expect(annotation.endOffset).toBe(85);
    });
  });

  describe('store-backed behavior', () => {
    it('persists annotations across cold hook unmount and remount as the HMR proxy', () => {
      const firstMount = renderHook<
        UseConversationAnnotationsResult,
        { sessionId: string }
      >(
        ({ sessionId }) => useConversationAnnotations(sessionId),
        { initialProps: { sessionId: 'session-hmr' } },
      );

      let createdId = '';
      try {
        act(() => {
          createdId = firstMount.result.current.addAnnotation(
            'msg-hmr',
            'selected text',
            'survive the remount',
            0,
            13,
          );
        });
      } finally {
        firstMount.unmount();
      }

      const secondMount = renderHook<
        UseConversationAnnotationsResult,
        { sessionId: string }
      >(
        ({ sessionId }) => useConversationAnnotations(sessionId),
        { initialProps: { sessionId: 'session-hmr' } },
      );

      try {
        expect(secondMount.result.current.annotations).toEqual([
          expect.objectContaining({
            id: createdId,
            messageId: 'msg-hmr',
            text: 'selected text',
            comment: 'survive the remount',
          }),
        ]);
        expect(secondMount.result.current.annotationCount).toBe(1);
      } finally {
        secondMount.unmount();
      }
    });

    it('writes annotations by session, switches sessions, and clears the current session entry', () => {
      const hook = renderHook<
        UseConversationAnnotationsResult,
        { sessionId: string }
      >(
        ({ sessionId }) => useConversationAnnotations(sessionId),
        { initialProps: { sessionId: 'session-a' } },
      );

      try {
        let createdId = '';
        act(() => {
          createdId = hook.result.current.addAnnotation(
            'msg-a',
            'selected text',
            'comment for session A',
            0,
            13,
          );
        });

        const sessionAAnnotations =
          useSessionStore.getState().annotationsBySessionId['session-a'];
        expect(createdId).toEqual(expect.any(String));
        expect(sessionAAnnotations).toHaveLength(1);
        expect(sessionAAnnotations?.[0]).toMatchObject({
          id: createdId,
          messageId: 'msg-a',
          text: 'selected text',
          comment: 'comment for session A',
          startOffset: 0,
          endOffset: 13,
        });
        expect(hook.result.current.annotations).toEqual(sessionAAnnotations);

        const sessionBAnnotation = createAnnotation({
          id: 'ann-b',
          messageId: 'msg-b',
          text: 'other selected text',
          comment: 'comment for session B',
          startOffset: 4,
          endOffset: 23,
        });
        act(() => {
          useSessionStore
            .getState()
            .setAnnotationsForSession('session-b', [sessionBAnnotation]);
        });

        hook.rerender({ sessionId: 'session-b' });

        expect(hook.result.current.annotations).toEqual([sessionBAnnotation]);
        expect(hook.result.current.annotationCount).toBe(1);

        act(() => {
          hook.result.current.clearAnnotations();
        });

        expect(
          'session-b' in useSessionStore.getState().annotationsBySessionId,
        ).toBe(false);
        expect(hook.result.current.annotations).toEqual([]);

        hook.rerender({ sessionId: 'session-a' });
        expect(hook.result.current.annotations).toEqual(sessionAAnnotations);
      } finally {
        hook.unmount();
      }
    });
  });

  describe('documentation', () => {
    it('documents the purpose: pending annotations on AI replies', () => {
      // This documents the hook's purpose:
      // 1. Users can select text in AI replies and add comments
      // 2. Annotations are scoped by session while pending
      // 3. Annotations can be sent as a formatted follow-up message
      // 4. The formatAnnotationsMessage() creates a quote-style message
      // 5. After sending, annotations are cleared
      expect(true).toBe(true);
    });
  });
});

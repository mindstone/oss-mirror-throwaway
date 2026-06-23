import { describe, it, expect } from 'vitest';
import type { AgentEvent } from '@shared/types';
import { SANITIZATION_POLICY_FROM_MANIFEST } from '@shared/contracts/agentEventManifest';
import { sanitizeEventForMainAccumulation, sanitizeEventForRenderer } from '../eventSanitization';

type ToolEvent = Extract<AgentEvent, { type: 'tool' }>;

const makeToolEvent = (detailLength: number, withImages = false): ToolEvent => ({
  type: 'tool',
  toolName: 'test_tool',
  detail: 'x'.repeat(detailLength),
  stage: 'end',
  timestamp: Date.now(),
  ...(withImages ? { imageContent: [{ type: 'image' as const, data: 'base64data', mimeType: 'image/png' }] } : {}),
});

const makeImageRef = (assetId: string, byteSize = 123) => ({
  assetId,
  mimeType: 'image/png',
  byteSize,
});

const makeToolImageBlock = (data: string, imageRef?: ReturnType<typeof makeImageRef>) => ({
  type: 'image',
  source: {
    type: 'base64',
    media_type: 'image/png',
    data,
  },
  ...(imageRef ? { imageRef } : {}),
});

const makeLargeTaskStartEvent = (): ToolEvent => ({
  type: 'tool',
  toolName: 'Task',
  stage: 'start',
  timestamp: Date.now(),
  detail: JSON.stringify({
    subagent_type: 'general-purpose',
    description: 'Classify inbox items 1-100 for cleanup',
    prompt: `Please classify these items:\n${'x'.repeat(15_000)}`,
    run_in_background: false,
  }, null, 2),
});

const makeLargeAgentStartEvent = (): ToolEvent => ({
  type: 'tool',
  toolName: 'Agent',
  stage: 'start',
  timestamp: Date.now(),
  detail: JSON.stringify({
    agent: 'knowledge-worker',
    prompt: `Retrieve emails and do analysis:\n${'x'.repeat(15_000)}`,
  }, null, 2),
});

const makeLargeTaskSnapshotEndEvent = (toolName: string): ToolEvent => ({
  type: 'tool',
  toolName,
  stage: 'end',
  timestamp: Date.now(),
  detail: JSON.stringify({
    summary: `Task #47 created successfully`,
    task: {
      id: '47',
      title: 'Read relevant files',
      description: 'Review the demo follow-up skill and source materials.',
      owner: 'main',
      status: 'in_progress',
      priority: 'high',
      activeForm: 'Reading relevant skill and source files',
      notes: 'x'.repeat(3_000),
      createdAt: Date.now(),
    },
    tasks: Array.from({ length: 5 }, (_, i) => ({
      id: String(i + 47),
      title: `Task ${i + 47}: do important work`,
      description: `Detailed description of task ${i}. ${'y'.repeat(2_000)}`,
      owner: 'main',
      status: i === 0 ? 'in_progress' : 'pending',
      priority: 'high',
      activeForm: `Working on task ${i}`,
      notes: `Notes for task ${i}: ${'z'.repeat(2_000)}`,
      blockers: i > 0 ? [`Task ${i - 1}`] : [],
      createdAt: Date.now(),
    })),
  }, null, 2),
});

describe('sanitizeEventForMainAccumulation', () => {
  it('passes non-tool events through unchanged', () => {
    const event: AgentEvent = { type: 'assistant', text: 'hello', timestamp: 1 };
    expect(sanitizeEventForMainAccumulation(event)).toBe(event);
  });

  it('passes small tool events through unchanged', () => {
    const event = makeToolEvent(100);
    expect(sanitizeEventForMainAccumulation(event)).toBe(event);
  });

  it('passes events at exactly 10K through unchanged', () => {
    const event = makeToolEvent(10_000);
    expect(sanitizeEventForMainAccumulation(event)).toBe(event);
  });

  it('truncates detail over 10K', () => {
    const event = makeToolEvent(15_000);
    const result = sanitizeEventForMainAccumulation(event);
    expect(result).not.toBe(event);
    expect(result.type).toBe('tool');
    if (result.type === 'tool') {
      expect(result.detail.length).toBeLessThanOrEqual(10_000);
      expect(result.detail).toContain('[truncated');
    }
  });

  it('preserves imageContent', () => {
    const event = makeToolEvent(100, true);
    const result = sanitizeEventForMainAccumulation(event);
    expect(result).toBe(event); // short detail, no changes needed
    if (result.type === 'tool') {
      expect(result.imageContent).toHaveLength(1);
    }
  });

  it('preserves imageContent when truncating detail', () => {
    const event = makeToolEvent(15_000, true);
    const result = sanitizeEventForMainAccumulation(event);
    if (result.type === 'tool') {
      expect(result.detail).toContain('[truncated');
      expect(result.imageContent).toHaveLength(1);
    }
  });

  it('does not mutate the original event', () => {
    const event = makeToolEvent(15_000, true);
    const originalDetail = event.detail;
    sanitizeEventForMainAccumulation(event);
    expect(event.detail).toBe(originalDetail);
    if (event.type === 'tool') {
      expect(event.imageContent).toHaveLength(1);
    }
  });

  it('strips top-level and toolResult inline image bytes when refs cover them', () => {
    const ref = makeImageRef('turn-1-1-0');
    const event: ToolEvent = {
      ...makeToolEvent(100),
      imageContent: [{ type: 'image', data: 'base64data', mimeType: 'image/png' }],
      imageRef: [ref],
      toolResult: {
        content: [
          { type: 'text', text: 'before' },
          makeToolImageBlock('base64data', ref),
        ],
      },
    };

    const result = sanitizeEventForMainAccumulation(event);

    expect(result).not.toBe(event);
    if (result.type === 'tool') {
      expect(result.imageContent).toEqual([
        { type: 'image', data: '', mimeType: 'image/png' },
      ]);
      expect(result.imageRef).toEqual([ref]);
      expect(result.toolResult?.content?.[1]).toEqual({
        type: 'image',
        imageRef: ref,
      });
    }
    expect(event.imageContent).toHaveLength(1);
    expect((event.toolResult?.content?.[1] as Record<string, unknown>).source).toBeDefined();
  });

  it('preserves legacy imageContent and source-only toolResult image blocks unchanged', () => {
    const event: ToolEvent = {
      ...makeToolEvent(100),
      imageContent: [{ type: 'image', data: 'legacy', mimeType: 'image/png' }],
      toolResult: {
        content: [makeToolImageBlock('legacy')],
      },
    };

    expect(sanitizeEventForMainAccumulation(event)).toBe(event);
  });

  it('preserves middle-image fallback content for positional partial ref materialization failures', () => {
    const ref0 = makeImageRef('turn-1-1-0');
    const ref2 = makeImageRef('turn-1-1-2');
    const ref3 = makeImageRef('turn-1-1-3');
    const refs = [ref0, null, ref2, ref3];
    const event: ToolEvent = {
      ...makeToolEvent(100),
      imageContent: [
        { type: 'image', data: 'covered-0', mimeType: 'image/png' },
        { type: 'image', data: 'fallback-1', mimeType: 'image/png' },
        { type: 'image', data: 'covered-2', mimeType: 'image/png' },
        { type: 'image', data: 'covered-3', mimeType: 'image/png' },
      ],
      imageRef: refs,
      toolResult: {
        content: [
          makeToolImageBlock('covered-0'),
          makeToolImageBlock('fallback-1'),
          makeToolImageBlock('covered-2'),
          makeToolImageBlock('covered-3'),
        ],
      },
    };

    const result = sanitizeEventForMainAccumulation(event);

    if (result.type === 'tool') {
      expect(result.imageRef).toEqual(refs);
      expect(result.imageContent).toEqual([
        { type: 'image', data: '', mimeType: 'image/png' },
        { type: 'image', data: 'fallback-1', mimeType: 'image/png' },
        { type: 'image', data: '', mimeType: 'image/png' },
        { type: 'image', data: '', mimeType: 'image/png' },
      ]);
      expect(result.toolResult?.content?.[0]).toEqual({ type: 'image', imageRef: ref0 });
      expect(result.toolResult?.content?.[1]).toEqual(makeToolImageBlock('fallback-1'));
      expect(result.toolResult?.content?.[2]).toEqual({ type: 'image', imageRef: ref2 });
      expect(result.toolResult?.content?.[3]).toEqual({ type: 'image', imageRef: ref3 });
    }
  });

  it.each([
    {
      label: 'first-null',
      refs: [null, makeImageRef('turn-first-1'), makeImageRef('turn-first-2')],
    },
    {
      label: 'last-null',
      refs: [makeImageRef('turn-last-0'), makeImageRef('turn-last-1'), null],
    },
    {
      label: 'multiple-null',
      refs: [null, makeImageRef('turn-multiple-1'), null, makeImageRef('turn-multiple-3')],
    },
  ])('preserves positional image fallbacks and surviving refs for $label sanitization', ({ refs }) => {
    const event: ToolEvent = {
      ...makeToolEvent(100),
      imageContent: refs.map((_, index) => ({
        type: 'image',
        data: `inline-${index}`,
        mimeType: 'image/png',
      })),
      imageRef: refs,
      toolResult: {
        content: refs.map((_, index) => makeToolImageBlock(`inline-${index}`)),
      },
    };

    const result = sanitizeEventForMainAccumulation(event);

    if (result.type === 'tool') {
      expect(result.imageRef).toEqual(refs);
      expect(result.imageContent).toEqual(refs.map((ref, index) => ({
        type: 'image',
        data: ref ? '' : `inline-${index}`,
        mimeType: 'image/png',
      })));
      expect(result.toolResult?.content).toEqual(refs.map((ref, index) => (
        ref ? { type: 'image', imageRef: ref } : makeToolImageBlock(`inline-${index}`)
      )));
    }
  });

  it('keeps top-level imageContent positional alignment for [ref, null, ref] events', () => {
    const ref0 = makeImageRef('turn-2-1-0');
    const ref2 = makeImageRef('turn-2-1-2');
    const event: ToolEvent = {
      ...makeToolEvent(100),
      imageContent: [
        { type: 'image', data: 'a', mimeType: 'image/png' },
        { type: 'image', data: 'b', mimeType: 'image/png' },
        { type: 'image', data: 'c', mimeType: 'image/png' },
      ],
      imageRef: [ref0, null, ref2],
    };

    const result = sanitizeEventForMainAccumulation(event);

    if (result.type === 'tool') {
      expect(result.imageContent).toHaveLength(3);
      expect(result.imageContent?.[0]?.data).toBe('');
      expect(result.imageContent?.[1]?.data).toBe('b');
      expect(result.imageContent?.[2]?.data).toBe('');
    }
  });

  it('keeps oversized Task start detail as valid JSON for downstream parsing', () => {
    const event = makeLargeTaskStartEvent();
    const result = sanitizeEventForMainAccumulation(event);
    expect(result).not.toBe(event);

    if (result.type === 'tool') {
      const parsed = JSON.parse(result.detail) as Record<string, unknown>;
      expect(parsed.subagent_type).toBe('general-purpose');
      expect(parsed.description).toBe('Classify inbox items 1-100 for cleanup');
      expect(parsed.__detailTruncated).toBe(true);
      expect(parsed.__originalDetailLength).toBe(event.detail.length);
      expect(typeof parsed.prompt).toBe('string');
      expect((parsed.prompt as string).length).toBeLessThan(event.detail.length);
      expect(result.detail.length).toBeLessThanOrEqual(10_000);
    }
  });

  it.each(['TaskCreate', 'TaskUpdate', 'TaskList'])('compacts oversized %s end event into valid JSON with tasks array', (toolName) => {
    const event = makeLargeTaskSnapshotEndEvent(toolName);
    expect(event.detail.length).toBeGreaterThan(10_000);

    const result = sanitizeEventForMainAccumulation(event);
    expect(result).not.toBe(event);
    if (result.type === 'tool') {
      expect(result.detail.length).toBeLessThanOrEqual(10_000);
      const parsed = JSON.parse(result.detail) as Record<string, unknown>;
      expect(parsed.__detailTruncated).toBe(true);
      expect(parsed.__originalDetailLength).toBe(event.detail.length);
      expect(Array.isArray(parsed.tasks)).toBe(true);
      const tasks = parsed.tasks as Array<Record<string, unknown>>;
      expect(tasks).toHaveLength(5);
      expect(tasks[0].id).toBe('47');
      expect(tasks[0].title).toContain('Task 47');
      expect(tasks[0].status).toBe('in_progress');
      expect(tasks[0].priority).toBe('high');
      // Detail fields preserved with truncation (description and notes are long)
      expect(tasks[0].description).toBeDefined();
      expect(tasks[0].description as string).toContain('[truncated');
      expect(tasks[0].notes).toBeDefined();
      expect(tasks[0].notes as string).toContain('[truncated');
      // Empty blockers array should be omitted (task 0 has no blockers)
      expect(tasks[0].blockers).toBeUndefined();
      // Task 1 should have blockers preserved
      expect(tasks[1].blockers).toEqual(['Task 0']);
      // Non-allowlisted fields should still be stripped
      expect(tasks[0].activeForm).toBeUndefined();
    }
  });
});

describe('sanitizeEventForRenderer', () => {
  it('passes non-tool events through unchanged', () => {
    const event: AgentEvent = { type: 'result', text: 'done', timestamp: 1 };
    expect(sanitizeEventForRenderer(event)).toBe(event);
  });

  it('passes small tool events through unchanged', () => {
    const event = makeToolEvent(100);
    expect(sanitizeEventForRenderer(event)).toBe(event);
  });

  it('passes events at exactly 10K through unchanged', () => {
    const event = makeToolEvent(10_000);
    expect(sanitizeEventForRenderer(event)).toBe(event);
  });

  it('truncates detail over 10K', () => {
    const event = makeToolEvent(15_000);
    const result = sanitizeEventForRenderer(event);
    expect(result).not.toBe(event);
    if (result.type === 'tool') {
      expect(result.detail.length).toBeLessThanOrEqual(10_000);
      expect(result.detail).toContain('[truncated');
    }
  });

  it('preserves imageContent when truncating detail', () => {
    const event = makeToolEvent(15_000, true);
    const result = sanitizeEventForRenderer(event);
    if (result.type === 'tool') {
      expect(result.detail).toContain('[truncated');
      expect(result.imageContent).toHaveLength(1);
    }
  });

  it('strips inline image bytes when image refs are available', () => {
    const ref = makeImageRef('turn-renderer-1-0');
    const event: ToolEvent = {
      ...makeToolEvent(100),
      imageContent: [{ type: 'image', data: 'renderer-base64', mimeType: 'image/png' }],
      imageRef: [ref],
      toolResult: {
        content: [makeToolImageBlock('renderer-base64', ref)],
      },
    };

    const result = sanitizeEventForRenderer(event);

    if (result.type === 'tool') {
      expect(result.imageContent).toEqual([
        { type: 'image', data: '', mimeType: 'image/png' },
      ]);
      expect(result.imageRef).toEqual([ref]);
      expect(result.toolResult?.content?.[0]).toEqual({ type: 'image', imageRef: ref });
    }
  });

  it('does not mutate the original event', () => {
    const event = makeToolEvent(15_000);
    const originalDetail = event.detail;
    sanitizeEventForRenderer(event);
    expect(event.detail).toBe(originalDetail);
  });

  it('keeps oversized Task start detail as valid JSON for sub-agent rendering', () => {
    const event = makeLargeTaskStartEvent();
    const result = sanitizeEventForRenderer(event);

    if (result.type === 'tool') {
      const parsed = JSON.parse(result.detail) as Record<string, unknown>;
      expect(parsed.subagent_type).toBe('general-purpose');
      expect(parsed.__detailTruncated).toBe(true);
      expect(typeof parsed.prompt).toBe('string');
      expect(result.detail.length).toBeLessThanOrEqual(10_000);
    }
  });

  it('keeps oversized Agent start detail as valid JSON preserving agent field', () => {
    const event = makeLargeAgentStartEvent();
    const result = sanitizeEventForRenderer(event);

    if (result.type === 'tool') {
      const parsed = JSON.parse(result.detail) as Record<string, unknown>;
      expect(parsed.agent).toBe('knowledge-worker');
      expect(parsed.__detailTruncated).toBe(true);
      expect(typeof parsed.prompt).toBe('string');
      expect(result.detail.length).toBeLessThanOrEqual(10_000);
    }
  });

  it.each(['TaskCreate', 'TaskUpdate', 'TaskList'])('compacts oversized %s end event preserving parseable tasks for MissionProgressCard', (toolName) => {
    const event = makeLargeTaskSnapshotEndEvent(toolName);
    const result = sanitizeEventForRenderer(event);
    expect(result).not.toBe(event);
    if (result.type === 'tool') {
      expect(result.detail.length).toBeLessThanOrEqual(10_000);
      const parsed = JSON.parse(result.detail) as Record<string, unknown>;
      const tasks = parsed.tasks as Array<Record<string, unknown>>;
      expect(tasks).toHaveLength(5);
      expect(tasks[0].status).toBe('in_progress');
      expect(tasks[1].status).toBe('pending');
      // Verify parseTasksFromDetail can consume this (same shape it expects)
      expect(tasks.every((t: Record<string, unknown>) => t.id && t.title && t.status)).toBe(true);
      // Detail fields preserved for tooltip/expand display
      expect(tasks[0].description).toBeDefined();
      expect(tasks[1].blockers).toEqual(['Task 0']);
    }
  });
});

describe('task snapshot detail field preservation', () => {
  const makeTaskSnapshotEvent = (taskOverrides: Record<string, unknown> = {}): ToolEvent => ({
    type: 'tool',
    toolName: 'TaskList',
    stage: 'end',
    timestamp: Date.now(),
    detail: JSON.stringify({
      summary: 'Listed tasks',
      task: {
        id: '1',
        title: 'Main task',
        status: 'in_progress',
        priority: 'high',
        ...taskOverrides,
      },
      tasks: [
        {
          id: '1',
          title: 'Main task',
          status: 'in_progress',
          priority: 'high',
          ...taskOverrides,
        },
      ],
      // Pad to exceed 10K threshold
      _padding: 'x'.repeat(12_000),
    }, null, 2),
  });

  it('truncates description to 200 chars with marker', () => {
    const longDesc = 'A'.repeat(500);
    const event = makeTaskSnapshotEvent({ description: longDesc });
    const result = sanitizeEventForMainAccumulation(event);
    if (result.type === 'tool') {
      const parsed = JSON.parse(result.detail) as Record<string, unknown>;
      const tasks = parsed.tasks as Array<Record<string, unknown>>;
      const desc = tasks[0].description as string;
      expect(desc).toBeDefined();
      expect(desc).toContain('[truncated');
      // Total length should be approximately 200 (prefix + marker)
      expect(desc.length).toBeLessThanOrEqual(250);
      expect(desc.startsWith('A')).toBe(true);
      // Individual task field should also be truncated
      const task = parsed.task as Record<string, unknown>;
      expect(task.description).toBeDefined();
      expect(task.description as string).toContain('[truncated');
    }
  });

  it('preserves short description without truncation', () => {
    const shortDesc = 'Review the follow-up materials.';
    const event = makeTaskSnapshotEvent({ description: shortDesc });
    const result = sanitizeEventForMainAccumulation(event);
    if (result.type === 'tool') {
      const parsed = JSON.parse(result.detail) as Record<string, unknown>;
      const tasks = parsed.tasks as Array<Record<string, unknown>>;
      expect(tasks[0].description).toBe(shortDesc);
      const task = parsed.task as Record<string, unknown>;
      expect(task.description).toBe(shortDesc);
    }
  });

  it('truncates notes to 150 chars with marker', () => {
    const longNotes = 'N'.repeat(400);
    const event = makeTaskSnapshotEvent({ notes: longNotes });
    const result = sanitizeEventForMainAccumulation(event);
    if (result.type === 'tool') {
      const parsed = JSON.parse(result.detail) as Record<string, unknown>;
      const tasks = parsed.tasks as Array<Record<string, unknown>>;
      const notes = tasks[0].notes as string;
      expect(notes).toBeDefined();
      expect(notes).toContain('[truncated');
      expect(notes.length).toBeLessThanOrEqual(200);
      expect(notes.startsWith('N')).toBe(true);
      const task = parsed.task as Record<string, unknown>;
      expect(task.notes).toBeDefined();
      expect(task.notes as string).toContain('[truncated');
    }
  });

  it('preserves blockers as string array', () => {
    const blockers = ['Task #2', 'Waiting on external review'];
    const event = makeTaskSnapshotEvent({ blockers });
    const result = sanitizeEventForMainAccumulation(event);
    if (result.type === 'tool') {
      const parsed = JSON.parse(result.detail) as Record<string, unknown>;
      const tasks = parsed.tasks as Array<Record<string, unknown>>;
      expect(tasks[0].blockers).toEqual(blockers);
      const task = parsed.task as Record<string, unknown>;
      expect(task.blockers).toEqual(blockers);
    }
  });

  it('rejects non-string blockers entirely', () => {
    const event = makeTaskSnapshotEvent({ blockers: [123, 'valid', null] });
    const result = sanitizeEventForMainAccumulation(event);
    if (result.type === 'tool') {
      const parsed = JSON.parse(result.detail) as Record<string, unknown>;
      const tasks = parsed.tasks as Array<Record<string, unknown>>;
      // Array contains non-strings, so blockers should be omitted entirely
      expect(tasks[0].blockers).toBeUndefined();
      const task = parsed.task as Record<string, unknown>;
      expect(task.blockers).toBeUndefined();
    }
  });

  it('omits empty description (empty string)', () => {
    const event = makeTaskSnapshotEvent({ description: '' });
    const result = sanitizeEventForMainAccumulation(event);
    if (result.type === 'tool') {
      const parsed = JSON.parse(result.detail) as Record<string, unknown>;
      const tasks = parsed.tasks as Array<Record<string, unknown>>;
      expect(tasks[0].description).toBeUndefined();
    }
  });

  it('omits whitespace-only description', () => {
    const event = makeTaskSnapshotEvent({ description: '   \n  ' });
    const result = sanitizeEventForMainAccumulation(event);
    if (result.type === 'tool') {
      const parsed = JSON.parse(result.detail) as Record<string, unknown>;
      const tasks = parsed.tasks as Array<Record<string, unknown>>;
      expect(tasks[0].description).toBeUndefined();
    }
  });

  it('omits empty notes', () => {
    const event = makeTaskSnapshotEvent({ notes: '' });
    const result = sanitizeEventForMainAccumulation(event);
    if (result.type === 'tool') {
      const parsed = JSON.parse(result.detail) as Record<string, unknown>;
      const tasks = parsed.tasks as Array<Record<string, unknown>>;
      expect(tasks[0].notes).toBeUndefined();
    }
  });

  it('omits empty blockers array', () => {
    const event = makeTaskSnapshotEvent({ blockers: [] });
    const result = sanitizeEventForMainAccumulation(event);
    if (result.type === 'tool') {
      const parsed = JSON.parse(result.detail) as Record<string, unknown>;
      const tasks = parsed.tasks as Array<Record<string, unknown>>;
      expect(tasks[0].blockers).toBeUndefined();
    }
  });

  it('omits fields when not present at all', () => {
    const event = makeTaskSnapshotEvent({});
    const result = sanitizeEventForMainAccumulation(event);
    if (result.type === 'tool') {
      const parsed = JSON.parse(result.detail) as Record<string, unknown>;
      const tasks = parsed.tasks as Array<Record<string, unknown>>;
      expect(tasks[0].description).toBeUndefined();
      expect(tasks[0].notes).toBeUndefined();
      expect(tasks[0].blockers).toBeUndefined();
    }
  });

  it('preserves kind (orchestration filter relies on this)', () => {
    const event = makeTaskSnapshotEvent({ kind: 'orchestration' });
    const result = sanitizeEventForMainAccumulation(event);
    if (result.type === 'tool') {
      const parsed = JSON.parse(result.detail) as Record<string, unknown>;
      const tasks = parsed.tasks as Array<Record<string, unknown>>;
      expect(tasks[0].kind).toBe('orchestration');
      const task = parsed.task as Record<string, unknown>;
      expect(task.kind).toBe('orchestration');
    }
  });

  it('preserves parallelGroup (planning panel groups concurrent tasks visually)', () => {
    const event = makeTaskSnapshotEvent({ parallelGroup: 'research_wave' });
    const result = sanitizeEventForMainAccumulation(event);
    if (result.type === 'tool') {
      const parsed = JSON.parse(result.detail) as Record<string, unknown>;
      const tasks = parsed.tasks as Array<Record<string, unknown>>;
      expect(tasks[0].parallelGroup).toBe('research_wave');
      const task = parsed.task as Record<string, unknown>;
      expect(task.parallelGroup).toBe('research_wave');
    }
  });

  it('keeps compacted payload with new fields at a reasonable size for realistic task counts', () => {
    // 15 tasks with full detail fields — realistic worst case for sanitization
    const event: ToolEvent = {
      type: 'tool',
      toolName: 'TaskList',
      stage: 'end',
      timestamp: Date.now(),
      detail: JSON.stringify({
        summary: 'Listed all tasks',
        tasks: Array.from({ length: 15 }, (_, i) => ({
          id: String(i + 1),
          title: `Task ${i + 1}: important work item with a descriptive title`,
          description: `This is a detailed description of task ${i + 1} explaining what needs to be done. ${'d'.repeat(300)}`,
          notes: `Implementation notes for task ${i + 1}: ${'n'.repeat(200)}`,
          blockers: i > 0 ? [`Task ${i}`, `External dependency #${i}`] : [],
          status: i < 3 ? 'completed' : i === 3 ? 'in_progress' : 'pending',
          priority: i < 5 ? 'high' : 'medium',
          owner: 'main',
          activeForm: `Working on task ${i + 1}: ${'a'.repeat(500)}`,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })),
      }, null, 2),
    };
    expect(event.detail.length).toBeGreaterThan(10_000);

    const result = sanitizeEventForMainAccumulation(event);
    if (result.type === 'tool') {
      expect(result.detail.length).toBeLessThanOrEqual(10_000);
      const parsed = JSON.parse(result.detail) as Record<string, unknown>;
      const tasks = parsed.tasks as Array<Record<string, unknown>>;
      expect(tasks).toHaveLength(15);
      // All tasks should have core fields + truncated detail fields
      for (const task of tasks) {
        expect(task.id).toBeDefined();
        expect(task.title).toBeDefined();
        expect(task.status).toBeDefined();
        // activeForm and other non-allowlisted fields stripped
        expect(task.activeForm).toBeUndefined();
        expect(task.createdAt).toBeUndefined();
      }
      // Description should be truncated (originals are > 200 chars)
      expect(tasks[0].description).toBeDefined();
      expect((tasks[0].description as string)).toContain('[truncated');
    }
  });
});

/**
 * R2 Stage 3a-L2 cutover gates (2026-05-01).
 *
 * Pre-cutover, `eventSanitization.ts` dispatched on `event.type === 'tool'`
 * inline. The cutover routes dispatch through `SANITIZATION_POLICY_FROM_MANIFEST`
 * + a local strategy registry. These tests lock the new invariants:
 *
 *   1. Manifest-projection key set covers all 19 known AgentEvent variants
 *      (defence against the manifest losing a variant projection).
 *   2. Manifest-projection values are confined to known strategy names
 *      (defence against silent drift to a new strategy that the registry
 *      doesn't implement).
 *   3. Identity preservation for pass-through events (the renderer's
 *      session-store relies on object identity to skip re-renders;
 *      regressing this would degrade UI performance silently).
 *   4. Both `sanitizeEventForMainAccumulation` and `sanitizeEventForRenderer`
 *      now share the same dispatch path (collapsed to private dispatcher);
 *      observation parity test guards against accidental divergence.
 */
describe('R2 Stage 3a-L2 cutover gates', () => {
  it('manifest projection has 31-variant coverage', () => {
    expect(Object.keys(SANITIZATION_POLICY_FROM_MANIFEST)).toHaveLength(31);
  });

  it('manifest projection values are all in the known strategy registry', () => {
    const KNOWN_STRATEGIES = new Set([
      'pass-through',
      'truncate-tool-detail-with-subagent-identity',
    ]);
    for (const [variant, strategyName] of Object.entries(
      SANITIZATION_POLICY_FROM_MANIFEST,
    )) {
      expect(KNOWN_STRATEGIES.has(strategyName as string)).toBe(true);
      // If this fails, either the manifest gained a new strategy OR
      // eventSanitization.ts's SANITIZATION_STRATEGIES registry needs a
      // corresponding entry. The dispatcher's fail-closed resolver would
      // throw at runtime; this test catches the drift earlier.
      void variant;
    }
  });

  it('preserves object identity for pass-through (non-tool) events', () => {
    const event: AgentEvent = { type: 'assistant', text: 'hello', timestamp: 1 };
    expect(sanitizeEventForMainAccumulation(event)).toBe(event);
    expect(sanitizeEventForRenderer(event)).toBe(event);
  });

  it('preserves object identity for pass-through (tool, small detail) events', () => {
    const event: AgentEvent = {
      type: 'tool',
      toolName: 'Read',
      detail: 'short detail',
      stage: 'end',
      timestamp: 1,
    };
    expect(sanitizeEventForMainAccumulation(event)).toBe(event);
    expect(sanitizeEventForRenderer(event)).toBe(event);
  });

  it('main-accumulation and renderer dispatchers produce identical output for tool events', () => {
    const largeDetail = 'x'.repeat(15_000);
    const event: AgentEvent = {
      type: 'tool',
      toolName: 'Bash',
      detail: largeDetail,
      stage: 'end',
      timestamp: 1,
    };
    const main = sanitizeEventForMainAccumulation(event);
    const renderer = sanitizeEventForRenderer(event);
    expect(main).toEqual(renderer);
  });

  // Prototype-key spoof regression (reviewer-gpt5.5-high P1, 2026-05-01):
  // a forward-version event with type === 'toString' must not resolve to
  // Object.prototype.toString and must be preserved unchanged. The fix uses
  // Object.hasOwn rather than `name in object` checks.
  it('preserves a forward-version event with prototype-key type ("toString") unchanged', () => {
    const spoofEvent = { type: 'toString', timestamp: 1 } as unknown as AgentEvent;
    expect(sanitizeEventForMainAccumulation(spoofEvent)).toBe(spoofEvent);
    expect(sanitizeEventForRenderer(spoofEvent)).toBe(spoofEvent);
  });

  it('preserves a forward-version event with prototype-key type ("constructor") unchanged', () => {
    const spoofEvent = { type: 'constructor', timestamp: 1 } as unknown as AgentEvent;
    expect(sanitizeEventForMainAccumulation(spoofEvent)).toBe(spoofEvent);
    expect(sanitizeEventForRenderer(spoofEvent)).toBe(spoofEvent);
  });
});

import { describe, expect, it } from 'vitest';
import {
  classifyEffectKind,
  deriveActionPreview,
  EFFECT_PROJECTOR_REGISTRY,
  isSourceCaptureFileName,
  projectDataCapture,
  projectGenericStructured,
  type ActionEffectKind,
  type ActionPreviewInput,
} from '../index';
import {
  deriveUnifiedApprovals,
  type MemoryApprovalInput,
  type SessionContextForApprovals,
} from '../unifiedApprovalMapper';
import { extractSourceMetadataFromFileName } from '../../../../src/renderer/features/inbox/utils/extractSourceMetadata';

function shape(model: ReturnType<typeof deriveActionPreview>) {
  return {
    effectKind: model.effectKind,
    contentVisibility: model.contentVisibility,
    where: model.blastRadius.where.map((chip) => chip.label),
    whoCanSeeIt: model.blastRadius.whoCanSeeIt.map((chip) => chip.label),
    afterwards: model.blastRadius.afterwards.map((chip) => chip.label),
    reversibility: model.reversibility,
    riskReasons: model.riskReasons,
  };
}

describe('action preview golden fixtures', () => {
  it('projects Slack channel with resolved name', () => {
    const input: ActionPreviewInput = {
      kind: 'tool',
      toolName: 'Task',
      effectiveToolId: 'chat_postMessage',
      packageId: 'slack',
      args: { channel: 'C123', text: 'hello team' },
      resolvedChannelName: 'leadership',
    };

    expect(shape(deriveActionPreview(input))).toEqual({
      effectKind: 'message',
      contentVisibility: 'safe',
      where: ['#leadership'],
      whoCanSeeIt: [],
      afterwards: ['Can edit after posting'],
      reversibility: 'Can edit after posting',
      riskReasons: ['Shared', 'Leaves Rebel'],
    });
  });

  it('projects Slack channel with unresolved C-id conservatively', () => {
    const input: ActionPreviewInput = {
      kind: 'tool',
      toolName: 'Task',
      effectiveToolId: 'chat_postMessage',
      packageId: 'slack',
      args: { channel: 'C0192ABC', text: 'hello team' },
    };

    expect(shape(deriveActionPreview(input))).toEqual({
      effectKind: 'message',
      contentVisibility: 'safe',
      where: ['Slack channel'],
      whoCanSeeIt: [],
      afterwards: ['Can edit after posting'],
      reversibility: 'Can edit after posting',
      riskReasons: ['Shared', 'Leaves Rebel'],
    });
  });

  it('projects Slack DM with resolved recipient', () => {
    const input: ActionPreviewInput = {
      kind: 'tool',
      toolName: 'Task',
      effectiveToolId: 'chat_postMessage',
      packageId: 'slack',
      args: { user: 'U1234', text: 'quick update' },
      resolvedRecipientLabel: 'Alex',
    };

    expect(shape(deriveActionPreview(input))).toEqual({
      effectKind: 'message',
      contentVisibility: 'safe',
      where: ['Alex'],
      whoCanSeeIt: ['Just Alex'],
      afterwards: ['Can edit after posting'],
      reversibility: 'Can edit after posting',
      riskReasons: ['Leaves Rebel'],
    });
  });

  it('keeps long Slack message body text beyond 240 chars in message projection', () => {
    const longText = `Launch update: ${'A'.repeat(320)}`;
    const input: ActionPreviewInput = {
      kind: 'tool',
      toolName: 'Task',
      effectiveToolId: 'chat_postMessage',
      packageId: 'slack',
      args: { channel: '#leadership', text: longText },
    };

    const model = deriveActionPreview(input);
    const textRow = model.structuredArgs.find((row) => row.key === 'text');

    expect(model.effectKind).toBe('message');
    expect(textRow?.value).toBe(longText);
    expect(textRow?.value).not.toBe(`${longText.slice(0, 239)}…`);
  });

  it('projects email recipient blast radius and reversibility', () => {
    const input: ActionPreviewInput = {
      kind: 'staged-tool',
      toolId: 'send_email',
      packageId: 'gmail',
      args: { to: 'a@example.com, b@example.com', subject: 'Update', body: 'Details here' },
    };

    expect(shape(deriveActionPreview(input))).toEqual({
      effectKind: 'message',
      contentVisibility: 'safe',
      where: ['a@example.com, b@example.com'],
      whoCanSeeIt: ['2 recipients'],
      afterwards: ['Hard to undo'],
      reversibility: 'Hard to undo',
      riskReasons: ['Leaves Rebel'],
    });
  });

  it('threads the is_html flag onto the email body row', () => {
    const input: ActionPreviewInput = {
      kind: 'staged-tool',
      toolId: 'compose_workspace_email',
      packageId: 'gmail',
      args: {
        to: 'alice@example.com',
        subject: 'Meeting summary',
        body: '<p>Hi Alice,</p><ul><li>Budget</li></ul>',
        is_html: true,
      },
    };

    const model = deriveActionPreview(input);
    const bodyRow = model.structuredArgs.find((row) => row.key === 'body');

    expect(bodyRow?.value).toBe('<p>Hi Alice,</p><ul><li>Budget</li></ul>');
    expect(bodyRow?.isHtml).toBe(true);
  });

  it('leaves a plain-text email body row without the isHtml flag', () => {
    const input: ActionPreviewInput = {
      kind: 'staged-tool',
      toolId: 'compose_workspace_email',
      packageId: 'gmail',
      args: { to: 'alice@example.com', subject: 'Update', body: 'Plain text body' },
    };

    const model = deriveActionPreview(input);
    const bodyRow = model.structuredArgs.find((row) => row.key === 'body');

    expect(bodyRow?.value).toBe('Plain text body');
    expect(bodyRow?.isHtml ?? false).toBe(false);
  });

  it('classifies net-new source capture as data-capture', () => {
    const input: ActionPreviewInput = {
      kind: 'memory',
      filePath: 'memory/sources/260418_1430_meeting_q3-review.md',
      spaceName: 'Chief of Staff',
      summary: 'Q3 review capture',
      contentPreview: 'Captured notes',
      sharing: 'restricted',
      isNewFile: true,
    };

    expect(classifyEffectKind(input)).toBe('data-capture');
    expect(shape(deriveActionPreview(input))).toEqual({
      effectKind: 'data-capture',
      contentVisibility: 'safe',
      where: ['Chief-of-Staff'],
      whoCanSeeIt: ['Shared workspace'],
      afterwards: ['Can edit after saving'],
      reversibility: 'Can edit after saving',
      riskReasons: ['Shared'],
    });
  });

  it('keeps regular shared-space edits as document (not data-capture)', () => {
    const input: ActionPreviewInput = {
      kind: 'memory',
      filePath: 'memory/general/working-notes.md',
      spaceName: 'General',
      summary: 'Updated summary',
      sharing: 'restricted',
      isNewFile: false,
    };

    expect(classifyEffectKind(input)).toBe('document');
    expect(shape(deriveActionPreview(input))).toEqual({
      effectKind: 'document',
      contentVisibility: 'safe',
      where: ['General'],
      whoCanSeeIt: ['Shared workspace'],
      afterwards: ['Can edit after saving'],
      reversibility: 'Can edit after saving',
      riskReasons: ['Shared'],
    });
  });

  it('keeps conflicted non-net-new source files out of data-capture', () => {
    const input: ActionPreviewInput = {
      kind: 'staged-file',
      filePath: 'memory/sources/260529_1430_meeting_q3-review.md',
      spaceName: 'Chief of Staff',
      summary: 'Conflict path',
      sharing: 'restricted',
      hasConflict: true,
      baseHash: 'abc123',
      isNewFile: false,
    };

    expect(classifyEffectKind(input)).toBe('document');
  });

  it('keeps conflicted net-new source capture on document path', () => {
    const input: ActionPreviewInput = {
      kind: 'staged-file',
      filePath: 'memory/sources/260418_1430_meeting_q3-review.md',
      spaceName: 'Chief of Staff',
      summary: 'Conflict on a new capture',
      sharing: 'restricted',
      hasConflict: true,
      baseHash: 'new-file',
      isNewFile: true,
    };

    expect(classifyEffectKind(input)).toBe('document');
    expect(deriveActionPreview(input).effectKind).toBe('document');
  });

  it('projects bash commands as command effect with visible redacted command rows', () => {
    const input: ActionPreviewInput = {
      kind: 'staged-tool',
      toolId: 'run_shell_command',
      packageId: 'bash',
      args: { command: 'npm test' },
    };

    expect(shape(deriveActionPreview(input))).toEqual({
      effectKind: 'command',
      contentVisibility: 'safe',
      where: ['Runs on your device'],
      whoCanSeeIt: [],
      afterwards: ['Runs once'],
      reversibility: 'Runs once',
      riskReasons: [],
    });

    const model = deriveActionPreview(input);
    expect(model.structuredArgs.some((row) => row.key === 'command' && row.value.includes('npm test'))).toBe(true);
  });

  it('strips case-varied nested content keys when content visibility is unknown', () => {
    const input: ActionPreviewInput = {
      kind: 'tool',
      toolName: 'Task',
      effectiveToolId: 'generic_tool',
      args: {
        contentVisibility: 'unknown',
        payload: {
          Text: 'SECRET-TEXT',
          nested: {
            content_preview: 'SECRET-PREVIEW',
            Message: 'SECRET-MESSAGE',
            safeFlag: true,
          },
        },
      },
    };

    const model = projectGenericStructured(input, 'generic');
    const projectionText = JSON.stringify({
      rows: model.structuredArgs,
      safeRawArgs: model.safeRawArgs,
    });

    expect(model.contentVisibility).toBe('unknown');
    expect(projectionText).not.toContain('SECRET-TEXT');
    expect(projectionText).not.toContain('SECRET-PREVIEW');
    expect(projectionText).not.toContain('SECRET-MESSAGE');
    expect(projectionText).toContain('safeFlag');
  });

  it('handles empty malformed args via conservative generic projection', () => {
    const input: ActionPreviewInput = {
      kind: 'tool',
      toolName: 'Task',
      effectiveToolId: 'do_thing',
      args: null,
    };

    const model = deriveActionPreview(input);
    expect(shape(model)).toEqual({
      effectKind: 'generic',
      contentVisibility: 'unknown',
      where: ['Runs on your device'],
      whoCanSeeIt: [],
      afterwards: [],
      reversibility: null,
      riskReasons: [],
    });
    expect(model.structuredArgs).toEqual([]);
  });
});

describe('data-capture projector', () => {
  it.each([
    { sharing: 'private' as const, expectedAudience: ['Private to you'], expectedRiskReasons: [] as string[] },
    { sharing: 'restricted' as const, expectedAudience: ['Shared workspace'], expectedRiskReasons: ['Shared'] },
    { sharing: 'company-wide' as const, expectedAudience: ['Company-wide'], expectedRiskReasons: ['Shared'] },
    { sharing: 'public' as const, expectedAudience: ['Public'], expectedRiskReasons: ['Shared'] },
  ])('projects sharing=$sharing with evidence-backed audience/risk', ({ sharing, expectedAudience, expectedRiskReasons }) => {
    const input: ActionPreviewInput = {
      kind: 'memory',
      filePath: 'memory/sources/260418_1430_meeting_q3-review.md',
      spaceName: 'Chief of Staff',
      summary: 'Captured board prep notes.',
      contentPreview: 'Revenue risk is concentrated in EMEA.',
      sharing,
      isNewFile: true,
    };

    const model = projectDataCapture(input);
    expect(model.effectKind).toBe('data-capture');
    expect(model.title).toBe('Save to Chief-of-Staff');
    expect(model.blastRadius.whoCanSeeIt.map((chip) => chip.label)).toEqual(expectedAudience);
    expect(model.riskReasons).toEqual(expectedRiskReasons);
    expect(model.reversibility).toBe('Can edit after saving');
    expect(model.safeRawArgs.isNew).toBe(true);
  });

  it('omits audience chip and sharing metadata when sharing is unknown', () => {
    const input: ActionPreviewInput = {
      kind: 'memory',
      filePath: 'memory/sources/260418_1430_meeting_q3-review.md',
      spaceName: 'Chief of Staff',
      summary: 'Captured board prep notes.',
      contentPreview: 'Revenue risk is concentrated in EMEA.',
      isNewFile: true,
    };

    const model = projectDataCapture(input);
    expect(model.blastRadius.whoCanSeeIt).toEqual([]);
    expect(Object.prototype.hasOwnProperty.call(model.safeRawArgs, 'sharing')).toBe(false);
  });

  it('fails closed for sensitive content by removing body rows and excerpts', () => {
    const input: ActionPreviewInput = {
      kind: 'memory',
      filePath: 'memory/sources/260418_1430_meeting_q3-review.md',
      spaceName: 'Chief of Staff',
      summary: 'Sensitive summary must not render',
      contentPreview: 'Sensitive excerpt must not render',
      sensitivityReason: 'contains private information',
      sharing: 'restricted',
      isNewFile: true,
    };

    const model = projectDataCapture(input);
    const projectionText = JSON.stringify({
      rows: model.structuredArgs,
      safeRawArgs: model.safeRawArgs,
    });

    expect(model.contentVisibility).toBe('withheld');
    expect(model.structuredArgs).toEqual([]);
    expect(projectionText).not.toContain('Sensitive summary must not render');
    expect(projectionText).not.toContain('Sensitive excerpt must not render');
    expect(Object.prototype.hasOwnProperty.call(model.safeRawArgs, 'summary')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(model.safeRawArgs, 'excerpts')).toBe(false);
  });
});

describe('forbidden blast-radius labels', () => {
  it.each([
    {
      label: 'unresolved C-id',
      channelId: 'C123ABC9',
      resolvedChannelName: undefined,
    },
    {
      label: 'unresolved G-id with malformed resolved name',
      channelId: 'G55XYZ12',
      resolvedChannelName: '###',
    },
    {
      label: 'unresolved G-id with empty resolved name',
      channelId: 'G42ABCD9',
      resolvedChannelName: '   ',
    },
  ])('never emits forbidden labels or raw Slack ids for $label', ({ channelId, resolvedChannelName }) => {
    const input: ActionPreviewInput = {
      kind: 'tool',
      toolName: 'Task',
      effectiveToolId: 'chat_postMessage',
      packageId: 'slack',
      args: { channel: channelId, text: 'ship it' },
      resolvedChannelName,
    };

    const model = deriveActionPreview(input);
    const surfaceText = [
      model.title,
      ...model.blastRadius.where.map((chip) => chip.label),
      ...model.blastRadius.whoCanSeeIt.map((chip) => chip.label),
      ...model.blastRadius.afterwards.map((chip) => chip.label),
      ...model.riskReasons,
      model.reversibility ?? '',
      ...model.structuredArgs.map((row) => `${row.key}:${row.value}`),
      JSON.stringify(model.safeRawArgs),
    ].join(' | ');

    expect(surfaceText).not.toContain(channelId);
    expect(surfaceText).not.toContain('Undoable');
    expect(surfaceText).not.toContain('Public channel');
    expect(surfaceText).not.toContain('Private to you');
    expect(surfaceText).not.toMatch(/\b\d+\s+people\b/i);
  });
});

describe('Stage 1 behavioral contracts', () => {
  it('does not invent a Slack #channel name or audience chip from a raw channel id', () => {
    const input: ActionPreviewInput = {
      kind: 'tool',
      toolName: 'Task',
      effectiveToolId: 'chat_postMessage',
      packageId: 'slack',
      args: { channel: 'C08ABC', text: 'Post this update' },
    };

    const model = deriveActionPreview(input);
    const whereLabels = model.blastRadius.where.map((chip) => chip.label);
    const audienceLabels = model.blastRadius.whoCanSeeIt.map((chip) => chip.label);

    expect(model.effectKind).toBe('message');
    expect(whereLabels).toEqual(['Slack channel']);
    expect(whereLabels).not.toContain('#C08ABC');
    expect(whereLabels.every((label) => !label.startsWith('#'))).toBe(true);
    expect(audienceLabels).toEqual([]);
    expect(audienceLabels).not.toContain('Public channel');
    expect(audienceLabels).not.toContain('Private to you');
  });

  it('keeps an existing company-wide source-capture file edit on the document path', () => {
    const input: ActionPreviewInput = {
      kind: 'memory',
      filePath: 'memory/sources/260529_1430_meeting_q3-review.md',
      spaceName: 'Chief of Staff',
      summary: 'Update existing capture',
      contentPreview: 'Changed notes',
      sharing: 'company-wide',
      isNewFile: false,
    };

    expect(classifyEffectKind(input)).toBe('document');
    expect(deriveActionPreview(input).effectKind).toBe('document');
  });

  it('redacts sensitive key values from generic rows and safe raw args', () => {
    const input: ActionPreviewInput = {
      kind: 'tool',
      toolName: 'Task',
      effectiveToolId: 'create_record',
      packageId: 'hubspot',
      args: {
        api_key: 'fake-api-secret',
        password: 'correct-horse-battery-staple',
        authorization: 'Bearer private-token',
        description: 'Safe summary',
        nested: {
          password: 'nested-password',
          publicNote: 'Visible note',
        },
      },
    };

    const model = projectGenericStructured(input, 'generic');
    const projectedText = JSON.stringify({
      rows: model.structuredArgs,
      safeRawArgs: model.safeRawArgs,
    });

    expect(projectedText).not.toContain('fake-api-secret');
    expect(projectedText).not.toContain('correct-horse-battery-staple');
    expect(projectedText).not.toContain('Bearer private-token');
    expect(projectedText).not.toContain('nested-password');
    expect(projectedText).toContain('Safe summary');
    expect(projectedText).toContain('Visible note');
  });

  it('fails closed for sensitive content visibility and strips body fields', () => {
    const input: ActionPreviewInput = {
      kind: 'memory',
      filePath: 'memory/sources/260529_1430_meeting_q3-review.md',
      spaceName: 'Chief of Staff',
      summary: 'Safe summary text',
      contentPreview: 'secret excerpt',
      sensitivityReason: 'contains secrets',
      sharing: 'restricted',
      isNewFile: true,
    };

    const model = deriveActionPreview(input);
    const projectionText = JSON.stringify({
      rows: model.structuredArgs,
      safeRawArgs: model.safeRawArgs,
    });

    expect(model.contentVisibility).toBe('withheld');
    expect(projectionText).not.toContain('secret excerpt');
    expect(Object.prototype.hasOwnProperty.call(model.safeRawArgs, 'contentPreview')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(model.safeRawArgs, 'content')).toBe(false);
  });
});

describe('generic redaction policy', () => {
  it('strips sensitive keys, caps rows, and truncates long values', () => {
    const input: ActionPreviewInput = {
      kind: 'tool',
      toolName: 'Task',
      effectiveToolId: 'create_record',
      packageId: 'hubspot',
      args: {
        token: 'abc123',
        authorization: 'Bearer super-secret',
        cookie: 'foo=bar',
        keep: 'x'.repeat(1000),
        nested: {
          apiKey: 'should-not-leak',
          value: 'safe-value',
        },
      },
    };

    const model = deriveActionPreview(input);
    const keys = model.structuredArgs.map((row) => row.key.toLowerCase());
    const safeRawKeys = Object.keys(model.safeRawArgs).map((key) => key.toLowerCase());

    expect(keys.some((key) => key.includes('token'))).toBe(false);
    expect(keys.some((key) => key.includes('authorization'))).toBe(false);
    expect(keys.some((key) => key.includes('cookie'))).toBe(false);
    expect(safeRawKeys).not.toContain('token');
    expect(safeRawKeys).not.toContain('authorization');
    expect(safeRawKeys).not.toContain('cookie');
    expect(model.structuredArgs.length).toBeLessThanOrEqual(24);
    for (const row of model.structuredArgs) {
      expect(row.value.length).toBeLessThanOrEqual(240);
    }
  });
});

describe('projector registry coverage', () => {
  it('contains projectors for every ActionEffectKind', () => {
    const expected: ActionEffectKind[] = [
      'document',
      'message',
      'data-capture',
      'command',
      'external-record',
      'browser',
      'generic',
    ];

    expect(Object.keys(EFFECT_PROJECTOR_REGISTRY).sort()).toEqual([...expected].sort());
    for (const kind of expected) {
      expect(EFFECT_PROJECTOR_REGISTRY[kind]).toBeDefined();
      expect(typeof EFFECT_PROJECTOR_REGISTRY[kind].project).toBe('function');
    }
  });
});

describe('isNewFile mapper threading', () => {
  it('preserves isNewFile through deriveUnifiedApprovals on desktop-style memory inputs', () => {
    const memoryInput: MemoryApprovalInput = {
      toolUseId: 'mem-1',
      originalSessionId: 'session-1',
      filePath: 'memory/sources/260529_1200_meeting_strategy.md',
      spaceName: 'Chief of Staff',
      summary: 'Meeting notes',
      content: 'content',
      timestamp: 1_700_000_000_000,
      isNewFile: true,
    };

    const context = new Map<string, SessionContextForApprovals>();
    context.set('session-1', {
      title: 'Session 1',
      messageCount: 0,
    });

    const items = deriveUnifiedApprovals({
      toolApprovals: [],
      memoryApprovals: [memoryInput],
      stagedCalls: [],
      stagedFiles: [],
      sessionContext: context,
    });

    expect(items).toHaveLength(1);
    expect(items[0].memoryApproval?.isNewFile).toBe(true);
  });
});

describe('source-capture filename parity', () => {
  it.each([
    '260418_1430_meeting_q3-review.md',
    '260420_0000_pdf_annual-report.md',
    'notes.md',
    '260418_meeting_q3-review.md',
    'random-file-name.txt',
  ])('keeps shared and renderer filename detection aligned for %s', (fileName) => {
    const sharedDetection = isSourceCaptureFileName(fileName);
    const rendererDetection = Object.keys(extractSourceMetadataFromFileName(fileName)).length > 0;
    expect(sharedDetection).toBe(rendererDetection);
  });
});

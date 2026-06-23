import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import type { SessionToolEvent } from '@rebel/cloud-client';
import { TurnToolActivity } from '../TurnToolActivity';
import { hapticLight } from '../../utils/haptics';

type StructuredFallback = NonNullable<NonNullable<SessionToolEvent['mcpAppUiMeta']>['structuredFallback']>;

jest.mock('@expo/vector-icons', () => {
  const { Text } = require('react-native');
  return {
    Feather: ({ name }: { name: string }) => <Text>{name}</Text>,
  };
});

jest.mock('../../utils/haptics', () => ({
  hapticLight: jest.fn(),
}));

function makePrimaryEvent(
  structuredFallback?: StructuredFallback,
): SessionToolEvent {
  return {
    type: 'tool',
    toolName: 'compose_workspace_email',
    detail: 'Draft ready',
    stage: 'end',
    timestamp: 1,
    toolUseId: 'tu-compose',
    mcpAppUiMeta: {
      resourceUri: 'ui://google-workspace/compose-email',
      presentation: 'primary',
      viewSummary: 'Email draft ready.',
      viewRoleLabel: 'Editable email draft',
      ...(structuredFallback ? { structuredFallback } : {}),
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('TurnToolActivity primary MCP App placeholder', () => {
  it('renders the missing-meta fallback path unchanged', () => {
    const { queryByTestId } = render(
      <TurnToolActivity turnId="turn-1" events={[]} />,
    );

    expect(queryByTestId('primary-mcp-app-placeholder')).toBeNull();
  });

  it('renders email-draft structured fallback with a copy action', () => {
    const { getByText } = render(
      <TurnToolActivity
        turnId="turn-1"
        events={[
          makePrimaryEvent({
            kind: 'email-draft',
            payload: {
              to: ['person@example.com'],
              cc: ['team@example.com'],
              bcc: [],
              subject: 'Hello',
              body: 'Draft body.',
            },
          }),
        ]}
      />,
    );

    expect(getByText('Editable email draft')).toBeTruthy();
    expect(getByText(/person@example\.com/)).toBeTruthy();
    expect(getByText(/team@example\.com/)).toBeTruthy();
    expect(getByText(/Hello/)).toBeTruthy();
    expect(getByText('Draft body.')).toBeTruthy();
    expect(getByText('Copy draft')).toBeTruthy();
  });

  it('writes the email draft to clipboard when Copy draft is pressed', () => {
    const writeText = jest.fn(async () => {});
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { clipboard: { writeText } },
    });
    const { getByText } = render(
      <TurnToolActivity
        turnId="turn-1"
        events={[
          makePrimaryEvent({
            kind: 'email-draft',
            payload: {
              to: ['person@example.com'],
              cc: ['team@example.com'],
              bcc: [],
              subject: 'Hello',
              body: 'Draft body.',
            },
          }),
        ]}
      />,
    );

    fireEvent.press(getByText('Copy draft'));

    expect(hapticLight).toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith([
      'Email draft ready.',
      '[Editable email draft]',
      'To: person@example.com',
      'Cc: team@example.com',
      'Subject: Hello',
      '',
      'Draft body.',
    ].join('\n'));
  });

  it('renders primary presentation without structuredFallback as summary and tagline only', () => {
    const { getByText, queryByText } = render(
      <TurnToolActivity
        turnId="turn-1"
        events={[makePrimaryEvent()]}
      />,
    );

    expect(getByText('Editable email draft')).toBeTruthy();
    expect(getByText('Email draft ready.')).toBeTruthy();
    expect(getByText("You can read it here. Edit and send from your computer when you're ready.")).toBeTruthy();
    expect(queryByText('Copy draft')).toBeNull();
    expect(queryByText('Copy details')).toBeNull();
  });

  it('renders plain structured fallback markdown content', () => {
    const { getByText } = render(
      <TurnToolActivity
        turnId="turn-1"
        events={[
          makePrimaryEvent({
            kind: 'plain',
            payload: { markdown: 'Plain fallback content.' },
          }),
        ]}
      />,
    );

    expect(getByText('Plain fallback content.')).toBeTruthy();
    expect(getByText('Copy details')).toBeTruthy();
  });

  it('renders calendar-pick structured fallback options', () => {
    const { getByText } = render(
      <TurnToolActivity
        turnId="turn-1"
        events={[
          makePrimaryEvent({
            kind: 'calendar-pick',
            payload: {
              title: 'Choose a time',
              options: [
                { id: 'slot-1', label: 'Tuesday 10:00', start: '2026-05-12T10:00:00Z' },
              ],
            },
          }),
        ]}
      />,
    );

    expect(getByText('Choose a time')).toBeTruthy();
    expect(getByText('• Tuesday 10:00 — 2026-05-12T10:00:00Z')).toBeTruthy();
  });

  it('renders document-outline structured fallback sections', () => {
    const { getByText } = render(
      <TurnToolActivity
        turnId="turn-1"
        events={[
          makePrimaryEvent({
            kind: 'document-outline',
            payload: {
              title: 'Launch memo',
              sections: [
                { heading: 'Summary', bullets: ['Audience', 'Timing'] },
              ],
            },
          }),
        ]}
      />,
    );

    expect(getByText('Launch memo')).toBeTruthy();
    expect(getByText('• Summary — Audience; Timing')).toBeTruthy();
  });

  it('renders additional primary placeholders with role labels and summaries instead of generic work steps', () => {
    const secondPrimary = makePrimaryEvent();
    secondPrimary.toolUseId = 'tu-second-primary';
    secondPrimary.timestamp = 2;
    secondPrimary.toolName = 'secondary_primary_tool';
    secondPrimary.detail = 'Second draft ready';
    // makePrimaryEvent always sets mcpAppUiMeta (with the required resourceUri);
    // the `!` keeps `resourceUri` non-optional through the spread.
    secondPrimary.mcpAppUiMeta = {
      ...secondPrimary.mcpAppUiMeta!,
      viewSummary: 'Second email draft ready.',
      viewRoleLabel: 'Secondary email draft',
    };

    const { getAllByTestId, getByText, queryAllByText } = render(
      <TurnToolActivity
        turnId="turn-1"
        events={[makePrimaryEvent(), secondPrimary]}
      />,
    );

    expect(getAllByTestId('primary-mcp-app-placeholder')).toHaveLength(2);
    expect(getByText('Secondary email draft')).toBeTruthy();
    expect(getByText('Second email draft ready.')).toBeTruthy();
    // The secondary primary tool name should not surface as a regular step row,
    // because `presentation: 'primary'` events are filtered from the activity log.
    expect(queryAllByText(/Secondary Primary Tool/)).toHaveLength(0);
  });

  it('defensively renders unknown structured fallback kinds without crashing', () => {
    const { getByText, queryByText } = render(
      <TurnToolActivity
        turnId="turn-1"
        events={[
          makePrimaryEvent({
            kind: 'future-kind',
            payload: { label: 'Future payload' },
          } as unknown as StructuredFallback),
        ]}
      />,
    );

    expect(getByText('Editable email draft')).toBeTruthy();
    expect(getByText('Email draft ready.')).toBeTruthy();
    expect(getByText("You can read it here. Edit and send from your computer when you're ready.")).toBeTruthy();
    expect(queryByText('Future payload')).toBeNull();
    expect(getByText('Copy details')).toBeTruthy();
  });
});

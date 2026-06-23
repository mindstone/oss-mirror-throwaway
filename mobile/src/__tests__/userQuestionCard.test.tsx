/**
 * UserQuestionCard (mobile) — render + interaction tests.
 *
 * Covers the essential user flows:
 *  - Pending card renders question + options
 *  - Selecting a single-select option enables the submit button
 *  - Submit calls onSubmit with the expected answer payload
 *  - Skip-all calls onSkip
 *  - Dismiss calls onDismiss
 *  - Answered state shows the summary
 *
 * See docs/plans/260420_user_question_cross_surface_resilience.md Stage 5.
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

jest.mock('@expo/vector-icons', () => {
  const { Text } = require('react-native');
  return {
    Feather: ({ name, ...props }: { name: string }) => (
      <Text testID={`icon-${name}`} {...props} />
    ),
  };
});

import { UserQuestionCard } from '../components/UserQuestionCard';
import type { UserQuestionBatch } from '@shared/types';

function makeBatch(overrides: Partial<UserQuestionBatch> = {}): UserQuestionBatch {
  return {
    batchId: 'b-1',
    toolUseId: 'tu-1',
    turnId: 't-1',
    sessionId: 's-1',
    timestamp: Date.now(),
    questions: [
      {
        id: 'q1',
        question: 'Which format?',
        header: 'Format',
        options: [
          { id: 'q1-opt1', label: 'Bullet', description: '' },
          { id: 'q1-opt2', label: 'Paragraph', description: '' },
        ],
        multiSelect: false,
      },
    ],
    ...overrides,
  };
}

describe('UserQuestionCard (mobile)', () => {
  it('renders the question text and options', () => {
    const { getByText } = render(
      <UserQuestionCard
        batch={makeBatch()}
        isAnswered={false}
        isSubmitting={false}
        onSubmit={jest.fn()}
        onSkip={jest.fn()}
        onDismiss={jest.fn()}
      />,
    );
    expect(getByText('Which format?')).toBeTruthy();
    expect(getByText('Bullet')).toBeTruthy();
    expect(getByText('Paragraph')).toBeTruthy();
  });

  it('submits the selected answer', async () => {
    const onSubmit = jest.fn().mockResolvedValue(undefined);
    const { getByTestId } = render(
      <UserQuestionCard
        batch={makeBatch()}
        isAnswered={false}
        isSubmitting={false}
        onSubmit={onSubmit}
        onSkip={jest.fn()}
        onDismiss={jest.fn()}
      />,
    );

    fireEvent.press(getByTestId('user-question-option-q1-opt1'));
    fireEvent.press(getByTestId('user-question-next-b-1'));

    expect(onSubmit).toHaveBeenCalledWith('b-1', [
      { questionId: 'q1', selectedOptionIds: ['q1-opt1'] },
    ]);
  });

  it('skip-all calls onSkip', () => {
    const onSkip = jest.fn();
    const { getByTestId } = render(
      <UserQuestionCard
        batch={makeBatch()}
        isAnswered={false}
        isSubmitting={false}
        onSubmit={jest.fn()}
        onSkip={onSkip}
        onDismiss={jest.fn()}
      />,
    );

    fireEvent.press(getByTestId('user-question-skip-b-1'));
    expect(onSkip).toHaveBeenCalledWith('b-1');
  });

  it('dismiss calls onDismiss', () => {
    const onDismiss = jest.fn();
    const { getByTestId } = render(
      <UserQuestionCard
        batch={makeBatch()}
        isAnswered={false}
        isSubmitting={false}
        onSubmit={jest.fn()}
        onSkip={jest.fn()}
        onDismiss={onDismiss}
      />,
    );

    fireEvent.press(getByTestId('user-question-dismiss-b-1'));
    expect(onDismiss).toHaveBeenCalledWith('b-1');
  });

  it('renders the answered state with the selected label', () => {
    const { getByText } = render(
      <UserQuestionCard
        batch={makeBatch()}
        isAnswered={true}
        answers={[{ questionId: 'q1', selectedOptionIds: ['q1-opt2'] }]}
        isSubmitting={false}
        onSubmit={jest.fn()}
        onSkip={jest.fn()}
        onDismiss={jest.fn()}
      />,
    );
    expect(getByText('You answered')).toBeTruthy();
    expect(getByText('Paragraph')).toBeTruthy();
  });

  it('renders the skipped state', () => {
    const { getByText } = render(
      <UserQuestionCard
        batch={makeBatch()}
        isAnswered={true}
        skipped={true}
        isSubmitting={false}
        onSubmit={jest.fn()}
        onSkip={jest.fn()}
        onDismiss={jest.fn()}
      />,
    );
    expect(getByText('You skipped these questions')).toBeTruthy();
  });

  it('renders approval clarification copy without generic skip', () => {
    const { getByText, queryByTestId } = render(
      <UserQuestionCard
        batch={makeBatch({
          questions: [{
            ...makeBatch().questions[0],
            purpose: 'approval_clarification',
            context: 'I found two calendars that could fit.',
          }],
        })}
        isAnswered={false}
        isSubmitting={false}
        onSubmit={jest.fn()}
        onSkip={jest.fn()}
        onDismiss={jest.fn()}
      />,
    );

    expect(getByText('One detail before continuing')).toBeTruthy();
    expect(getByText('This only clarifies this request. Rebel checks your Safety Rules before acting.')).toBeTruthy();
    expect(queryByTestId('user-question-skip-b-1')).toBeNull();
    expect(queryByTestId('user-question-cancel-b-1')).toBeNull();
  });

  it('submits Something else text for approval clarification', async () => {
    const onSubmit = jest.fn().mockResolvedValue(undefined);
    const { getByText, getByTestId } = render(
      <UserQuestionCard
        batch={makeBatch({
          questions: [{
            ...makeBatch().questions[0],
            purpose: 'approval_clarification',
            context: 'I found two calendars that could fit.',
          }],
        })}
        isAnswered={false}
        isSubmitting={false}
        onSubmit={onSubmit}
        onSkip={jest.fn()}
        onDismiss={jest.fn()}
      />,
    );

    expect(getByText('Something else')).toBeTruthy();
    fireEvent.press(getByTestId('user-question-option-__other__'));
    fireEvent.changeText(getByTestId('user-question-input-__other__'), 'Use the client calendar');
    fireEvent.press(getByTestId('user-question-next-b-1'));

    expect(onSubmit).toHaveBeenCalledWith('b-1', [
      {
        questionId: 'q1',
        selectedOptionIds: [],
        freeText: 'Use the client calendar',
      },
    ]);
  });

  it('submits Something else text for generic option questions', async () => {
    const onSubmit = jest.fn().mockResolvedValue(undefined);
    const { getByText, getByTestId } = render(
      <UserQuestionCard
        batch={makeBatch()}
        isAnswered={false}
        isSubmitting={false}
        onSubmit={onSubmit}
        onSkip={jest.fn()}
        onDismiss={jest.fn()}
      />,
    );

    expect(getByText('Something else')).toBeTruthy();
    fireEvent.press(getByTestId('user-question-option-__other__'));
    fireEvent.changeText(getByTestId('user-question-input-__other__'), 'Use a short memo');
    fireEvent.press(getByTestId('user-question-next-b-1'));

    expect(onSubmit).toHaveBeenCalledWith('b-1', [
      {
        questionId: 'q1',
        selectedOptionIds: [],
        freeText: 'Use a short memo',
      },
    ]);
  });

  it('submits free-text-only generic questions', async () => {
    const onSubmit = jest.fn().mockResolvedValue(undefined);
    const { getByTestId } = render(
      <UserQuestionCard
        batch={makeBatch({
          questions: [{
            ...makeBatch().questions[0],
            question: 'What exact note should I send?',
            options: [],
          }],
        })}
        isAnswered={false}
        isSubmitting={false}
        onSubmit={onSubmit}
        onSkip={jest.fn()}
        onDismiss={jest.fn()}
      />,
    );

    fireEvent.changeText(getByTestId('user-question-input-__other__'), 'Hi Kofo, checking in.');
    fireEvent.press(getByTestId('user-question-next-b-1'));

    expect(onSubmit).toHaveBeenCalledWith('b-1', [
      {
        questionId: 'q1',
        selectedOptionIds: [],
        freeText: 'Hi Kofo, checking in.',
      },
    ]);
  });

  it('does not submit when no option is selected', () => {
    const onSubmit = jest.fn();
    const { getByTestId } = render(
      <UserQuestionCard
        batch={makeBatch()}
        isAnswered={false}
        isSubmitting={false}
        onSubmit={onSubmit}
        onSkip={jest.fn()}
        onDismiss={jest.fn()}
      />,
    );

    // Submit button is disabled — pressing should be a no-op.
    fireEvent.press(getByTestId('user-question-next-b-1'));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

// @ts-nocheck
import * as React from 'react';
import { useMemo, useState } from 'react';
import { MentionHeroInput } from '@renderer/features/composer/components/MentionHeroInput';

const meta = {
  title: 'Design System/Molecules/Hero Input',
  parameters: {
    layout: 'fullscreen',
    controls: { disable: true },
    docs: {
      description: {
        component:
          'Shared molecule review page for the prominent composer-style input used on Homepage and Automations. This is not the same family as plain Input/Textarea atoms.',
      },
    },
  },
};

export default meta;

function buildMentionProps() {
  return {
    mentionResultsForQuery: () => [],
    ensureLibraryIndex: () => {},
    getRelativeLibraryPath: (path) => path,
    hasWorkspace: true,
    hasConversations: true,
    coreDirectory: null,
    libraryIndex: null,
    libraryIndexLoading: false,
    libraryIndexError: null,
    refreshLibraryIndex: async () => {},
  };
}

function buildAttachmentProps() {
  return {
    attachments: [],
    onAddFiles: async () => {},
    onRemoveAttachment: () => {},
    onPasteAttachment: async () => false,
    canAddMore: true,
    isDragging: false,
    onDragEnter: () => {},
    onDragLeave: () => {},
    onDragOver: () => {},
    onDrop: () => {},
  };
}

const MULTILINE_SEED = [
  'Draft a reply to the board about the Q3 numbers,',
  'flag anything that looks off,',
  'and keep it to three short paragraphs.',
].join('\n');

const OVERFLOW_SEED = Array.from(
  { length: 14 },
  (_, i) => `Line ${i + 1}: this is a long enough prompt to push past the max-height cap and start scrolling.`,
).join('\n');

function HeroInputStoryPage() {
  const [basicValue, setBasicValue] = useState('');
  const [richValue, setRichValue] = useState('');
  const [multilineValue, setMultilineValue] = useState(MULTILINE_SEED);
  const [overflowValue, setOverflowValue] = useState(OVERFLOW_SEED);
  const mentionProps = useMemo(() => buildMentionProps(), []);
  const attachmentProps = useMemo(() => buildAttachmentProps(), []);

  return (
    <div style={{ display: 'grid', gap: 28, padding: '32px 24px', maxWidth: 1040 }}>
        <section style={{ display: 'grid', gap: 10 }}>
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              alignSelf: 'start',
              padding: '4px 10px',
              borderRadius: 999,
              background: 'rgba(148,163,184,0.14)',
              color: 'var(--color-text-secondary)',
              fontSize: 12,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
            }}
          >
            Molecule
          </div>
          <h1 style={{ margin: 0, fontSize: 32, lineHeight: 1.2 }}>Hero Input</h1>
          <p style={{ margin: 0, color: 'var(--color-text-secondary)', lineHeight: 1.55, maxWidth: 760 }}>
            The base text entry atoms are still `Input` and `Textarea`, but this richer prompt-entry
            surface is a molecule because it combines text entry, icon actions, submit behavior,
            mention support, and optional attachments.
          </p>
        </section>

      <section
        style={{
          display: 'grid',
          gap: 8,
          padding: 16,
          borderRadius: 16,
          border: '1px solid rgba(255,255,255,0.08)',
          background: 'rgba(255,255,255,0.03)',
          lineHeight: 1.55,
        }}
      >
        <div><strong>How this should be used</strong> - prominent prompt-entry surfaces where users may need voice, attachments, and mentions in one coherent input molecule.</div>
        <div><strong>Where it is used now</strong> - Homepage and Automations use the shared molecule.</div>
        <div><strong>Not for</strong> - ordinary forms, settings rows, search bars, or plain text fields. Those should stay on the lower-level atoms.</div>
      </section>

        <section style={{ display: 'grid', gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 12, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--color-text-secondary)' }}>
            Base molecule
          </h2>
          <MentionHeroInput
            value={basicValue}
            onChange={setBasicValue}
            onSubmit={() => {}}
            placeholder="Tell me what you need..."
            ariaLabel="Hero input example"
            submitAriaLabel="Send"
            {...mentionProps}
          />
        </section>

        <section style={{ display: 'grid', gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 12, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--color-text-secondary)' }}>
            Molecule with voice and attachments
          </h2>
          <MentionHeroInput
            value={richValue}
            onChange={setRichValue}
            onSubmit={() => {}}
            placeholder='e.g. "Summarize my emails every morning at 9am"'
            ariaLabel="Hero input with voice and attachments"
            submitAriaLabel="Create automation"
            attachmentProps={attachmentProps}
            voiceButtonProps={{
              isRecording: false,
              isProcessing: false,
              disabled: false,
              audioLevel: 0,
              onToggle: () => {},
            }}
            {...mentionProps}
          />
        </section>

        <section style={{ display: 'grid', gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 12, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--color-text-secondary)' }}>
            Multiline (auto-expanded)
          </h2>
          <MentionHeroInput
            value={multilineValue}
            onChange={setMultilineValue}
            onSubmit={() => {}}
            placeholder="Tell me what you need..."
            ariaLabel="Hero input with multiline content"
            submitAriaLabel="Send"
            attachmentProps={attachmentProps}
            voiceButtonProps={{
              isRecording: false,
              isProcessing: false,
              disabled: false,
              audioLevel: 0,
              onToggle: () => {},
            }}
            {...mentionProps}
          />
        </section>

        <section style={{ display: 'grid', gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 12, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--color-text-secondary)' }}>
            At max height (scrolls)
          </h2>
          <MentionHeroInput
            value={overflowValue}
            onChange={setOverflowValue}
            onSubmit={() => {}}
            placeholder="Tell me what you need..."
            ariaLabel="Hero input past the max-height cap"
            submitAriaLabel="Send"
            {...mentionProps}
          />
        </section>

        <section
          style={{
            display: 'grid',
            gap: 8,
            padding: 16,
            borderRadius: 16,
            border: '1px solid rgba(255,255,255,0.08)',
            background: 'rgba(255,255,255,0.03)',
            lineHeight: 1.55,
            color: 'var(--color-text-secondary)',
          }}
        >
          <div style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>Review note</div>
          <div>
            This should be reviewed as a prompt-entry molecule, not as a variant of plain `Input`.
          </div>
        </section>
    </div>
  );
}

export const CurrentReality = {
  render: () => <HeroInputStoryPage />,
};

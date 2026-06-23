import * as React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Mic, Paperclip } from 'lucide-react';
import { IconButton, Input, Label, Select, Textarea } from '@renderer/components/ui';
import heroInputStyles from '@renderer/features/composer/components/MentionHeroInput.module.css';

const meta = {
  title: 'Design System/Atoms/Inputs',
  component: Input,
  parameters: {
    layout: 'fullscreen',
    controls: { disable: true },
    docs: {
      description: {
        component:
          'Canonical input gallery. Shows the shared text-entry atoms, where they should be used, where they are used now, and how they differ from the richer hero/composer input molecule.',
      },
    },
  },
} satisfies Meta<typeof Input>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Gallery: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 24, maxWidth: 760, padding: 24 }}>
      <section style={{ display: 'grid', gap: 8 }}>
        <h1 style={{ margin: 0, fontSize: 28 }}>Inputs</h1>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
          Shared input atoms plus the richer Hero Input molecule. Use this page to compare simple
          form fields with composer-style input surfaces.
        </p>
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>How these should be used</h2>
        <div
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
          <div><strong>Input</strong> - single-line or simple text entry inside forms and settings.</div>
          <div><strong>Textarea</strong> - multi-line freeform input where users are composing or editing longer content.</div>
          <div><strong>Label</strong> - explicit form labels tied to atoms by `htmlFor`.</div>
          <div><strong>Select</strong> - low-ambiguity choice where the label and surrounding row already explain the decision.</div>
          <div><strong>Search fields</strong> - should usually compose `Input` inside a wrapper that owns the icon, clear button, or filter chips.</div>
          <div><strong>Fill relationship</strong> - adjacent icon buttons and inputs should share radius/border/token language, but the input may use a calmer fill so it reads as the editable field.</div>
        </div>
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Where they are used now</h2>
        <div
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
          <div><strong>Input / Textarea</strong> - settings forms, dialogs, bug reports, profile editing, and structured editing flows.</div>
          <div><strong>Select</strong> - increasingly used in settings-heavy flows such as `VoiceTab`, `BtsTaskOverrides`, `CloudTab`, and account/safety settings.</div>
          <div><strong>Search inputs</strong> - conversation search, inbox search, library search, quick open, go-to-heading, settings search, and find-in-page should all compose the shared `Input` where practical.</div>
        </div>
      </section>

      <section style={{ display: 'grid', gap: 20, maxWidth: 520 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Shared input primitives</h2>
      <div style={{ display: 'grid', gap: 8 }}>
        <Label htmlFor="storybook-input">Title</Label>
        <Input id="storybook-input" placeholder="Enter text..." inputSize="md" />
      </div>

      <div style={{ display: 'grid', gap: 8 }}>
        <Label htmlFor="storybook-input-error">Error state</Label>
        <Input
          id="storybook-input-error"
          inputSize="md"
          error
          defaultValue="Needs attention"
        />
      </div>

      <div style={{ display: 'grid', gap: 8 }}>
        <Label htmlFor="storybook-textarea">Summary</Label>
        <Textarea
          id="storybook-textarea"
          rows={4}
          placeholder="Describe the change you want to make..."
        />
      </div>

      <div style={{ display: 'grid', gap: 8 }}>
        <Label htmlFor="storybook-select">Mode</Label>
        <Select id="storybook-select" defaultValue="balanced">
          <option value="balanced">Balanced</option>
          <option value="careful">Careful</option>
          <option value="fast">Fast</option>
        </Select>
      </div>
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Current app embedded input pattern</h2>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)', maxWidth: 760 }}>
          This richer prompt-entry surface is not a plain input atom. It belongs to the `Hero Input`
          molecule because it combines text entry with inline actions and submit behavior.
        </p>
        <div className={heroInputStyles.heroInputContainer} style={{ maxWidth: 760 }}>
          <div className={heroInputStyles.inputRow}>
            <IconButton variant="ghost" size="lg" className={heroInputStyles.leadingIconButton} aria-label="Voice">
              <Mic size={18} />
            </IconButton>
            <input
              className={heroInputStyles.heroInput}
              aria-label="Hero input example"
              placeholder="Tell me what you need..."
              value=""
              readOnly
            />
            <IconButton variant="ghost" size="lg" className={heroInputStyles.trailingIconButton} aria-label="Attach file">
              <Paperclip size={18} />
            </IconButton>
            <button type="button" className={heroInputStyles.heroInputSubmit} aria-label="Submit">
              →
            </button>
          </div>
        </div>
      </section>
    </div>
  ),
};

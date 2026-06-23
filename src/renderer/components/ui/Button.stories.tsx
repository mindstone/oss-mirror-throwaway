import * as React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { ArrowRight, Bell, Loader2, Mic, Paperclip, Plus, Search } from 'lucide-react';
import { Button, IconButton } from '@renderer/components/ui';

const meta = {
  title: 'Design System/Atoms/Buttons',
  component: Button,
  parameters: {
    layout: 'fullscreen',
    controls: { disable: true },
    docs: {
      description: {
        component:
          'Canonical button gallery. Shows the shared `Button` atom plus the shared `IconButton` atom used for compact icon-only actions.',
      },
    },
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Gallery: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 28, padding: 24 }}>
      <section style={{ display: 'grid', gap: 8 }}>
        <h1 style={{ margin: 0, fontSize: 28 }}>Buttons</h1>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)', maxWidth: 760 }}>
          Shared atoms. This page shows the real shared `Button` atom variants plus the shared
          `IconButton` atom used for compact icon-only actions.
        </p>
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>How these variants should be used</h2>
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
          <div><strong>Default</strong> - the strongest non-destructive CTA on a surface. Use sparingly.</div>
          <div><strong>Secondary</strong> - a soft filled action for calm card CTAs and app-level actions like New. It should feel active without becoming the primary action.</div>
          <div><strong>Ghost</strong> - inline or low-emphasis actions that should stay calm.</div>
          <div><strong>Outline</strong> - bounded actions that need a visible frame. Keep this as its own loved style rather than using it as the secondary default.</div>
          <div><strong>Destructive</strong> - actions that are dangerous, irreversible, or clearly high-risk.</div>
        </div>
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Where they are used now</h2>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)', maxWidth: 760 }}>
          This section is only here as migration context. If current usage conflicts with the intended
          usage above, the intended usage should win as we refactor.
        </p>
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
          <div><strong>Default</strong> - setup and commit actions in places like `AppBridgePairSection`, `McpAccountsExtension`, and parts of onboarding.</div>
          <div><strong>Secondary</strong> - soft filled CTAs in cards, composer affordances, contribution prompts, recovery cards, and app-level actions like `New`.</div>
          <div><strong>Ghost</strong> - the dominant quiet action across dialogs, cards, settings sections, and navigation helpers.</div>
          <div><strong>Outline</strong> - card-local and dialog-local secondary actions, especially in inbox/library/settings flows.</div>
          <div><strong>Destructive</strong> - high-risk actions in automations, cloud settings, safety/editor resets, and a handful of user-facing destructive flows.</div>
        </div>
      </section>

      <section style={{ display: 'grid', gap: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Contrast on dark surfaces</h2>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)', maxWidth: 760 }}>
          Buttons rarely live on a blank canvas in Rebel. This panel helps review whether secondary,
          outline, ghost, and destructive remain legible on darker card-like surfaces.
        </p>
        <div
          style={{
            display: 'grid',
            gap: 12,
            padding: 20,
            borderRadius: 18,
            background: 'rgba(13, 17, 28, 0.95)',
            border: '1px solid rgba(148, 163, 184, 0.14)',
            maxWidth: 760,
          }}
        >
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <Button>Primary action</Button>
            <Button variant="secondary">Secondary action</Button>
            <Button variant="secondary" size="xs">
              Prep
            </Button>
            <Button variant="outline">Outline action</Button>
            <Button variant="ghost">Ghost action</Button>
            <Button variant="destructive">Delete item</Button>
          </div>
          <div style={{ color: 'var(--color-text-secondary)', fontSize: 13, lineHeight: 1.5 }}>
            Hover behavior should now stay flat - background, border, contrast shifts, and a soft outer
            shadow only. No lift, no 3D motion, and no inner gloss effect.
          </div>
        </div>
      </section>

      <section style={{ display: 'grid', gap: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Shared button variants</h2>
        {(['default', 'secondary', 'ghost', 'outline', 'destructive'] as const).map((variant) => (
          <div key={variant} style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ width: 96, color: 'var(--color-text-secondary)', textTransform: 'capitalize' }}>
              {variant}
            </div>
            <Button variant={variant}>Default</Button>
            <Button variant={variant} size="sm">
              Small
            </Button>
            <Button variant={variant} size="lg">
              Large
            </Button>
            <Button variant={variant} disabled>
              Disabled
            </Button>
          </div>
        ))}
      </section>

      <section style={{ display: 'grid', gap: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Shared button compositions</h2>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)', maxWidth: 760 }}>
          These are still the real shared `Button` component. It does not have a dedicated icon API yet, so left/right
          icons and loading states are currently composed through `children`.
        </p>
        <div style={{ display: 'grid', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ width: 120, color: 'var(--color-text-secondary)' }}>Left icon</div>
            <Button>
              <Plus size={16} />
              New item
            </Button>
            <Button variant="secondary">
              <Bell size={16} />
              Notify
            </Button>
            <Button variant="outline">
              <Mic size={16} />
              Record
            </Button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ width: 120, color: 'var(--color-text-secondary)' }}>Right icon</div>
            <Button>
              Continue
              <ArrowRight size={16} />
            </Button>
            <Button variant="secondary" size="xs">
              Review
              <ArrowRight size={12} />
            </Button>
            <Button variant="ghost">
              Learn more
              <ArrowRight size={16} />
            </Button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ width: 120, color: 'var(--color-text-secondary)' }}>Icon only</div>
            <IconButton size="lg" aria-label="Add item">
              <Plus size={16} />
            </IconButton>
            <IconButton size="lg" active aria-label="Notifications">
              <Bell size={16} />
            </IconButton>
            <IconButton size="lg" variant="subtle" aria-label="Search">
              <Search size={16} />
            </IconButton>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ width: 120, color: 'var(--color-text-secondary)' }}>Loading-style</div>
            <Button disabled>
              <Loader2 size={16} className="animate-spin" />
              Loading
            </Button>
            <Button variant="secondary" disabled>
              <Loader2 size={16} className="animate-spin" />
              Saving
            </Button>
            <Button variant="secondary" size="xs" disabled>
              <Loader2 size={12} className="animate-spin" />
              Prepping
            </Button>
            <IconButton size="lg" disabled aria-label="Loading">
              <Loader2 size={16} className="animate-spin" />
            </IconButton>
          </div>
        </div>
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Sizes in the real app</h2>
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
          <div><strong>`xs`</strong> exists and is used in dense places like `LocalSttModelSection`, `InboxItemCard`, and `ApprovalPointerBar`.</div>
          <div><strong>`sm`</strong> is the common compact size for dialogs, lists, and settings actions.</div>
          <div><strong>`default`</strong> is the baseline page/action size.</div>
          <div><strong>`lg`</strong> is mainly for stronger CTAs and hero/onboarding moments.</div>
          <div><strong>`icon`</strong> is still present on `Button` for legacy compatibility, but truly icon-only actions should use the grey-stroked `IconButton` atom.</div>
        </div>
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Shared icon button atom</h2>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)', maxWidth: 760 }}>
          Shared `IconButton` atom, shown with the same quiet, square utility language used inside
          the hero/composer input.
        </p>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <IconButton size="lg" variant="ghost" aria-label="Voice">
            <Mic size={18} />
          </IconButton>
          <IconButton
            size="lg"
            variant="ghost"
            active
            aria-label="Notifications on"
            aria-pressed="true"
          >
            <Bell size={16} />
          </IconButton>
          <IconButton size="lg" variant="ghost" aria-label="Attach file">
            <Paperclip size={18} />
          </IconButton>
          <IconButton size="lg" variant="ghost" aria-label="Search">
            <Search size={18} />
          </IconButton>
        </div>
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Open review questions</h2>
        <div
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
          <div>`tertiary` has been removed from the shared atom because it had no real product usage.</div>
          <div>Does `secondary` now feel sufficiently distinct from `default` while still staying readable?</div>
          <div>Do we now have the right button set: primary, secondary, ghost, outline, destructive?</div>
          <div>Does the outline variant now feel close enough to the calmer in-app bounded buttons?</div>
          <div>Does the current 12px button radius still feel too soft for Rebel&apos;s visual language?</div>
          <div>The app font is currently Figtree. If the button text feels off, the likely culprits are weight, spacing, radius, or contrast rather than the font family alone.</div>
        </div>
      </section>
    </div>
  ),
};

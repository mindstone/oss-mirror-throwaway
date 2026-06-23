import type { CSSProperties } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { ImageGrid } from './ImageGrid';
import { ImageTile } from './ImageTile';
import type { ImageGridItem } from './imageGridSource';

const meta: Meta<typeof ImageGrid> = {
  title: 'Agent Session/Tool Results/Image Grid',
  component: ImageGrid,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Tool-result thumbnail grid for the conversation transcript. Count-routes between large solo (1-3), dense grid (4-12), and bounded preview with virtualized modal (13+).',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ImageGrid>;

// ─── Fixture helpers ─────────────────────────────────────────────────────

const TRANSPARENT_PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const SVG_DATA_URI = (
  label: string,
  width: number,
  height: number,
  bg: string,
  fg: string = '#ffffff',
): string => {
  const xmlns = 'http://www.w3.org/2000/svg';
  const svg = `<svg xmlns='${xmlns}' viewBox='0 0 ${width} ${height}' width='${width}' height='${height}'>
    <rect width='100%' height='100%' fill='${bg}'/>
    <text x='50%' y='50%' fill='${fg}' font-family='system-ui,sans-serif' font-size='${Math.max(18, Math.min(width, height) / 6)}' text-anchor='middle' dominant-baseline='central'>${label}</text>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
};

const PALETTE = ['#4f46e5', '#0ea5e9', '#16a34a', '#f59e0b', '#ef4444', '#a855f7', '#0284c7', '#65a30d'];

const makeItem = (index: number, total: number, opts: Partial<ImageGridItem> = {}): ImageGridItem => {
  const bg = PALETTE[index % PALETTE.length];
  const src = opts.tileSrc ?? SVG_DATA_URI(`${index + 1} / ${total}`, 240, 240, bg);
  return {
    key: `story-${index}`,
    tileSrc: src,
    fullSrc: opts.fullSrc ?? src,
    alt: `Tool result image ${index + 1} of ${total}`,
    mimeType: 'image/png',
    state: 'ready',
    ...opts,
  };
};

const makeItems = (count: number, opts: Partial<ImageGridItem> = {}): ImageGridItem[] =>
  Array.from({ length: count }, (_, index) => makeItem(index, count, opts));

// ─── Stories ──────────────────────────────────────────────────────────────

const themedPanelStyle: CSSProperties = {
  background: 'var(--color-card)',
  color: 'var(--color-text-primary)',
  padding: 'var(--space-4)',
  borderRadius: 'var(--radius-lg)',
};

const stackStyle: CSSProperties = {
  display: 'grid',
  gap: 'var(--space-6)',
};

const rowFlexStyle: CSSProperties = {
  display: 'flex',
  gap: 'var(--space-4)',
  flexWrap: 'wrap',
};

export const OneToThreeLargeImages: Story = {
  name: '1–3 images (large layout)',
  render: () => (
    <div style={stackStyle}>
      <section>
        <h4>1 image</h4>
        <ImageGrid images={makeItems(1)} />
      </section>
      <section>
        <h4>2 images</h4>
        <ImageGrid images={makeItems(2)} />
      </section>
      <section>
        <h4>3 images</h4>
        <ImageGrid images={makeItems(3)} />
      </section>
    </div>
  ),
};

export const FourToTwelveDenseGrid: Story = {
  name: '4–12 images (dense grid)',
  render: () => (
    <div style={stackStyle}>
      <section>
        <h4>4 images</h4>
        <ImageGrid images={makeItems(4)} />
      </section>
      <section>
        <h4>6 images</h4>
        <ImageGrid images={makeItems(6)} />
      </section>
      <section>
        <h4>9 images</h4>
        <ImageGrid images={makeItems(9)} />
      </section>
      <section>
        <h4>12 images</h4>
        <ImageGrid images={makeItems(12)} />
      </section>
    </div>
  ),
};

export const ThirteenPlusPreview: Story = {
  name: '13+ images (bounded preview)',
  render: () => (
    <div style={stackStyle}>
      <section>
        <h4>13 images</h4>
        <ImageGrid images={makeItems(13)} />
      </section>
      <section>
        <h4>24 images</h4>
        <ImageGrid images={makeItems(24)} />
      </section>
    </div>
  ),
};

export const HundredImageVirtualizedModal: Story = {
  name: '100+ images (virtualized strip in modal)',
  render: () => (
    <div>
      <p>
        Click the "+89 more" tile to open the modal viewer with a virtualized
        thumbnail strip backed by @tanstack/react-virtual.
      </p>
      <ImageGrid images={makeItems(100)} />
    </div>
  ),
};

export const TileStates: Story = {
  name: 'Tile states (loading / ready / failed / empty)',
  render: () => (
    <div style={rowFlexStyle}>
      <ImageTile src={SVG_DATA_URI('READY', 240, 240, PALETTE[2])} alt="Ready" state="ready" />
      <ImageTile src={SVG_DATA_URI('LOAD', 240, 240, PALETTE[1])} alt="Loading" state="loading" />
      <ImageTile src="rebel-asset://nonexistent" alt="Failed" state="failed" />
      <ImageTile src={TRANSPARENT_PIXEL} alt="Empty" state="empty" />
    </div>
  ),
};

export const FailureReasons: Story = {
  name: 'Failure modes (generic Stage 6 surface)',
  render: () => {
    const items: ImageGridItem[] = [
      { ...makeItem(0, 5), state: 'failed', tileSrc: 'rebel-asset://invalid/not-found' },
      { ...makeItem(1, 5), state: 'failed', tileSrc: 'rebel-asset://invalid/permission' },
      { ...makeItem(2, 5), state: 'failed', tileSrc: 'rebel-asset://invalid/corrupt' },
      { ...makeItem(3, 5), state: 'loading', tileSrc: SVG_DATA_URI('SYNCING', 240, 240, PALETTE[6]) },
      { ...makeItem(4, 5) },
    ];
    return (
      <div>
        <p>
          Stage 6 renders a generic "Image unavailable" state for any failure
          (Stage 9 will add reason-specific copy + tooltips).
        </p>
        <ImageGrid images={items} />
      </div>
    );
  },
};

export const LightAndDark: Story = {
  name: 'Light + dark theme (visual parity)',
  render: () => (
    <div style={stackStyle}>
      <section className="light" style={themedPanelStyle}>
        <h4 style={{ marginTop: 0 }}>Light</h4>
        <ImageGrid images={makeItems(6)} />
      </section>
      <section className="dark" style={themedPanelStyle}>
        <h4 style={{ marginTop: 0 }}>Dark</h4>
        <ImageGrid images={makeItems(6)} />
      </section>
    </div>
  ),
};

export const MixedAspectRatiosContain: Story = {
  name: 'Mixed aspect ratios (object-fit: contain)',
  render: () => {
    const items: ImageGridItem[] = [
      { ...makeItem(0, 4), tileSrc: SVG_DATA_URI('PORTRAIT', 240, 480, PALETTE[0]) },
      { ...makeItem(1, 4), tileSrc: SVG_DATA_URI('LANDSCAPE', 480, 240, PALETTE[1]) },
      { ...makeItem(2, 4), tileSrc: SVG_DATA_URI('SQUARE', 240, 240, PALETTE[2]) },
      { ...makeItem(3, 4), tileSrc: SVG_DATA_URI('PANORAMIC', 720, 200, PALETTE[5]) },
    ];
    return (
      <div>
        <p>Tiles use object-fit: contain — content is never cropped.</p>
        <ImageGrid images={items} />
      </div>
    );
  },
};

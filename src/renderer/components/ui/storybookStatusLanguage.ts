export type StorybookStatusKey = 'shared' | 'app-pattern' | 'missing';

export interface StorybookStatusPresentation {
  label: string;
  blurb: string;
  pillBackground: string;
  pillColor: string;
}

export const STORYBOOK_STATUS_LANGUAGE: Record<StorybookStatusKey, StorybookStatusPresentation> = {
  shared: {
    label: 'Shared component',
    blurb:
      'A real, reusable building block. If your work needs this kind of UI, use this one rather than rebuilding it.',
    pillBackground: 'rgba(34,197,94,0.14)',
    pillColor: '#86efac',
  },
  'app-pattern': {
    label: 'Repeated app pattern',
    blurb:
      'Shows up in many places in Rebel today, but is not a shared component yet. Handy to reference; not yet a single source of truth.',
    pillBackground: 'rgba(99,102,241,0.16)',
    pillColor: '#c4b5fd',
  },
  missing: {
    label: 'Not yet shared',
    blurb:
      'This kind of UI still relies on local implementations. Dedicated family pages show the current reality when they exist; everything else stays tracked in the Registry.',
    pillBackground: 'rgba(245,158,11,0.16)',
    pillColor: '#fcd34d',
  },
};

// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeFileLocation, type FileLocation } from '@rebel/shared';

const logger = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock('@rebel/cloud-client', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: logger.warn,
    error: vi.fn(),
  }),
}));

vi.mock('../Tooltip', async () => {
  const ReactLocal = await vi.importActual<typeof import('react')>('react');
  return {
    Tooltip: ({
      content,
      children,
    }: {
      content: React.ReactNode;
      children: React.ReactElement<Record<string, unknown>>;
    }) => ReactLocal.cloneElement(children, {
      'data-tooltip-content': String(content),
    }),
  };
});

import { FileLocationBadge } from '../FileLocationBadge';

function legacyLocation(): FileLocation {
  return {
    kind: 'legacy-missing-location',
    fileName: 'SKILL.md',
    spaceName: 'General',
    legacyPath: 'General/skills/workflows/demo/SKILL.md',
  };
}

function inSpaceLocation(): FileLocation {
  return {
    kind: 'in-space',
    spaceName: 'General',
    spaceWorkspacePath: 'General',
    spaceRelativePath: 'skills/workflows/demo/SKILL.md',
    workspaceRelativePath: 'General/skills/workflows/demo/SKILL.md',
    fileName: 'SKILL.md',
    absolutePath: '/Users/demo/General/skills/workflows/demo/SKILL.md',
  };
}

function renderBadge(location: FileLocation) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(<FileLocationBadge location={location} />);
  });

  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('FileLocationBadge', () => {
  beforeEach(() => {
    logger.warn.mockClear();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('warns once per process when rendering legacy-missing-location repeatedly', () => {
    const location = legacyLocation();
    const first = renderBadge(location);
    first.unmount();

    const second = renderBadge(location);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'Rendering degraded FileLocationBadge',
      {
        fileName: 'SKILL.md',
        label: 'General / SKILL.md',
        kind: 'legacy-missing-location',
      },
    );

    second.unmount();
  });

  it('exposes the full tooltip text via aria-label on the badge root', () => {
    const location = inSpaceLocation();
    const rendered = renderBadge(location);
    const description = describeFileLocation(location);
    const badge = rendered.container.querySelector('[data-testid="file-location-badge"]');

    expect(badge?.getAttribute('aria-label')).toBe(description.tooltip);
    expect(badge?.getAttribute('tabindex')).toBe('0');

    rendered.unmount();
  });
});

// @vitest-environment happy-dom
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileLocation } from '@rebel/shared';
import {
  DrawerApprovalTrustRow,
  type DrawerApprovalTrustRowProps,
} from '../DrawerApprovalTrustRow';

vi.mock('@renderer/components/ui', async () => {
  return {
    FileLocationBadge: ({
      className,
      location,
    }: {
      className?: string;
      location: { fileName?: string; spaceName?: string };
    }) => (
      <span className={className} data-testid="mock-file-location-badge">
        {location.spaceName ?? 'Space'} / {location.fileName ?? 'file.md'}
      </span>
    ),
  };
});

vi.mock('@renderer/components/approval/primitives', async () => {
  return {
    SharingBadge: ({
      sharing,
      className,
    }: {
      sharing: string;
      className?: string;
    }) => (
      <span className={className} data-testid="mock-sharing-badge">
        {sharing}
      </span>
    ),
  };
});

async function renderTrustRow(props: DrawerApprovalTrustRowProps): Promise<{
  cleanup: () => void;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(<DrawerApprovalTrustRow {...props} />);
  });

  return {
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

const inSpaceLocation: FileLocation = {
  kind: 'in-space',
  spaceName: 'Chief-of-Staff',
  spaceWorkspacePath: '/spaces/chief-of-staff',
  spaceRelativePath: 'notes/weekly.md',
  workspaceRelativePath: 'spaces/chief-of-staff/notes/weekly.md',
  fileName: 'weekly.md',
  absolutePath: '/workspace/spaces/chief-of-staff/notes/weekly.md',
};

describe('DrawerApprovalTrustRow', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders destination, audience, and reversibility for memory or staged-file branches', async () => {
    const rendered = await renderTrustRow({
      destinationLocation: inSpaceLocation,
      audienceSharing: 'restricted',
      reversibility: 'Can edit after saving',
    });

    expect(document.body.querySelector('[data-testid="drawer-card-trust-row"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="drawer-card-trust-destination"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="mock-file-location-badge"]')?.textContent).toContain('weekly.md');
    expect(document.body.querySelector('[data-testid="drawer-card-trust-audience"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="mock-sharing-badge"]')?.textContent).toContain('restricted');
    expect(document.body.querySelector('[data-testid="drawer-card-trust-reversibility"]')?.textContent).toContain('Can edit after saving');
    expect(document.body.querySelector('[data-testid="drawer-card-trust-risk-cue"]')).toBeNull();

    rendered.cleanup();
  });

  it('renders tool or message fallback labels and risk cue when file-sharing metadata is absent', async () => {
    const rendered = await renderTrustRow({
      destinationLabel: '#launch-ops',
      audienceLabel: 'Shared workspace',
      reversibility: 'Can edit after posting',
      riskCue: 'Leaves Rebel',
    });

    expect(document.body.querySelector('[data-testid="drawer-card-trust-destination"]')?.textContent).toContain('#launch-ops');
    expect(document.body.querySelector('[data-testid="drawer-card-trust-audience"]')?.textContent).toContain('Shared workspace');
    expect(document.body.querySelector('[data-testid="drawer-card-trust-reversibility"]')?.textContent).toContain('Can edit after posting');
    expect(document.body.querySelector('[data-testid="drawer-card-trust-risk-cue"]')?.textContent).toContain('Leaves Rebel');

    rendered.cleanup();
  });

  it('keeps rendering when optional segments are missing', async () => {
    const rendered = await renderTrustRow({
      destinationLabel: 'Runs command on your device',
      reversibility: 'Runs once',
    });

    expect(document.body.querySelector('[data-testid="drawer-card-trust-row"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="drawer-card-trust-destination"]')?.textContent).toContain('Runs command on your device');
    expect(document.body.querySelector('[data-testid="drawer-card-trust-reversibility"]')?.textContent).toContain('Runs once');
    expect(document.body.querySelector('[data-testid="drawer-card-trust-audience"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="drawer-card-trust-risk-cue"]')).toBeNull();

    rendered.cleanup();
  });

  it('returns null when all trust fields are absent', async () => {
    const rendered = await renderTrustRow({});

    expect(document.body.querySelector('[data-testid="drawer-card-trust-row"]')).toBeNull();

    rendered.cleanup();
  });
});

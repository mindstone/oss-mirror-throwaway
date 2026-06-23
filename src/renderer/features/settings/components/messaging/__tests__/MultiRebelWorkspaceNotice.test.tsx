// @vitest-environment happy-dom

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MultiRebelWorkspaceNotice } from '../MultiRebelWorkspaceNotice';

describe('MultiRebelWorkspaceNotice', () => {
  it('renders nothing when peerInstanceCount is missing or <= 1', () => {
    expect(renderToStaticMarkup(<MultiRebelWorkspaceNotice peerInstanceCount={undefined} />)).toBe('');
    expect(renderToStaticMarkup(<MultiRebelWorkspaceNotice peerInstanceCount={1} />)).toBe('');
  });

  it('renders locked informational copy when peerInstanceCount > 1', () => {
    const html = renderToStaticMarkup(<MultiRebelWorkspaceNotice peerInstanceCount={2} />);
    expect(html).toContain('More than one Rebel is connected to this Slack workspace. They don&#x27;t coordinate territory yet, so each Rebel handles incoming messages independently.');
  });
});

/**
 * Stage 6b — unsupported-surface integration tests.
 *
 * When the page renders an editor the React-compatible value setter can't
 * reach (Google Docs canvas, a cross-origin iframe body, or a rich-text
 * contenteditable), the content-script must return a structured refusal
 * rather than silently pretending it filled the field.
 *
 * These tests drive the full `contentScript.ts → capabilityHandlers` path
 * through the same runtime-message envelope Chrome uses, so we also assert
 * the dispatch wrapper never throws across the boundary.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md (Stage 6b)
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { dispatch } from '../../src/content/contentScript';

const CTX = {};

beforeEach(() => {
  document.body.innerHTML = '';
  document.title = 'test';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('contentScript.dispatch — unsupported surfaces', () => {
  it('returns ok:true with a not_fillable skip for contenteditable divs', async () => {
    document.body.innerHTML = '<div id="editor" contenteditable="true">hello</div>';
    const response = await dispatch(
      'fill_form',
      { fields: [{ selector: '#editor', value: 'replacement' }] },
      CTX,
    );
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error('expected ok');
    const data = response.data as {
      fields: Array<{ selector: string; skipped?: boolean; reason?: string }>;
      summary: { set: number; skipped: number };
    };
    expect(data.summary).toEqual({ set: 0, skipped: 1 });
    expect(data.fields[0]).toMatchObject({
      selector: '#editor',
      skipped: true,
      reason: 'not_fillable',
    });
  });

  it('returns not_fillable for canvas-backed editors', async () => {
    // Simulate Google Docs-style surface: a canvas whose parent is marked
    // contenteditable but where neither is a native <input>.
    document.body.innerHTML =
      '<div id="kix" role="textbox" contenteditable="true"><canvas id="c"></canvas></div>';
    const response = await dispatch(
      'fill_form',
      { fields: [{ selector: '#kix', value: 'anything' }] },
      CTX,
    );
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error('expected ok');
    const data = response.data as {
      fields: Array<{ reason?: string }>;
    };
    expect(data.fields[0]).toMatchObject({ reason: 'not_fillable' });
  });

  it('returns not_fillable for an iframe element reference', async () => {
    // An iframe is not a value-carrying form control; the content-script
    // refuses to touch it rather than silently doing nothing. We avoid a
    // network-sourced iframe here so happy-dom doesn't try to fetch.
    document.body.innerHTML = '<iframe id="frame" sandbox=""></iframe>';
    const response = await dispatch(
      'fill_form',
      { fields: [{ selector: '#frame', value: 'hi' }] },
      CTX,
    );
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error('expected ok');
    const data = response.data as {
      fields: Array<{ reason?: string }>;
    };
    expect(data.fields[0]).toMatchObject({ reason: 'not_fillable' });
  });

  it('returns ok:false with UNKNOWN_CAPABILITY for an unregistered capability name', async () => {
    const response = await dispatch('teleport', { x: 1 }, CTX);
    expect(response).toMatchObject({
      ok: false,
      code: 'UNKNOWN_CAPABILITY',
      reason: 'teleport',
    });
  });

  it('surfaces BAD_REQUEST for click refusals (e.g. label_mismatch) without throwing', async () => {
    document.body.innerHTML = '<button id="b">Delete account</button>';
    const response = await dispatch(
      'click',
      { selector: '#b', elementLabel: 'Save draft' },
      CTX,
    );
    expect(response).toMatchObject({
      ok: false,
      code: 'BAD_REQUEST',
      reason: 'label_mismatch',
    });
  });
});

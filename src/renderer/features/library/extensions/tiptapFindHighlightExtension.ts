import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export interface TipTapFindHighlightRange {
  from: number;
  to: number;
}

interface FindHighlightPluginState {
  ranges: TipTapFindHighlightRange[];
  activeIndex: number;
  decorations: DecorationSet;
}

type FindHighlightMeta =
  | { type: 'set'; ranges: TipTapFindHighlightRange[]; activeIndex: number }
  | { type: 'clear' };

const findHighlightPluginKey = new PluginKey<FindHighlightPluginState>('tiptap-find-highlights');

function buildFindDecorations(
  doc: Parameters<typeof DecorationSet.create>[0],
  ranges: TipTapFindHighlightRange[],
  activeIndex: number,
): DecorationSet {
  const maxPos = doc.nodeSize - 2;
  const decorations = ranges
    .map((range, index) => {
      const from = Math.max(1, Math.min(range.from, maxPos));
      const to = Math.max(1, Math.min(range.to, maxPos));
      if (from >= to) return null;

      const isActive = index === activeIndex;
      return Decoration.inline(from, to, {
        class: isActive ? 'tiptap-find-highlight tiptap-find-highlight-active' : 'tiptap-find-highlight',
        style: isActive
          ? 'background-color: rgba(250, 204, 21, 0.85); color: #111827; border-radius: 2px;'
          : 'background-color: rgba(250, 204, 21, 0.45); color: inherit; border-radius: 2px;',
      });
    })
    .filter((decoration): decoration is Decoration => decoration !== null)
    .sort((a, b) => a.from - b.from || a.to - b.to);

  return DecorationSet.create(doc, decorations);
}

function mapFindRanges(
  ranges: TipTapFindHighlightRange[],
  mapping: Transaction['mapping'],
): TipTapFindHighlightRange[] {
  return ranges
    .map((range) => {
      const from = mapping.map(range.from, 1);
      const to = mapping.map(range.to, -1);
      return from < to ? { from, to } : null;
    })
    .filter((range): range is TipTapFindHighlightRange => range !== null);
}

export const TipTapFindHighlightExtension = Extension.create({
  name: 'tiptapFindHighlights',

  addProseMirrorPlugins() {
    return [
      new Plugin<FindHighlightPluginState>({
        key: findHighlightPluginKey,
        state: {
          init(_, state) {
            return {
              ranges: [],
              activeIndex: 0,
              decorations: DecorationSet.create(state.doc, []),
            };
          },
          apply(tr, pluginState, _oldState, newState) {
            const meta = tr.getMeta(findHighlightPluginKey) as FindHighlightMeta | undefined;

            if (meta?.type === 'clear') {
              return {
                ranges: [],
                activeIndex: 0,
                decorations: DecorationSet.empty,
              };
            }

            if (meta?.type === 'set') {
              const activeIndex = Math.max(0, Math.min(meta.activeIndex, meta.ranges.length - 1));
              return {
                ranges: meta.ranges,
                activeIndex,
                decorations: buildFindDecorations(newState.doc, meta.ranges, activeIndex),
              };
            }

            if (tr.docChanged && pluginState.ranges.length > 0) {
              const ranges = mapFindRanges(pluginState.ranges, tr.mapping);
              const activeIndex = Math.max(0, Math.min(pluginState.activeIndex, ranges.length - 1));
              return {
                ranges,
                activeIndex,
                decorations: buildFindDecorations(newState.doc, ranges, activeIndex),
              };
            }

            return pluginState;
          },
        },
        props: {
          decorations(state) {
            return findHighlightPluginKey.getState(state)?.decorations ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },
});

export function setTipTapFindHighlights(
  editor: Editor,
  ranges: TipTapFindHighlightRange[],
  activeIndex: number,
): void {
  editor.view.dispatch(
    editor.state.tr.setMeta(findHighlightPluginKey, {
      type: 'set',
      ranges,
      activeIndex,
    } satisfies FindHighlightMeta),
  );
}

export function clearTipTapFindHighlights(editor: Editor): void {
  editor.view.dispatch(editor.state.tr.setMeta(findHighlightPluginKey, { type: 'clear' } satisfies FindHighlightMeta));
}

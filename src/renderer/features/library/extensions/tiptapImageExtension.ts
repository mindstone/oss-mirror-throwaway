/**
 * TipTap Image Node Extension
 *
 * Registers the `image` token type in TipTap's markdown pipeline so that
 * markdown images (`![alt](src)`) are parsed into ProseMirror nodes instead
 * of being silently dropped. This fixes annotation position drift caused by
 * missing image nodes in documents that contain embedded images (FOX-2790).
 *
 * Stage 1 added the schema (inline atom node with markdown token handling).
 * Stage 2 added a React NodeView for local file loading with error states.
 */

import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { TipTapImageView } from "../components/TipTapImageView";

export const TipTapImageExtension = Node.create({
  name: "image",

  // Images are inline in markdown (can appear within paragraphs)
  inline: true,
  group: "inline",

  // Atomic leaf node — occupies a single ProseMirror position
  atom: true,

  addOptions() {
    return {
      /** Path to the document containing image references. Used to resolve relative paths via IPC. */
      documentPath: null as string | null,
      HTMLAttributes: {} as Record<string, string>,
      /** Optional callback fired after an image node is removed. Stage 3 wires this to strict persistence. */
      onImageMutation: null as (() => void | Promise<void>) | null,
      /** Optional toast callback so the image right-click menu can report copy/save outcomes. */
      showToast: null as ((options: { title: string }) => void) | null,
    };
  },

  addAttributes() {
    return {
      src: { default: null },
      alt: { default: "" },
      title: { default: null },
    };
  },

  parseHTML() {
    return [
      {
        tag: "img[src]",
        getAttrs: (element) => {
          const el = element as HTMLElement;
          return {
            src: el.getAttribute("src"),
            alt: el.getAttribute("alt") ?? "",
            title: el.getAttribute("title"),
          };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "img",
      mergeAttributes(this.options.HTMLAttributes ?? {}, HTMLAttributes),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(TipTapImageView, {
      as: "span",
    });
  },

  // TipTap v3 markdown integration — register handler for marked's image token
  markdownTokenName: "image",

  parseMarkdown: (token) => {
    return {
      type: "image",
      attrs: {
        src: token.href ?? null,
        alt: token.text ?? "",
        title: token.title || null,
      },
    };
  },

  renderMarkdown: (node) => {
    const src = node.attrs?.src ?? "";
    const alt = node.attrs?.alt ?? "";
    const title = node.attrs?.title;

    if (title) {
      return `![${alt}](${src} "${title}")`;
    }

    return `![${alt}](${src})`;
  },
});

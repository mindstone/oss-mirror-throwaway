/**
 * Render the OSS strategy doc's HTML companion from its canonical Markdown.
 *
 * The `.html` is a generated, internal-only (mirror-excluded) rendering of the
 * `.md`. It has bespoke chrome (CSS preamble, styled <header> banner, footer)
 * that is NOT derived from the Markdown — so this script regenerates ONLY the
 * <main>…</main> body and splices it back in, leaving all chrome byte-identical.
 * That keeps the diff to actual content and avoids re-theming the page.
 *
 * Heading IDs use the GitHub-slugger algorithm (lowercase; drop everything
 * except letters/numbers/underscore/hyphen/whitespace; whitespace → hyphen,
 * NOT collapsed) + a `¶` anchor, matching the original generator. Verified to
 * reproduce all existing heading IDs.
 *
 *   npm run docs:render:oss-strategy           # rewrite the .html in place
 *   npm run docs:render:oss-strategy -- --check  # exit 1 if .html is stale (CI)
 *   tsx scripts/render-oss-strategy-html.ts --out /tmp/x.html   # write elsewhere
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked, type Renderer, type Tokens } from 'marked';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MD_PATH = path.join(REPO_ROOT, 'docs/plans/260520_oss_release_strategy.md');
const HTML_PATH = path.join(REPO_ROOT, 'docs/plans/260520_oss_release_strategy.html');

const args = process.argv.slice(2);
const checkMode = args.includes('--check');
const outIdx = args.indexOf('--out');
const outPath = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : HTML_PATH;

/** GitHub-slugger-compatible slug (no multi-hyphen collapse). */
function slugify(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/gu, '-');
}

function makeRenderer() {
  const seen = new Map<string, number>();
  const uniqueSlug = (text: string): string => {
    const base = slugify(text);
    const count = seen.get(base);
    if (count === undefined) {
      seen.set(base, 0);
      return base;
    }
    const next = count + 1;
    seen.set(base, next);
    return `${base}-${next}`;
  };

  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading(this: Renderer<string, string>, token: Tokens.Heading) {
        const inner = this.parser.parseInline(token.tokens);
        const id = uniqueSlug(token.text);
        return `<h${token.depth} id="${id}">${inner} <a class="anchor" href="#${id}">¶</a></h${token.depth}>\n`;
      },
    },
  });
  return marked;
}

function renderBody(markdown: string): string {
  // The .md has no YAML frontmatter; render as-is. Trailing newline kept so the
  // splice yields `</…>\n\n</main>` (matching the original blank line).
  return makeRenderer().parse(markdown, { async: false }) as string;
}

function spliceMain(html: string, body: string): string {
  const re = /(<main>\n)[\s\S]*?(\n<\/main>)/;
  if (!re.test(html)) {
    throw new Error('Could not find <main>…</main> body markers in the HTML template');
  }
  return html.replace(re, `$1${body}$2`);
}

function main(): void {
  const markdown = fs.readFileSync(MD_PATH, 'utf8');
  const currentHtml = fs.readFileSync(HTML_PATH, 'utf8');
  const body = renderBody(markdown).replace(/\n$/, ''); // splice adds the trailing \n
  const nextHtml = spliceMain(currentHtml, body);

  if (checkMode) {
    if (nextHtml !== currentHtml) {
      console.error(
        `[render-oss-strategy-html] OUT OF DATE: ${path.relative(REPO_ROOT, HTML_PATH)} ` +
          `does not match a fresh render of the .md. Run: npm run docs:render:oss-strategy`,
      );
      process.exit(1);
    }
    console.log('[render-oss-strategy-html] up to date.');
    return;
  }

  if (nextHtml === currentHtml && outPath === HTML_PATH) {
    console.log('[render-oss-strategy-html] no changes.');
    return;
  }
  fs.writeFileSync(outPath, nextHtml);
  console.log(`[render-oss-strategy-html] wrote ${path.relative(REPO_ROOT, outPath)} (${nextHtml.length} bytes)`);
}

main();

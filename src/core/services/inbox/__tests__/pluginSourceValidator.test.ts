import { describe, it, expect } from 'vitest';
import { validatePluginSource } from '../pluginSourceValidator';

// See docs/plans/260527_plugin_agent_experience_overhaul.md — Stage 2

describe('validatePluginSource', () => {
  describe('hallucination patterns', () => {
    it('rejects an empty <script> body whose only content is a "preserved" placeholder comment', () => {
      const source = `
        const html = "...";
        <script>/* dashboard logic preserved in full from source file */</script>
      `;
      const result = validatePluginSource(source, undefined);
      expect(result).not.toBeNull();
      expect(result).toMatch(/placeholder comment/);
      expect(result).toMatch(/Re-include the full implementation/);
    });

    it('rejects a "see source" placeholder script body', () => {
      const source = `<script>/* see source file for full implementation */</script>`;
      const result = validatePluginSource(source, undefined);
      expect(result).toMatch(/placeholder comment/);
    });

    it('rejects a "TODO" placeholder script body', () => {
      const source = `<script>/* TODO: paste original JS here */</script>`;
      const result = validatePluginSource(source, undefined);
      expect(result).toMatch(/placeholder comment/);
    });

    it('rejects a "removed for brevity" placeholder script body', () => {
      const source = `<script>/* JS removed for brevity */</script>`;
      const result = validatePluginSource(source, undefined);
      expect(result).toMatch(/placeholder comment/);
    });

    it('rejects a free-floating "dashboard logic preserved" comment outside a <script> tag', () => {
      const source = `
        function App() { return null; }
        /* dashboard logic preserved */
      `;
      const result = validatePluginSource(source, undefined);
      expect(result).toMatch(/logic preserved/);
    });

    it('rejects a "full content preserved" placeholder', () => {
      const source = `/* full content preserved */`;
      const result = validatePluginSource(source, undefined);
      expect(result).toMatch(/logic preserved/);
    });

    it('accepts a <script> tag with real content', () => {
      const source = `
        <script>
          function doStuff() { console.log("real work"); }
        </script>
      `;
      const result = validatePluginSource(source, undefined);
      expect(result).toBeNull();
    });
  });

  describe('handler-completeness check', () => {
    it('rejects when onclick references an undefined handler', () => {
      const source = `
        function App() {
          return '<button onclick="showTab(1)">Tab</button>';
        }
      `;
      const result = validatePluginSource(source, undefined);
      expect(result).not.toBeNull();
      expect(result).toMatch(/showTab/);
      expect(result).toMatch(/not defined anywhere in the source/);
    });

    it('rejects with all missing handler names listed when multiple are missing', () => {
      const source = `
        return '<button onclick="showTab()"><span onchange="sortTbl(\\'a\\')">x</span></button>';
      `;
      const result = validatePluginSource(source, undefined);
      expect(result).toMatch(/showTab/);
      expect(result).toMatch(/sortTbl/);
      expect(result).toMatch(/handlers/); // plural form
    });

    it('rejection message mentions BOTH the strip-script-body cause AND the false-positive cause (so agents handling either case can self-correct)', () => {
      const source = `<button onclick="showTab()">Tab</button>`;
      const result = validatePluginSource(source, undefined);
      // Most common cause: stripped <script> body
      expect(result).toMatch(/script.*body/i);
      // False-positive cause: match came from a comment or string literal
      expect(result).toMatch(/false[- ]positive/i);
      expect(result).toMatch(/comment or string literal/i);
    });

    it('accepts onclick referencing a function defined as `function showTab(...)`', () => {
      const source = `
        function showTab(id) { console.log(id); }
        const html = '<button onclick="showTab(1)">x</button>';
      `;
      const result = validatePluginSource(source, undefined);
      expect(result).toBeNull();
    });

    it('accepts onclick referencing a function defined as `const showTab = ...`', () => {
      const source = `
        const showTab = (id) => console.log(id);
        const html = '<button onclick="showTab(1)">x</button>';
      `;
      const result = validatePluginSource(source, undefined);
      expect(result).toBeNull();
    });

    it('accepts onclick referencing a function defined as `let showTab = function(...) {}`', () => {
      const source = `
        let showTab = function(id) { console.log(id); };
        const html = '<button onclick="showTab(1)">x</button>';
      `;
      const result = validatePluginSource(source, undefined);
      expect(result).toBeNull();
    });

    it('accepts onclick referencing an async function definition', () => {
      const source = `
        async function showTab(id) { return id; }
        const html = '<button onclick="showTab(1)">x</button>';
      `;
      const result = validatePluginSource(source, undefined);
      expect(result).toBeNull();
    });

    it('accepts onchange/onsubmit/oninput referencing defined functions', () => {
      const source = `
        function onChangeHandler() {}
        function onSubmitHandler() {}
        function onInputHandler() {}
        const html = '<input onchange="onChangeHandler()" oninput="onInputHandler(this)">';
        const form = '<form onsubmit="onSubmitHandler(event)">';
      `;
      const result = validatePluginSource(source, undefined);
      expect(result).toBeNull();
    });

    it('accepts source without any inline event handlers (pure React)', () => {
      const source = `
        function App() { return <button onClick={() => {}}>x</button>; }
      `;
      const result = validatePluginSource(source, undefined);
      expect(result).toBeNull();
    });
  });

  describe('size-sanity guard', () => {
    it('rejects when source is 50% shorter than existing without opt-out comment', () => {
      const existing = 'x'.repeat(10_000);
      const source = 'x'.repeat(5_000);
      const result = validatePluginSource(source, existing);
      expect(result).not.toBeNull();
      expect(result).toMatch(/shorter than the previous version/);
      expect(result).toMatch(/intentional rewrite/);
    });

    it('rejects with the percentage shrink in the message', () => {
      const existing = 'x'.repeat(10_000);
      const source = 'x'.repeat(2_000); // 80% shrink
      const result = validatePluginSource(source, existing);
      expect(result).toMatch(/80% shorter/);
    });

    it('accepts when source is 50% shorter but includes the opt-out comment', () => {
      const existing = 'x'.repeat(10_000);
      const source =
        '/* intentional rewrite — original content replaced */\n' + 'y'.repeat(5_000);
      const result = validatePluginSource(source, existing);
      expect(result).toBeNull();
    });

    it('accepts when source is only 20% shorter (under threshold)', () => {
      const existing = 'x'.repeat(10_000);
      const source = 'x'.repeat(8_000); // 20% shrink — under 30% threshold
      const result = validatePluginSource(source, existing);
      expect(result).toBeNull();
    });

    it('accepts when source is the same size as existing', () => {
      const existing = 'x'.repeat(10_000);
      const source = 'y'.repeat(10_000);
      const result = validatePluginSource(source, existing);
      expect(result).toBeNull();
    });

    it('accepts when source is LARGER than existing', () => {
      const existing = 'x'.repeat(5_000);
      const source = 'y'.repeat(10_000);
      const result = validatePluginSource(source, existing);
      expect(result).toBeNull();
    });

    it('skips the size-sanity check on first create (no existing source)', () => {
      // First creates can be arbitrarily small relative to "nothing".
      const source = 'x';
      const result = validatePluginSource(source, undefined);
      expect(result).toBeNull();
    });

    it('skips the size-sanity check when existing is empty string', () => {
      const source = 'x';
      const result = validatePluginSource(source, '');
      expect(result).toBeNull();
    });

    it('skips the size-sanity check when existing source is below the absolute floor (≤500 bytes)', () => {
      // Reviewer-flagged edge: tiny existing source would trip 30% shrink on
      // small edits. Below SIZE_SANITY_MIN_BYTES (500) we skip the relative
      // check entirely.
      const existing = 'x'.repeat(400); // below floor
      const source = 'x'.repeat(100); // would be 75% shrink, but tiny denominator
      const result = validatePluginSource(source, existing);
      expect(result).toBeNull();
    });

    it('applies the size-sanity check at exactly the boundary (>500 bytes)', () => {
      // 501 chars is above floor — the check applies.
      const existing = 'x'.repeat(501);
      const source = 'x'.repeat(100); // ~80% shrink
      const result = validatePluginSource(source, existing);
      expect(result).not.toBeNull();
      expect(result).toMatch(/shorter than the previous version/);
    });
  });

  describe('happy path', () => {
    it('accepts a clean React-only plugin with no inline handlers and reasonable size', () => {
      const source = `
        import React from 'react';
        import { useConversations } from '@rebel/plugin-api';
        import { Card } from '@rebel/plugin-ui';

        export default function MyPlugin() {
          const { data } = useConversations();
          return <Card>{data.length} conversations</Card>;
        }
      `;
      expect(validatePluginSource(source, undefined)).toBeNull();
      expect(validatePluginSource(source, source)).toBeNull();
    });

    it('accepts an iframe srcDoc plugin where all inline handlers are defined inside the srcDoc string', () => {
      const source = `
        import React from 'react';
        const pageHtml = String.raw\`
          <html>
            <body>
              <button onclick="showTab(1)">Tab 1</button>
              <script>
                function showTab(id) { console.log(id); }
              </script>
            </body>
          </html>
        \`;
        export default function MyPlugin() {
          return <iframe srcDoc={pageHtml} sandbox="allow-scripts" />;
        }
      `;
      const result = validatePluginSource(source, undefined);
      expect(result).toBeNull();
    });
  });

  describe('precedence', () => {
    it('returns the hallucination error before the missing-handler error when both apply', () => {
      // The placeholder script comment must trip first; size and handler checks
      // are skipped on early return. This guarantees the most informative error.
      const source = `
        '<button onclick="showTab(1)">x</button>'
        <script>/* dashboard logic preserved */</script>
      `;
      const result = validatePluginSource(source, undefined);
      expect(result).toMatch(/placeholder comment/);
      // Sanity: this source ALSO has an undefined handler, but we should see
      // the placeholder error, not the handler error.
      expect(result).not.toMatch(/not defined anywhere/);
    });
  });
});

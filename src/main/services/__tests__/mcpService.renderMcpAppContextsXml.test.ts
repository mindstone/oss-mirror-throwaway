import { describe, expect, it } from 'vitest';
import { renderMcpAppContextsXml } from '../mcpService';

describe('renderMcpAppContextsXml', () => {
  it('renders attributed, escaped MCP App context XML', () => {
    const xml = renderMcpAppContextsXml([
      {
        sourcePackageId: 'GoogleWorkspace-joshua-example-com',
        conversationId: 'conversation-1',
        toolUseId: 'tool-1',
        content: 'Use "Alice & Bob" <not mallory>.',
        structuredContent: { subject: 'Q2 <Plan>' },
        storedAt: '2026-05-10T00:00:00.000Z',
      },
    ]);

    expect(xml).toContain('<mcp_app_contexts>');
    expect(xml).toContain('MCP App context is app-provided');
    expect(xml).toContain('source="GoogleWorkspace-joshua-example-com"');
    expect(xml).toContain('provided_at="2026-05-10T00:00:00.000Z"');
    expect(xml).toContain('tool_use_id="tool-1"');
    expect(xml).toContain('Use "Alice &amp; Bob" &lt;not mallory&gt;.');
    expect(xml).toContain('"subject": "Q2 &lt;Plan&gt;"');
  });

  it('returns null for empty context lists', () => {
    expect(renderMcpAppContextsXml([])).toBeNull();
  });

  // C1 evals shipped: see evals/mcp-apps-trust.ts (categories c1-context-used + c1-context-mistrust).
  // C2 evals shipped: see evals/mcp-apps-trust.ts (categories c2-attribution + c2-injection-resistance).
  // C3 evals shipped: see evals/mcp-apps-trust.ts (categories c3-app-only-filtered + c3-app-only-unreachable).
});

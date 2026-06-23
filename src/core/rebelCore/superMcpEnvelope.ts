/**
 * Parse the leading JSON from a Super-MCP use_tool text response.
 *
 * Super-MCP may append non-JSON text after the JSON object (continuation hints,
 * large-output warnings, oversized-output placeholders) separated by "\n\n".
 * JSON.stringify(_, null, 2) cannot emit literal "\n\n" inside its output
 * (structural whitespace is \n + indent; string newlines escape to \\n), so
 * this boundary is safe.
 *
 * Only valid for initial use_tool responses — continuation responses have a
 * different shape ({ continuation: true, ... }).
 *
 * See super-mcp/src/handlers/useTool.ts for the three suffix-producing paths.
 */
export function parseUseToolEnvelopeJson<T = unknown>(text: string): T | null {
  const boundary = text.indexOf('\n\n');
  const jsonText = boundary >= 0 ? text.slice(0, boundary) : text;
  try {
    const parsed = JSON.parse(jsonText);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as T;
  } catch {
    return null;
  }
}

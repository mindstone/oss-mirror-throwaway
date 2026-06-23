import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODEL_CATALOG } from '../modelCatalog';

const MCP_LABELS_FAILURE =
  'add the model to resources/mcp/rebel-automations/model-labels.json — see docs/project/NEW_MODEL_SUPPORT_PROCESS.md step 13';

const modelLabelsPath = join(
  process.cwd(),
  'resources/mcp/rebel-automations/model-labels.json',
);

function loadMcpModelLabels(): Record<string, string> {
  return JSON.parse(readFileSync(modelLabelsPath, 'utf8')) as Record<string, string>;
}

describe('MCP rebel-automations model labels', () => {
  const anthropicMainModels = MODEL_CATALOG.filter(
    (e) => e.provider === 'anthropic' && e.isMainModel,
  );

  it('covers every anthropic isMainModel catalog entry with its displayLabel', () => {
    const labels = loadMcpModelLabels();

    for (const entry of anthropicMainModels) {
      expect(
        labels[entry.id],
        `${entry.id}: missing from model-labels.json — ${MCP_LABELS_FAILURE}`,
      ).toBe(entry.displayLabel);
    }
  });
});

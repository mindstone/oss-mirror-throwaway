import { RuleTester } from 'eslint';
import tsparser from '@typescript-eslint/parser';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rule = require('../no-model-brand-casts.js');

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsparser,
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
});

const productionFile = 'src/core/rebelCore/randomProductionFile.ts';

ruleTester.run('no-model-brand-casts', rule, {
  valid: [
    {
      name: 'allows decoder casts inside modelChoiceCodec',
      filename: 'src/shared/utils/modelChoiceCodec.ts',
      code: "const routed = raw as RoutingModelId;",
    },
    {
      name: 'allows Chat-Completions brand cast inside the chokepoint',
      filename: 'src/core/services/chatCompletionsParamCapability.ts',
      code: "const body = raw as ValidatedChatCompletionsBody<typeof raw>;",
    },
    {
      name: 'allows route wire-model branding only inside the WireModelId minter file',
      filename: 'src/shared/utils/wireModelId.ts',
      code: "export function brandRouteWireModel(value: string): WireModelId { return value as WireModelId; }",
    },
    {
      name: 'allows contextual as any inside modelChoiceCodec',
      filename: 'src/shared/utils/modelChoiceCodec.ts',
      code: "const routed: RoutingModelId = raw as any;",
    },
    {
      name: 'allows double-cast inside modelChoiceCodec',
      filename: 'src/shared/utils/modelChoiceCodec.ts',
      code: "const routed = raw as unknown as RoutingModelId;",
    },
    {
      name: 'allows unrelated casts in production',
      filename: productionFile,
      code: "const value = raw as string;",
    },
  ],
  invalid: [
    {
      name: 'flags direct brand cast',
      filename: productionFile,
      code: "const routed = raw as RoutingModelId;",
      errors: [{ messageId: 'noModelBrandCast' }],
    },
    {
      name: 'flags local alias laundering',
      filename: productionFile,
      code: "type R = RoutingModelId; const routed = raw as R;",
      errors: [{ messageId: 'noModelBrandCast' }],
    },
    {
      name: 'flags container object laundering',
      filename: productionFile,
      code: "const request = raw as { model: WireModelId };",
      errors: [{ messageId: 'noModelBrandCast' }],
    },
    {
      name: 'flags known request container laundering',
      filename: productionFile,
      code: "const request = raw as OpenAIRequest;",
      errors: [{ messageId: 'noModelBrandCast' }],
    },
    {
      name: 'flags as never into branded variable',
      filename: productionFile,
      code: "const routed: RoutingModelId = raw as never;",
      errors: [{ messageId: 'noModelBrandCast' }],
    },
    {
      name: 'flags contextual as any into branded variable',
      filename: productionFile,
      code: "const routed: RoutingModelId = raw as any;",
      errors: [{ messageId: 'noModelBrandCast' }],
    },
    {
      name: 'flags contextual as unknown into branded variable',
      filename: productionFile,
      code: "const routed: RoutingModelId = raw as unknown;",
      errors: [{ messageId: 'noModelBrandCast' }],
    },
    {
      name: 'flags double-cast through unknown into branded variable',
      filename: productionFile,
      code: "const routed = raw as unknown as RoutingModelId;",
      errors: [{ messageId: 'noModelBrandCast' }],
    },
    {
      name: 'flags direct Chat-Completions body brand cast',
      filename: productionFile,
      code: "const body = raw as ValidatedChatCompletionsBody<typeof raw>;",
      errors: [{ messageId: 'noModelBrandCast' }],
    },
    {
      name: 'flags direct WireModelId cast in route code',
      filename: 'src/core/rebelCore/providerRouting.ts',
      code: "const wireModelId = raw as WireModelId;",
      errors: [{ messageId: 'noModelBrandCast' }],
    },
  ],
});

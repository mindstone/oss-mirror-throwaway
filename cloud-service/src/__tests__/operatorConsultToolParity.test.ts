import { describe, expect, it } from 'vitest';
import { executeBuiltinTool } from '@core/rebelCore/builtinTools';

describe('cloud built-in tool parity', () => {
  it('keeps Operator consult registered but fail-closed on cloud', async () => {
    const result = await executeBuiltinTool('rebel_operator__consult', {
      operatorId: '/spaces/acme::risk-operator',
      focus: 'Launch risk',
    }, { surfaceCapability: 'cloud' });

    expect(result.isError).toBe(true);
    expect(result.output).toBe('Operator consults use local Space files and are only available in the desktop app.');
  });
});

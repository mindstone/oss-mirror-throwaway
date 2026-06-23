import { describe, it, expect } from 'vitest';
import { getDiagnosticAwareLevelFourMessage } from '../agentTurnExecute';
import type { TimeoutDiagnosticResult } from '@core/services/timeoutDiagnosticsService';

describe('getDiagnosticAwareLevelFourMessage (FOX-3251)', () => {
  it('surfaces Anthropic status indicator when probe reports anthropic_issue', () => {
    const result: TimeoutDiagnosticResult = {
      kind: 'anthropic_issue',
      indicator: 'major',
      description: 'Increased response latency on Claude Sonnet',
    };
    const message = getDiagnosticAwareLevelFourMessage(result);
    expect(message).toContain('Claude');
    expect(message).toContain('major');
    expect(message).toContain('status.anthropic.com');
  });

  it('surfaces internet-unreachable copy when probe reports internet_unreachable', () => {
    const result: TimeoutDiagnosticResult = { kind: 'internet_unreachable' };
    const message = getDiagnosticAwareLevelFourMessage(result);
    expect(message.toLowerCase()).toContain('internet');
    expect(message.toLowerCase()).toContain('connection');
  });

  it('surfaces healthy-stall copy when probe reports transient_stall', () => {
    const result: TimeoutDiagnosticResult = { kind: 'transient_stall' };
    const message = getDiagnosticAwareLevelFourMessage(result);
    expect(message.toLowerCase()).toContain('stall');
    expect(message.toLowerCase()).toContain('healthy');
    expect(message.toLowerCase()).toContain('resend');
  });

  it('renders within 280 characters so it fits a single status row', () => {
    const cases: TimeoutDiagnosticResult[] = [
      { kind: 'anthropic_issue', indicator: 'critical', description: 'x'.repeat(50) },
      { kind: 'internet_unreachable' },
      { kind: 'transient_stall' },
    ];
    for (const c of cases) {
      expect(getDiagnosticAwareLevelFourMessage(c).length).toBeLessThanOrEqual(280);
    }
  });
});

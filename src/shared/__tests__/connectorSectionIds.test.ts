import { describe, it, expect } from 'vitest';
import { getConnectorSectionId } from '../utils/connectorSectionIds';

describe('getConnectorSectionId', () => {
  it('returns undefined for undefined input', () => {
    expect(getConnectorSectionId(undefined)).toBeUndefined();
  });

  it('returns a lowercase section id for a simple server name', () => {
    expect(getConnectorSectionId('Humaans')).toBe('connector-humaans');
  });

  it('normalizes mixed-case names to lowercase', () => {
    expect(getConnectorSectionId('MyConnector')).toBe('connector-myconnector');
  });

  it('produces consistent ids regardless of input casing', () => {
    expect(getConnectorSectionId('humaans')).toBe(getConnectorSectionId('Humaans'));
    expect(getConnectorSectionId('FATHOM')).toBe(getConnectorSectionId('fathom'));
  });

  it('handles already-lowercase names', () => {
    expect(getConnectorSectionId('slack')).toBe('connector-slack');
  });
});

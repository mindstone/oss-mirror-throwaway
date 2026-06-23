import { describe, expect, it } from 'vitest';
import { AccountIdentityEnum } from '../connectorCatalogSchema';
import {
  getIdentityFieldDisplay,
  getIdentityParamName,
  type IdentityKind,
} from '../identityKinds';

const identityKinds = AccountIdentityEnum.options as readonly IdentityKind[];

describe('identityKinds', () => {
  it.each(identityKinds)('defines display metadata for %s through the public helper', (kind) => {
    const display = getIdentityFieldDisplay(kind);
    expect(display.label.trim().length).toBeGreaterThan(0);
    expect(['email', 'text']).toContain(display.inputType);
  });

  it('covers all accountIdentity enum values from connectorCatalogSchema', () => {
    for (const kind of identityKinds) {
      expect(getIdentityFieldDisplay(kind)).toBeDefined();
    }
  });

  it('locks the email default display metadata', () => {
    expect(getIdentityFieldDisplay('email')).toEqual({
      label: 'Account Email',
      placeholder: 'you@example.com',
      inputType: 'email',
    });
  });

  it('locks the workspace default display metadata', () => {
    expect(getIdentityFieldDisplay('workspace')).toEqual({
      label: 'Workspace Name',
      placeholder: 'My Workspace',
      inputType: 'text',
    });
  });

  it('defaults undefined kind to email display metadata', () => {
    expect(getIdentityFieldDisplay(undefined)).toEqual({
      label: 'Account Email',
      placeholder: 'you@example.com',
      inputType: 'email',
    });
  });

  it('returns the subdomain kind default display metadata', () => {
    expect(getIdentityFieldDisplay('subdomain')).toEqual({
      label: 'Account URL',
      placeholder: 'yourcompany',
      inputType: 'text',
    });
  });

  it.each([
    ['email', 'email'],
    ['workspace', 'workspace name'],
    ['subdomain', 'account URL'],
    ['domain', 'account URL'],
    ['tenant', 'account URL'],
  ] as const)('maps %s kind to the expected identity parameter name', (kind, expectedParamName) => {
    expect(getIdentityParamName(kind)).toBe(expectedParamName);
  });

  it('maps none kind to null param copy', () => {
    expect(getIdentityParamName('none')).toBeNull();
  });

  it('defaults undefined kind to email param copy', () => {
    expect(getIdentityParamName(undefined)).toBe('email');
  });
});

import { describe, it, expect } from 'vitest';
import { deriveInboxStatus } from '../deriveInboxStatus';

describe('deriveInboxStatus', () => {
  it('returns status when present', () => {
    expect(deriveInboxStatus({ status: 'active' })).toBe('active');
    expect(deriveInboxStatus({ status: 'completed' })).toBe('completed');
    expect(deriveInboxStatus({ status: 'dismissed' })).toBe('dismissed');
    expect(deriveInboxStatus({ status: 'executing' })).toBe('executing');
  });

  it('status takes precedence over archived boolean', () => {
    expect(deriveInboxStatus({ status: 'active', archived: true })).toBe('active');
    expect(deriveInboxStatus({ status: 'dismissed', archived: false })).toBe('dismissed');
  });

  it('legacy archived=true maps to completed (not dismissed)', () => {
    expect(deriveInboxStatus({ archived: true })).toBe('completed');
  });

  it('legacy archived=false maps to active', () => {
    expect(deriveInboxStatus({ archived: false })).toBe('active');
  });

  it('no status and no archived defaults to active', () => {
    expect(deriveInboxStatus({})).toBe('active');
  });

  it('undefined status falls through to archived', () => {
    expect(deriveInboxStatus({ status: undefined, archived: true })).toBe('completed');
    expect(deriveInboxStatus({ status: undefined, archived: false })).toBe('active');
  });
});

import { describe, it, expect } from 'vitest';
import { getCloudProvider, getCloudProviderOrDefault } from '../cloud/providers';

describe('Cloud Provider Registry', () => {
  describe('getCloudProvider', () => {
    it('returns the Fly.io provider for id "fly"', () => {
      const provider = getCloudProvider('fly');
      expect(provider.config.id).toBe('fly');
      expect(provider.config.name).toBe('Fly.io');
      expect(provider.config.authType).toBe('pat');
    });

    it('throws for unknown provider id', () => {
      expect(() => getCloudProvider('unknown' as never)).toThrow('Unknown cloud provider: unknown');
    });
  });

  describe('getCloudProviderOrDefault', () => {
    it('returns Fly provider when no id is given', () => {
      const provider = getCloudProviderOrDefault();
      expect(provider.config.id).toBe('fly');
    });

    it('returns Fly provider for undefined id', () => {
      const provider = getCloudProviderOrDefault(undefined);
      expect(provider.config.id).toBe('fly');
    });

    it('returns Fly provider for explicit "fly" id', () => {
      const provider = getCloudProviderOrDefault('fly');
      expect(provider.config.id).toBe('fly');
    });

    it('returns DigitalOcean provider for "digitalocean" id', () => {
      const provider = getCloudProviderOrDefault('digitalocean');
      expect(provider.config.id).toBe('digitalocean');
    });

    it('returns Hetzner provider for "hetzner" id', () => {
      const provider = getCloudProviderOrDefault('hetzner');
      expect(provider.config.id).toBe('hetzner');
      expect(provider.config.name).toBe('Hetzner Cloud');
    });

    it('throws for unregistered provider id', () => {
      expect(() => getCloudProviderOrDefault('aws' as never)).toThrow('Unknown cloud provider: aws');
    });
  });
});

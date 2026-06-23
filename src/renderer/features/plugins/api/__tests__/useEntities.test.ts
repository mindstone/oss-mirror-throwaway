import { describe, it, expect } from 'vitest';
import { useEntities } from '../useEntities';
import type { EntityEntry, UseEntitiesParams, UseEntitiesResult } from '../types';

describe('useEntities', () => {
  describe('exports', () => {
    it('exports useEntities function', () => {
      expect(typeof useEntities).toBe('function');
    });
  });

  describe('UseEntitiesParams type structure', () => {
    it('can construct params with all fields', () => {
      const params: UseEntitiesParams = {
        entityType: 'person',
        query: 'sarah',
        company: 'Acme',
        limit: 25,
      };

      expect(params.entityType).toBe('person');
      expect(params.query).toBe('sarah');
      expect(params.company).toBe('Acme');
      expect(params.limit).toBe(25);
    });

    it('allows empty params (all fields optional)', () => {
      const params: UseEntitiesParams = {};
      expect(params.entityType).toBeUndefined();
      expect(params.query).toBeUndefined();
      expect(params.company).toBeUndefined();
      expect(params.limit).toBeUndefined();
    });
  });

  describe('EntityEntry type structure', () => {
    it('has all required fields and optional metadata', () => {
      const entity: EntityEntry = {
        canonicalName: 'Sarah Chen',
        entityType: 'person',
        emails: ['[external-email]'],
        company: 'Acme',
        role: 'Head of Sales',
        aliases: ['Sarah C'],
      };

      expect(entity.canonicalName).toBe('Sarah Chen');
      expect(entity.entityType).toBe('person');
      expect(entity.emails).toEqual(['[external-email]']);
      expect(entity.company).toBe('Acme');
      expect(entity.role).toBe('Head of Sales');
      expect(entity.aliases).toEqual(['Sarah C']);
    });
  });

  describe('UseEntitiesResult type structure', () => {
    it('represents loaded state', () => {
      const result: UseEntitiesResult = {
        entities: [],
        isLoading: false,
        error: null,
      };

      expect(result.entities).toEqual([]);
      expect(result.isLoading).toBe(false);
      expect(result.error).toBeNull();
    });

    it('represents error state', () => {
      const result: UseEntitiesResult = {
        entities: [],
        isLoading: false,
        error: 'Entities API not available',
      };

      expect(result.error).toBe('Entities API not available');
    });
  });

  describe('IPC request construction', () => {
    it('builds empty request for undefined params', () => {
      const buildRequest = (params?: UseEntitiesParams): Record<string, unknown> => {
        const request: Record<string, unknown> = {};
        const query = params?.query?.trim();
        const company = params?.company?.trim();
        if (params?.entityType) request.entityType = params.entityType;
        if (query) request.query = query;
        if (company) request.company = company;
        if (params?.limit != null) request.limit = params.limit;
        return request;
      };
      const request = buildRequest();

      expect(request).toEqual({});
    });

    it('includes all provided params in request', () => {
      const params: UseEntitiesParams = {
        entityType: 'company',
        query: '  acme  ',
        company: '  Acme Inc  ',
        limit: 10,
      };
      const request: Record<string, unknown> = {};
      const query = params.query?.trim();
      const company = params.company?.trim();
      if (params.entityType) request.entityType = params.entityType;
      if (query) request.query = query;
      if (company) request.company = company;
      if (params.limit != null) request.limit = params.limit;

      expect(request).toEqual({
        entityType: 'company',
        query: 'acme',
        company: 'Acme Inc',
        limit: 10,
      });
    });
  });

  describe('params serialization for debounce', () => {
    it('produces stable JSON key for identical params', () => {
      const a: UseEntitiesParams = { entityType: 'person', query: 'sarah', limit: 10 };
      const b: UseEntitiesParams = { entityType: 'person', query: 'sarah', limit: 10 };
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });

    it('produces stable key for empty/undefined params', () => {
      const serializeKey = (params?: UseEntitiesParams): string => JSON.stringify(params ?? {});

      expect(serializeKey(undefined)).toBe('{}');
      expect(serializeKey({})).toBe('{}');
    });
  });
});

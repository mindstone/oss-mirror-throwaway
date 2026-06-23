import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROUTER_PATH = path.resolve(__dirname, '../cloudRouter.ts');

describe('cloudRouter session push bypass', () => {
  it('has no direct session PUT violations', () => {
    const source = fs.readFileSync(ROUTER_PATH, 'utf8');
    expect(source).not.toMatch(/client\.put\(\s*[`'"]\/api\/sessions/);
  });

  it('routes pushSessionsToCloud through pushFullSessionWithCapabilityGate', () => {
    const source = fs.readFileSync(ROUTER_PATH, 'utf8');
    expect(source).toContain("import { pushFullSessionWithCapabilityGate } from './cloudOutbox';");
    expect(source).toContain('await pushFullSessionWithCapabilityGate(client, stripConversationAnnotations(session));');
  });

  it('does not call client.put for /api/sessions in pushSessionsToCloud', () => {
    const source = fs.readFileSync(ROUTER_PATH, 'utf8');
    const start = source.indexOf('async pushSessionsToCloud()');
    const end = source.indexOf('async pushInboxToCloud()', start);
    const body = source.slice(start, end);
    expect(body).not.toMatch(/client\.put\(\s*[`'"]\/api\/sessions/);
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectForbiddenCredentialWrites } from '../audit-credential-write-sites';

const fixturePath = path.join(
  __dirname,
  'fixtures',
  'audit-credential-write-sites',
  'credential-write-site.fixture.ts',
);

describe('detectForbiddenCredentialWrites', () => {
  let originalFixture = '';

  beforeEach(() => {
    originalFixture = fs.readFileSync(fixturePath, 'utf8');
  });

  afterEach(() => {
    fs.writeFileSync(fixturePath, originalFixture, 'utf8');
  });

  it('detects the expected forbidden write variants', () => {
    const sample = `
      writeFileSync(tokenPath, payload, 'utf8');
      fs.promises.writeFile(tokenPath, payload, 'utf8');
      writeFile(tokenPath, payload, () => {});
      outputFileSync(tokenPath, payload);
    `;

    const detected = detectForbiddenCredentialWrites(sample);
    expect(detected).toEqual(
      expect.arrayContaining([
        { label: 'writeFileSync', count: 1 },
        { label: 'fs.promises.writeFile', count: 1 },
        { label: 'writeFile', count: 1 },
        { label: 'outputFileSync', count: 1 },
      ]),
    );
  });

  it('self-test: catches temporary fs.writeFileSync insertion in fixture and restores it', () => {
    const injectedLine = "fs.writeFileSync(tokenPath, payload, 'utf8');";
    fs.writeFileSync(fixturePath, `${originalFixture}\n${injectedLine}\n`, 'utf8');

    const mutatedContent = fs.readFileSync(fixturePath, 'utf8');
    const detected = detectForbiddenCredentialWrites(mutatedContent);
    expect(detected).toEqual(expect.arrayContaining([{ label: 'writeFileSync', count: 1 }]));
  });
});

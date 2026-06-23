import { describe, expect, test } from 'vitest';
import {
  detectLicenseHeader,
  expectedLicenseHeaderHasOwnSpdxIdentifier,
  validateExpectedLicenseHeader,
  type LicenseId,
} from '../license-header-detection';

const positiveFixtures: readonly { id: LicenseId; content: string }[] = [
  { id: 'BUSL-1.1', content: '/**\n * SPDX-License-Identifier: BUSL-1.1\n */\nexport {};\n' },
  { id: 'MSL-1.0', content: '/**\n * SPDX-License-Identifier: MSL-1.0\n */\nexport {};\n' },
  { id: 'MSL', content: '// Mindstone Source License\nexport {};\n' },
  { id: 'MIT', content: '// MIT License\n// Permission is hereby granted, free of charge\n' },
  { id: 'Apache-2.0', content: '/*\n * Licensed under the Apache License, Version 2.0\n */\n' },
  {
    id: 'BSD-2-Clause',
    content: [
      '# BSD 2-Clause License',
      '# Redistribution and use in source and binary forms, with or without modification',
      '# This software is provided by the copyright holders.',
      '',
    ].join('\n'),
  },
  {
    id: 'BSD-3-Clause',
    content: [
      '<!--',
      'BSD 3-Clause License',
      'Redistribution and use in source and binary forms, with or without modification',
      'Neither the name of the copyright holder may be used to endorse products.',
      '-->',
      '',
    ].join('\n'),
  },
  { id: 'ISC', content: '// ISC License\n// Permission to use, copy, modify, and/or distribute this software\n' },
  {
    id: 'MPL-2.0',
    content: '/* This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. */\n',
  },
  { id: 'GPL', content: '#!/usr/bin/env node\n// SPDX-License-Identifier: GPL-3.0-or-later\n' },
  { id: 'LGPL', content: '// GNU Lesser General Public License\n' },
  { id: 'PolyForm', content: '// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0\n' },
  { id: 'FSL', content: '// Functional Source License\n' },
];

describe('detectLicenseHeader', () => {
  test.each(positiveFixtures)('detects $id headers', ({ id, content }) => {
    expect(detectLicenseHeader(content)).toBe(id);
  });

  test.each(positiveFixtures)('does not detect $id wording outside the bounded header region', ({ content }) => {
    const padded = `${Array.from({ length: 230 }, (_, index) => `const line${index} = ${index};`).join('\n')}\n${content}`;
    expect(detectLicenseHeader(padded)).toBeNull();
  });

  test('returns null for ordinary source and prose that is not a license header', () => {
    expect(detectLicenseHeader('export const license = "MIT-compatible setting";\n')).toBeNull();
    expect(detectLicenseHeader('# Notes\n\nThis project can read SPDX metadata from package manifests.\n')).toBeNull();
  });

  test('handles BOM and shebang before the header', () => {
    expect(detectLicenseHeader('\uFEFF#!/usr/bin/env python\n# SPDX-License-Identifier: Apache-2.0\n')).toBe('Apache-2.0');
  });

  test.each([
    { expression: '(MIT OR Apache-2.0)', expected: 'MIT' },
    { expression: 'MIT AND ISC', expected: 'MIT' },
    { expression: 'Apache-2.0 WITH LLVM-exception', expected: 'Apache-2.0' },
    { expression: 'BUSL-1.1', expected: 'BUSL-1.1' },
    { expression: 'MSL-1.0', expected: 'MSL-1.0' },
  ] as const)('detects SPDX expression $expression as $expected', ({ expression, expected }) => {
    expect(detectLicenseHeader(`// SPDX-License-Identifier: ${expression}\nexport {};\n`)).toBe(expected);
  });
});

describe('expected license header validation', () => {
  test('requires activated expected headers to contain the BUSL-1.1 SPDX identifier', () => {
    expect(expectedLicenseHeaderHasOwnSpdxIdentifier('SPDX-License-Identifier: BUSL-1.1\nSynthetic fixture')).toBe(true);
    expect(expectedLicenseHeaderHasOwnSpdxIdentifier('SPDX-License-Identifier: MSL-1.0\nSynthetic fixture')).toBe(false);
    expect(expectedLicenseHeaderHasOwnSpdxIdentifier('TODO legal')).toBe(false);
    expect(() => validateExpectedLicenseHeader('TODO legal')).toThrow(/SPDX-License-Identifier: BUSL-1\.1/u);
  });

  test('allows null as the pending no-op state', () => {
    expect(() => validateExpectedLicenseHeader(null)).not.toThrow();
  });
});

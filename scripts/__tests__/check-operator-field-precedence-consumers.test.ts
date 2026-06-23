import { describe, it, expect } from 'vitest';
import {
  analyzeOperatorPrecedence,
  referencesField,
  typeDeclaresField,
  type PrecedenceCheckDeps,
  type PrecedencePair,
} from '../check-operator-field-precedence-consumers';

const PAIR: PrecedencePair = {
  newField: 'consultationPrompt',
  oldField: 'body',
  consumers: ['src/core/services/operatorConsultRunner.ts'],
};

const TYPE_SRC =
  'export interface OperatorDefinition {\n  body: string;\n  consultationPrompt?: string;\n  name: string;\n  displayName?: string;\n}';

function makeDeps(overrides: Partial<PrecedenceCheckDeps>): PrecedenceCheckDeps {
  return {
    operatorTypesSource: TYPE_SRC,
    filesReferencing: () => ['src/somewhere.ts'],
    readFile: () => 'const x = operator.consultationPrompt ?? operator.body;',
    pairs: [PAIR],
    ...overrides,
  };
}

describe('referencesField — AST property/binding precision', () => {
  it('matches property access (.field, ?.field)', () => {
    expect(referencesField('operator.displayName ?? operator.name', 'displayName')).toBe(true);
    expect(referencesField('operator.consultationPrompt?.trim()', 'consultationPrompt')).toBe(true);
  });

  it('matches value-position bracket access', () => {
    expect(referencesField("const a = operator['displayName'];", 'displayName')).toBe(true);
  });

  it('matches destructure bindings (const + typed param + alias)', () => {
    expect(referencesField('const { displayName } = props;', 'displayName')).toBe(true);
    expect(referencesField('const { consultationPrompt, source } = resolve(operator);', 'consultationPrompt')).toBe(true);
    // typed parameter destructure — the React/TS pattern the regex version missed
    expect(referencesField('function Card({ name }: OperatorMetadata) {}', 'name')).toBe(true);
    // alias destructure { name: foo } still reads `name`
    expect(referencesField('const { name: foo } = operator;', 'name')).toBe(true);
  });

  it('does NOT match a JSX expression container (local var render)', () => {
    expect(referencesField('const x = <h3>{displayName}</h3>;', 'displayName')).toBe(false);
  });

  it('does NOT match an inline type-literal annotation', () => {
    expect(referencesField('const v: { consultationPrompt: string; source: number } = x;', 'consultationPrompt')).toBe(false);
  });

  it('does NOT match an indexed-access TYPE', () => {
    expect(referencesField('type X = OperatorDefinition["displayName"];', 'displayName')).toBe(false);
  });

  it('does NOT match comments or string literals', () => {
    expect(referencesField('// reads operator.displayName here', 'displayName')).toBe(false);
    expect(referencesField('const s = "operator.displayName";', 'displayName')).toBe(false);
  });

  it('does NOT let `name` match inside `displayName`', () => {
    expect(referencesField('operator.displayName', 'name')).toBe(false);
  });
});

describe('typeDeclaresField', () => {
  it('detects declared optional + required members', () => {
    expect(typeDeclaresField(TYPE_SRC, 'consultationPrompt')).toBe(true);
    expect(typeDeclaresField(TYPE_SRC, 'body')).toBe(true);
  });
  it('returns false for an absent field', () => {
    expect(typeDeclaresField(TYPE_SRC, 'nonexistent')).toBe(false);
  });
});

describe('analyzeOperatorPrecedence', () => {
  it('PASSES when the new field is wired and consumers honor precedence', () => {
    const result = analyzeOperatorPrecedence(makeDeps({}));
    expect(result.exitCode).toBe(0);
    expect(result.violations).toHaveLength(0);
  });

  it('FAILS (old-only-consumer) when a consumer reads only the superseded field', () => {
    const result = analyzeOperatorPrecedence(
      makeDeps({ readFile: () => 'const prompt = operator.body;' }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.violations.map((v) => v.kind)).toContain('old-only-consumer');
  });

  it('FAILS (unwired-new-field) when the precedence field is read nowhere', () => {
    const result = analyzeOperatorPrecedence(makeDeps({ filesReferencing: () => [] }));
    expect(result.exitCode).toBe(1);
    expect(result.violations.map((v) => v.kind)).toContain('unwired-new-field');
  });

  it('FAILS (missing-on-type) when the registry references an undeclared field', () => {
    const result = analyzeOperatorPrecedence(
      makeDeps({ operatorTypesSource: 'export interface OperatorDefinition {\n  body: string;\n}' }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.violations.map((v) => v.kind)).toContain('missing-on-type');
  });

  it('FAILS (missing-consumer-file) when a declared consumer file is absent', () => {
    const result = analyzeOperatorPrecedence(makeDeps({ readFile: () => null }));
    expect(result.exitCode).toBe(1);
    expect(result.violations.map((v) => v.kind)).toContain('missing-consumer-file');
  });

  it('PASSES when a consumer reads neither field (not a violation — only old-only is)', () => {
    const result = analyzeOperatorPrecedence(makeDeps({ readFile: () => 'const x = unrelated();' }));
    expect(result.exitCode).toBe(0);
  });
});

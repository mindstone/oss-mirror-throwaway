#!/usr/bin/env npx tsx
/**
 * CI Validation: Translator Schema vs Consumer Agreement
 *
 * Guards Codex Responses translators against re-tightening Zod schemas beyond
 * what the consumer actually needs, and against unsafe consumer reads that the
 * schema does not validate or default.
 *
 * Initial scope is deliberately narrow: ResponsesApiResponseSchema and
 * translateResponsesToChatCompletion in codexResponsesTranslator.ts.
 *
 * Run: npx tsx scripts/check-translator-schema-vs-consumer.ts
 * Wired into: npm run validate:fast
 *
 * @see docs/plans/260506_codex_sse_parser_unification.md
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const REPO_ROOT = path.join(__dirname, '..');
const DEFAULT_TRANSLATOR_PATH = path.join(
  REPO_ROOT,
  'src',
  'core',
  'services',
  'codexResponsesTranslator.ts',
);

const DEFAULT_SCHEMA_NAME = 'ResponsesApiResponseSchema';
const DEFAULT_CONSUMER_NAME = 'translateResponsesToChatCompletion';
const DEFAULT_EXEMPT_SCHEMA_REQUIRED_FIELDS = new Set(['status', 'error']);
const BANNED_DISABLE_REASONS = new Set(['', 'WIP', 'TODO']);

export interface SchemaFieldInfo {
  name: string;
  line: number;
  required: boolean;
  hasOptional: boolean;
  hasCatch: boolean;
}

export interface ConsumerFieldInfo {
  name: string;
  line: number;
  unsafeRead: boolean;
  optionalOrFallbackRead: boolean;
}

export interface TranslatorCheckViolation {
  kind: 'schema-overstrict' | 'consumer-understrict' | 'unsupported-pattern';
  field?: string;
  file: string;
  line: number;
  message: string;
  recommendedAction: string;
}

export interface TranslatorCheckResult {
  exitCode: 0 | 1;
  skipped: boolean;
  fieldCount: number;
  output: string[];
  warnings: string[];
  violations: TranslatorCheckViolation[];
}

export interface TranslatorCheckOptions {
  filePath: string;
  sourceText?: string;
  schemaName?: string;
  consumerName?: string;
  exemptSchemaRequiredFields?: Set<string>;
}

interface DisableComment {
  reason: string;
  banned: boolean;
  line: number;
}

function relativeFile(filePath: string): string {
  return path.relative(REPO_ROOT, filePath) || filePath;
}

function lineOf(sourceFile: ts.SourceFile, nodeOrPosition: ts.Node | number): number {
  const position = typeof nodeOrPosition === 'number'
    ? nodeOrPosition
    : nodeOrPosition.getStart(sourceFile);
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isNamedPropertyAccess(expression: ts.Expression, objectName: string, propertyName: string): boolean {
  const unwrapped = unwrapExpression(expression);
  return (
    ts.isPropertyAccessExpression(unwrapped) &&
    unwrapped.name.text === propertyName &&
    ts.isIdentifier(unwrapped.expression) &&
    unwrapped.expression.text === objectName
  );
}

function findZodObjectLiteral(initializer: ts.Expression | undefined): ts.ObjectLiteralExpression | null {
  if (!initializer) return null;
  const expression = unwrapExpression(initializer);

  if (
    !ts.isCallExpression(expression) ||
    !isNamedPropertyAccess(expression.expression, 'z', 'object')
  ) {
    return null;
  }

  const [shape] = expression.arguments;
  return shape && ts.isObjectLiteralExpression(shape) ? shape : null;
}

function hasChainedMethod(expression: ts.Expression, methodName: string): boolean {
  let current: ts.Expression = unwrapExpression(expression);

  while (ts.isCallExpression(current)) {
    const callTarget = unwrapExpression(current.expression);
    if (ts.isPropertyAccessExpression(callTarget)) {
      if (callTarget.name.text === methodName) return true;
      current = unwrapExpression(callTarget.expression);
      continue;
    }
    break;
  }

  return false;
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function findSchemaDeclaration(
  sourceFile: ts.SourceFile,
  schemaName: string,
): { declaration: ts.VariableDeclaration; statement: ts.VariableStatement } | null {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === schemaName) {
        return { declaration, statement };
      }
    }
  }
  return null;
}

function findDisableComment(sourceFile: ts.SourceFile, node: ts.Node): DisableComment | null {
  const fullText = sourceFile.getFullText();
  const ranges = ts.getLeadingCommentRanges(fullText, node.getFullStart()) ?? [];

  for (const range of ranges) {
    const commentText = fullText.slice(range.pos, range.end);
    const match = commentText.match(/translator-check-disable:\s*([^\r\n*]*)/);
    if (!match) continue;

    const reason = match[1]?.trim() ?? '';
    return {
      reason,
      banned: BANNED_DISABLE_REASONS.has(reason.toUpperCase()),
      line: lineOf(sourceFile, range.pos),
    };
  }

  return null;
}

function extractSchemaFields(
  sourceFile: ts.SourceFile,
  schemaDeclaration: ts.VariableDeclaration,
  file: string,
): { fields: Map<string, SchemaFieldInfo>; unsupported?: TranslatorCheckViolation } {
  const shape = findZodObjectLiteral(schemaDeclaration.initializer);
  if (!shape) {
    return {
      fields: new Map(),
      unsupported: {
        kind: 'unsupported-pattern',
        file,
        line: lineOf(sourceFile, schemaDeclaration),
        message: 'Schema initializer is not a static z.object({ ... }) literal.',
        recommendedAction: 'Use the static z.object({ ... }) pattern or add translator-check-disable with a durable reason.',
      },
    };
  }

  const fields = new Map<string, SchemaFieldInfo>();
  for (const property of shape.properties) {
    if (!ts.isPropertyAssignment(property)) {
      return {
        fields,
        unsupported: {
          kind: 'unsupported-pattern',
          file,
          line: lineOf(sourceFile, property),
          message: 'Schema object contains a non-property-assignment entry.',
          recommendedAction: 'Keep translator schema top-level fields as static property assignments.',
        },
      };
    }

    const name = propertyNameText(property.name);
    if (!name) {
      return {
        fields,
        unsupported: {
          kind: 'unsupported-pattern',
          file,
          line: lineOf(sourceFile, property),
          message: 'Schema object contains a computed top-level property.',
          recommendedAction: 'Use a static property name or opt out with translator-check-disable and a durable reason.',
        },
      };
    }

    const hasOptional = hasChainedMethod(property.initializer, 'optional');
    const hasCatch = hasChainedMethod(property.initializer, 'catch');
    fields.set(name, {
      name,
      line: lineOf(sourceFile, property.name),
      required: !hasOptional && !hasCatch,
      hasOptional,
      hasCatch,
    });
  }

  return { fields };
}

function findConsumerFunction(sourceFile: ts.SourceFile, consumerName: string): ts.FunctionDeclaration | null {
  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === consumerName &&
      statement.body
    ) {
      return statement;
    }
  }
  return null;
}

function hasQuestionDotToken(node: ts.Node): boolean {
  return Boolean((node as { questionDotToken?: ts.QuestionDotToken }).questionDotToken);
}

function isNodeWithin(container: ts.Node, node: ts.Node): boolean {
  return node.pos >= container.pos && node.end <= container.end;
}

function hasOptionalOrFallbackContext(node: ts.Node, stopAt: ts.Node): boolean {
  let current: ts.Node = node;
  while (current.parent && current !== stopAt) {
    const parent = current.parent;
    if (hasQuestionDotToken(parent)) return true;
    if (
      ts.isBinaryExpression(parent) &&
      (parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        parent.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
      isNodeWithin(parent.left, node)
    ) {
      return true;
    }
    current = parent;
  }
  return hasQuestionDotToken(node);
}

function isUnsafeTopLevelUse(node: ts.PropertyAccessExpression, stopAt: ts.Node): boolean {
  let current: ts.Node = node;
  let parent = current.parent;

  while (parent && parent !== stopAt) {
    if (ts.isForOfStatement(parent) && parent.expression === current) return true;

    if (
      (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
      parent.expression === current
    ) {
      return true;
    }

    if (ts.isCallExpression(parent) && parent.expression === current) return true;

    current = parent;
    parent = current.parent;
  }

  return false;
}

function extractConsumerFields(
  sourceFile: ts.SourceFile,
  consumerFunction: ts.FunctionDeclaration,
): Map<string, ConsumerFieldInfo> {
  const fields = new Map<string, ConsumerFieldInfo>();
  const paramNameNode = consumerFunction.parameters[0]?.name;
  if (!paramNameNode || !ts.isIdentifier(paramNameNode) || !consumerFunction.body) {
    return fields;
  }
  const paramName = paramNameNode.text;

  function markField(
    name: string,
    line: number,
    update: Pick<ConsumerFieldInfo, 'unsafeRead' | 'optionalOrFallbackRead'>,
  ): void {
    const existing = fields.get(name);
    if (!existing) {
      fields.set(name, { name, line, ...update });
      return;
    }

    existing.line = Math.min(existing.line, line);
    existing.unsafeRead = existing.unsafeRead || update.unsafeRead;
    existing.optionalOrFallbackRead = existing.optionalOrFallbackRead || update.optionalOrFallbackRead;
  }

  function visit(node: ts.Node): void {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === paramName
    ) {
      const optionalOrFallbackRead = hasOptionalOrFallbackContext(node, consumerFunction);
      markField(node.name.text, lineOf(sourceFile, node.name), {
        unsafeRead: !optionalOrFallbackRead && isUnsafeTopLevelUse(node, consumerFunction),
        optionalOrFallbackRead,
      });
    }
    ts.forEachChild(node, visit);
  }

  visit(consumerFunction.body);

  // If a field is read through any optional/fallback path, do not treat guarded
  // nested reads in the same function as an unsafe top-level requirement. This
  // keeps the rule scoped to structural translator drift rather than attempting
  // full control-flow analysis.
  for (const field of fields.values()) {
    if (field.optionalOrFallbackRead) field.unsafeRead = false;
  }

  return fields;
}

export function analyzeTranslatorSchemaVsConsumer(options: TranslatorCheckOptions): TranslatorCheckResult {
  const schemaName = options.schemaName ?? DEFAULT_SCHEMA_NAME;
  const consumerName = options.consumerName ?? DEFAULT_CONSUMER_NAME;
  const exemptSchemaRequiredFields = options.exemptSchemaRequiredFields ?? DEFAULT_EXEMPT_SCHEMA_REQUIRED_FIELDS;
  const sourceText = options.sourceText ?? fs.readFileSync(options.filePath, 'utf8');
  const sourceFile = ts.createSourceFile(options.filePath, sourceText, ts.ScriptTarget.Latest, true);
  const file = relativeFile(options.filePath);
  const output: string[] = [];
  const warnings: string[] = [];
  const violations: TranslatorCheckViolation[] = [];

  const schema = findSchemaDeclaration(sourceFile, schemaName);
  if (!schema) {
    violations.push({
      kind: 'unsupported-pattern',
      file,
      line: 1,
      message: `Could not find schema declaration "${schemaName}".`,
      recommendedAction: 'Update the checker configuration or restore the expected schema export.',
    });
    return { exitCode: 1, skipped: false, fieldCount: 0, output, warnings, violations };
  }

  const disableComment = findDisableComment(sourceFile, schema.statement);
  if (disableComment?.banned) {
    warnings.push(
      `! ${schemaName}: ignored banned translator-check-disable reason "${disableComment.reason}" at ${file}:${disableComment.line}`,
    );
  } else if (disableComment) {
    warnings.push(
      `! ${schemaName}: translator-check-disable exercised at ${file}:${disableComment.line} (${disableComment.reason})`,
    );
    return { exitCode: 0, skipped: true, fieldCount: 0, output, warnings, violations };
  }

  const { fields: schemaFields, unsupported } = extractSchemaFields(sourceFile, schema.declaration, file);
  if (unsupported) violations.push(unsupported);

  const consumerFunction = findConsumerFunction(sourceFile, consumerName);
  if (!consumerFunction) {
    violations.push({
      kind: 'unsupported-pattern',
      file,
      line: 1,
      message: `Could not find consumer function "${consumerName}".`,
      recommendedAction: 'Update the checker configuration or restore the expected consumer function.',
    });
  }

  const consumerFields = consumerFunction
    ? extractConsumerFields(sourceFile, consumerFunction)
    : new Map<string, ConsumerFieldInfo>();
  const unsafeConsumerFields = new Set(
    [...consumerFields.values()]
      .filter((field) => field.unsafeRead)
      .map((field) => field.name),
  );

  for (const field of schemaFields.values()) {
    if (
      field.required &&
      !unsafeConsumerFields.has(field.name) &&
      !exemptSchemaRequiredFields.has(field.name)
    ) {
      violations.push({
        kind: 'schema-overstrict',
        field: field.name,
        file,
        line: field.line,
        message: `Schema requires "${field.name}", but ${consumerName} does not require that upstream field to be present.`,
        recommendedAction: `Add .optional() or .catch(...) to "${field.name}", or remove the schema field if it is obsolete.`,
      });
    }
  }

  for (const field of consumerFields.values()) {
    if (!field.unsafeRead) continue;
    const schemaField = schemaFields.get(field.name);
    if (!schemaField || schemaField.hasOptional) {
      violations.push({
        kind: 'consumer-understrict',
        field: field.name,
        file,
        line: field.line,
        message: `${consumerName} unsafely reads "${field.name}", but ${schemaName} does not require or default it.`,
        recommendedAction: `Add "${field.name}" to ${schemaName} with a required/defaulted validator, or guard the consumer read with ?. or ?? fallback.`,
      });
    }
  }

  if (violations.length > 0) {
    output.push(`✗ ${schemaName}: schema and consumer drift detected`);
    for (const violation of violations) {
      output.push(`  ${violation.file}:${violation.line} [${violation.kind}]`);
      if (violation.field) output.push(`    Field: ${violation.field}`);
      output.push(`    ${violation.message}`);
      output.push(`    Recommended action: ${violation.recommendedAction}`);
    }
    return { exitCode: 1, skipped: false, fieldCount: schemaFields.size, output, warnings, violations };
  }

  output.push(`✓ ${schemaName}: schema and consumer agree (${schemaFields.size} fields)`);
  return { exitCode: 0, skipped: false, fieldCount: schemaFields.size, output, warnings, violations };
}

function parseCliArgs(argv: string[]): { filePath: string } {
  const fileFlagIndex = argv.indexOf('--file');
  if (fileFlagIndex !== -1) {
    const value = argv[fileFlagIndex + 1];
    if (!value) {
      throw new Error('Missing value for --file');
    }
    return { filePath: path.resolve(value) };
  }

  return { filePath: DEFAULT_TRANSLATOR_PATH };
}

if (!process.env.VITEST) {
  let result: TranslatorCheckResult;
  try {
    const args = parseCliArgs(process.argv.slice(2));
    result = analyzeTranslatorSchemaVsConsumer({ filePath: args.filePath });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  for (const warning of result.warnings) console.warn(warning);
  for (const line of result.output) {
    if (result.exitCode === 0) console.log(line);
    else console.error(line);
  }
  process.exit(result.exitCode);
}

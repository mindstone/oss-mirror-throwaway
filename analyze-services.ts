import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const filesToAnalyze = [
  'src/main/services/agentTurnExecutor.ts',
  'src/main/services/automationScheduler.ts',
  'src/main/services/bundledInboxBridge.ts',
  'src/main/services/spaceService.ts',
  'src/main/services/toolSafetyService.ts',
  'src/main/services/mcpService.ts',
  'src/main/services/fileIndexService.ts',
  'src/main/services/conversationIndexService.ts',
  'src/main/services/embeddingService.ts',
  'src/main/services/authService.ts',
];

function analyzeFile(filePath: string) {
  const fullPath = path.resolve(filePath);
  const content = fs.readFileSync(fullPath, 'utf-8');
  const sourceFile = ts.createSourceFile(
    fullPath,
    content,
    ts.ScriptTarget.Latest,
    true
  );

  const electronImports = new Set<string>();
  const allNodes: any[] = [];

  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node)) {
      const moduleName = (node.moduleSpecifier as ts.StringLiteral).text;
      if (moduleName === 'electron') {
        if (node.importClause && node.importClause.namedBindings) {
          if (ts.isNamedImports(node.importClause.namedBindings)) {
            node.importClause.namedBindings.elements.forEach((el) => {
              electronImports.add(el.name.text);
            });
          }
        }
      }
    } else if (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isVariableStatement(node)
    ) {
      if (node.parent === sourceFile) {
         let name = 'Unknown';
         if (ts.isFunctionDeclaration(node) && node.name) {
           name = node.name.text;
         } else if (ts.isClassDeclaration(node) && node.name) {
           name = node.name.text;
         } else if (ts.isVariableStatement(node)) {
           const decl = node.declarationList.declarations[0];
           if (decl && ts.isIdentifier(decl.name)) {
             name = decl.name.text;
           }
         }
         
         const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
         const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
         const lines = endLine - startLine + 1;
         
         const text = node.getText();
         let hasElectronDependency = false;
         electronImports.forEach(imp => {
           // simple text match for the import
           if (text.includes(imp)) {
             hasElectronDependency = true;
           }
         });
         
         allNodes.push({
           type: ts.SyntaxKind[node.kind],
           name,
           lines,
           hasElectronDependency
         });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  const extractable = allNodes.filter(n => !n.hasElectronDependency && n.lines > 10);
  const nonExtractable = allNodes.filter(n => n.hasElectronDependency && n.lines > 10);
  
  const extractableLines = extractable.reduce((acc, n) => acc + n.lines, 0);
  const nonExtractableLines = nonExtractable.reduce((acc, n) => acc + n.lines, 0);
  
  console.log(`\n=== ${filePath} ===`);
  console.log(`Electron imports: ${Array.from(electronImports).join(', ')}`);
  console.log(`Extractable functions/classes (>10 lines):`);
  extractable.forEach(n => console.log(`  - ${n.name} (${n.lines} lines)`));
  console.log(`Non-extractable functions/classes (>10 lines):`);
  nonExtractable.forEach(n => console.log(`  - ${n.name} (${n.lines} lines)`));
  
  console.log(`Summary: ${extractableLines} extractable lines, ${nonExtractableLines} non-extractable lines`);
}

filesToAnalyze.forEach(analyzeFile);

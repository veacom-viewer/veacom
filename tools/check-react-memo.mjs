import path from 'node:path';
import { API, SymbolFlags } from 'typescript/unstable/sync';
import { isBindingElement, isElementAccessExpression, isIdentifier, isStringLiteral, isTypeNode } from 'typescript/unstable/ast';

const banned = new Set(['useCallback', 'useMemo', 'memo']);
const config = path.resolve(process.argv[2] ?? 'tools/tsconfig.react-memo.json');
const api = new API();
try {
  const { program, checker, rootFiles } = api.updateSnapshot({ openProjects: [config] }).getProject(config);
  const errors = [];
  for (const file of rootFiles) {
    if (/\.d\.[cm]?ts$/.test(file)) continue;
    const source = program.getSourceFile(file);
    function visit(node) {
      if (node.isTypeOnly || isTypeNode(node)) return;
      const named = (isIdentifier(node) || isStringLiteral(node)) && banned.has(node.text);
      const computed = isElementAccessExpression(node) && !isStringLiteral(node.argumentExpression);
      if (named || computed) {
        let symbol = checker.getSymbolAtLocation(node);
        if (symbol && (symbol.flags & SymbolFlags.Alias)) symbol = checker.getAliasedSymbol(symbol);
        // A shorthand binding names a new local variable. Its type still identifies the React export.
        if (computed || (isBindingElement(node.parent) && !node.parent.propertyName)) symbol = checker.getTypeAtLocation(node)?.getSymbol();
        if (banned.has(symbol?.name) && symbol.declarations.some(declaration => /\/node_modules\/(?:@types\/)?react\//.test(declaration.path))) {
          const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
          errors.push(`${path.relative(process.cwd(), file)}:${line + 1}:${character + 1} React.${symbol.name}`);
        }
      }
      node.forEachChild(visit);
    }
    visit(source);
  }
  if (errors.length) {
    console.error('Use the React Compiler for memoization. Remove these React APIs:\n' + errors.join('\n'));
    process.exitCode = 1;
  } else console.log('PASS React compiler memoization rule');
} finally {
  api.close();
}

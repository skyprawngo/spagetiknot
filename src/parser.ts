import * as vscode from 'vscode';

export interface FunctionInfo {
  name: string;
  filePath: string;
  line: number;
  kind: 'function' | 'method' | 'arrow' | 'export';
}

/**
 * Regex patterns to detect function declarations across common languages.
 * Each pattern captures the function name in group 1.
 */
const FUNCTION_PATTERNS: RegExp[] = [
  // JS/TS: function foo(
  /\bfunction\s+([a-zA-Z_$][\w$]*)\s*\(/g,
  // JS/TS: const/let/var foo = (...) => | function(
  /\b(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_$][\w$]*)\s*=>/g,
  // JS/TS: const/let/var foo = function(
  /\b(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s+)?function\s*\(/g,
  // JS/TS class method: foo( or async foo(
  /^\s+(?:async\s+)?([a-zA-Z_$][\w$]*)\s*\([^)]*\)\s*\{/gm,
  // Python: def foo(
  /\bdef\s+([a-zA-Z_]\w*)\s*\(/g,
  // Go: func foo(  or func (r Receiver) foo(
  /\bfunc\s+(?:\([^)]*\)\s+)?([a-zA-Z_]\w*)\s*\(/g,
  // Rust: fn foo(
  /\bfn\s+([a-zA-Z_]\w*)\s*[(<]/g,
  // Java/C#/C++: public/private/protected/static ... returnType foo(
  /\b(?:public|private|protected|static|final|virtual|override|abstract)\s+[\w<>\[\],\s]+\s+([a-zA-Z_]\w*)\s*\(/g,
  // export function / export default function
  /\bexport\s+(?:default\s+)?(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)\s*\(/g,
];

export async function parseFunctions(uri: vscode.Uri): Promise<FunctionInfo[]> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const text = doc.getText();
  const results: FunctionInfo[] = [];
  const seen = new Set<string>();

  for (const pattern of FUNCTION_PATTERNS) {
    // Reset regex state
    const re = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const name = match[1];
      const line = doc.positionAt(match.index).line;
      const key = `${name}:${line}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push({
          name,
          filePath: uri.fsPath,
          line,
          kind: 'function',
        });
      }
    }
  }

  return results;
}

export async function parseWorkspaceFunctions(): Promise<FunctionInfo[]> {
  const files = await vscode.workspace.findFiles(
    '**/*.{ts,tsx,js,jsx,py,go,rs,java,cs,cpp,c,h}',
    '**/node_modules/**',
    500
  );

  const allFunctions: FunctionInfo[] = [];
  for (const file of files) {
    const fns = await parseFunctions(file);
    allFunctions.push(...fns);
  }

  return allFunctions;
}

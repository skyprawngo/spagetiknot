/**
 * @module parser
 * @description Scans source files and extracts function declarations via regex.
 *
 * ┌──────────────────────────┬──────────────────────────────────────────────┐
 * │ Function                 │ Role                                        │
 * ├──────────────────────────┼──────────────────────────────────────────────┤
 * │ parseFunctions           │ Single file → FunctionInfo[].               │
 * │                          │ Called by: parseWorkspaceFunctions           │
 * │ parseWorkspaceFunctions  │ Workspace glob → all FunctionInfo[].        │
 * │                          │ Called by: extension.ts (activate command)   │
 * └──────────────────────────┴──────────────────────────────────────────────┘
 *
 * Supported languages: JS/TS, Python, Go, Rust, Java/C#/C++
 */
import * as vscode from 'vscode';

export interface FunctionInfo {
  name: string;
  filePath: string;
  line: number;
  kind: 'function' | 'method' | 'arrow' | 'export';
  params: string[];
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
  // JS/TS class method: foo( or async foo(  (excludes control-flow keywords)
  /^\s+(?:async\s+)?(?!if|else|for|while|switch|catch|do|return|throw|new|typeof|await|yield\b)([a-zA-Z_$][\w$]*)\s*\([^)]*\)\s*\{/gm,
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
        // Extract parameter list from the line
        const lineText = doc.lineAt(line).text;
        const params = extractParams(lineText);
        results.push({
          name,
          filePath: uri.fsPath,
          line,
          kind: 'function',
          params,
        });
      }
    }
  }

  return results;
}

function extractParams(lineText: string): string[] {
  // Find the first balanced (...) pair
  const openIdx = lineText.indexOf('(');
  if (openIdx === -1) { return []; }
  let depth = 0;
  let closeIdx = -1;
  for (let i = openIdx; i < lineText.length; i++) {
    if (lineText[i] === '(') depth++;
    if (lineText[i] === ')') depth--;
    if (depth === 0) { closeIdx = i; break; }
  }
  if (closeIdx === -1) { return []; }
  const inner = lineText.slice(openIdx + 1, closeIdx).trim();
  if (inner.length === 0) { return []; }

  // Split on top-level commas (skip commas inside nested parens/brackets)
  const params: string[] = [];
  let current = '';
  let d = 0;
  for (const ch of inner) {
    if (ch === '(' || ch === '<' || ch === '[') d++;
    if (ch === ')' || ch === '>' || ch === ']') d--;
    if (ch === ',' && d === 0) {
      params.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  params.push(current);

  return params
    .map((p) => {
      let name = p.trim();
      // Strip type annotations (TS `: type`, C# `Type name`, Java `Type name`)
      // Try "name: type" pattern first (TS/Python)
      const colonMatch = name.match(/^([a-zA-Z_$][\w$]*)\s*[:\?]/);
      if (colonMatch) return colonMatch[1];
      // Try "Type name" pattern (C#/Java/Go) — take the last word
      const words = name.split(/\s+/).filter(w => w.length > 0);
      if (words.length >= 2) return words[words.length - 1].replace(/[,;]$/, '');
      // Single word — strip defaults
      return name.replace(/=.*$/, '').trim();
    })
    .filter((p) => p.length > 0 && !p.startsWith('...'));
}

export async function parseWorkspaceFunctions(targetDir?: string): Promise<FunctionInfo[]> {
  const pattern = targetDir
    ? new vscode.RelativePattern(targetDir, '**/*.{ts,tsx,js,jsx,py,go,rs,java,cs,cpp,c,h}')
    : '**/*.{ts,tsx,js,jsx,py,go,rs,java,cs,cpp,c,h}';

  const files = await vscode.workspace.findFiles(
    pattern,
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

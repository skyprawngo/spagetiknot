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
 * Supported languages: JS/TS, Python, Go, Rust, Java/C#/C++, Swift
 *
 * Each language uses its own pattern set so cross-language false positives
 * (e.g. SwiftUI view-builder calls matching JS class-method patterns) are avoided.
 */
import * as vscode from 'vscode';
import * as path from 'path';

export interface FunctionInfo {
  name: string;
  filePath: string;
  line: number;
  kind: 'function' | 'method' | 'arrow' | 'export';
  params: string[];
  comment: string;
}

// ──────────────────────────────────────────────
//  Per-language pattern sets
//  Each pattern MUST capture the function name in group 1.
// ──────────────────────────────────────────────

const PATTERNS_JS_TS: RegExp[] = [
  // function foo(
  /\bfunction\s+([a-zA-Z_$][\w$]*)\s*\(/g,
  // const/let/var foo = (...) =>
  /\b(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_$][\w$]*)\s*=>/g,
  // const/let/var foo = function(
  /\b(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s+)?function\s*\(/g,
  // Class method: foo( ... ) {   (excludes control-flow keywords)
  /^\s+(?:async\s+)?(?!if|else|for|while|switch|catch|do|return|throw|new|typeof|await|yield\b)([a-zA-Z_$][\w$]*)\s*\([^)]*\)\s*\{/gm,
  // export function / export default function
  /\bexport\s+(?:default\s+)?(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)\s*\(/g,
];

const PATTERNS_PYTHON: RegExp[] = [
  // def foo(
  /\bdef\s+([a-zA-Z_]\w*)\s*\(/g,
];

const PATTERNS_GO: RegExp[] = [
  // func foo(  or  func (r Receiver) foo(
  /\bfunc\s+(?:\([^)]*\)\s+)?([a-zA-Z_]\w*)\s*\(/g,
];

const PATTERNS_RUST: RegExp[] = [
  // fn foo(  or  fn foo<T>(
  /\bfn\s+([a-zA-Z_]\w*)\s*[(<]/g,
];

const PATTERNS_JAVA_CS_CPP: RegExp[] = [
  // public/private/protected/static ... ReturnType foo(
  /\b(?:public|private|protected|static|final|virtual|override|abstract)\s+[\w<>\[\],\s]+\s+([a-zA-Z_]\w*)\s*\(/g,
];

const PATTERNS_SWIFT: RegExp[] = [
  // func foo(  with optional modifiers — matches only explicit `func` declarations
  /\b(?:(?:mutating|static|class|private|internal|public|open|fileprivate)\s+)*func\s+([a-zA-Z_]\w*)\s*[(<]/g,
];

/** Select the right pattern set for a given file path. */
function patternsForFile(filePath: string): RegExp[] {
  const ext = path.extname(filePath).toLowerCase().slice(1);
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
      return PATTERNS_JS_TS;
    case 'py':
      return PATTERNS_PYTHON;
    case 'go':
      return PATTERNS_GO;
    case 'rs':
      return PATTERNS_RUST;
    case 'java':
    case 'cs':
    case 'cpp':
    case 'c':
    case 'h':
      return PATTERNS_JAVA_CS_CPP;
    case 'swift':
      return PATTERNS_SWIFT;
    default:
      return [...PATTERNS_JS_TS, ...PATTERNS_PYTHON];
  }
}

export async function parseFunctions(uri: vscode.Uri): Promise<FunctionInfo[]> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const text = doc.getText();
  const results: FunctionInfo[] = [];
  const seen = new Set<string>();

  for (const pattern of patternsForFile(uri.fsPath)) {
    // Always create a fresh RegExp to reset lastIndex
    const re = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const name = match[1];
      // Skip single-character names (local helper shortcuts like `d`, `f`, `g`)
      if (name.length < 2) continue;
      // Skip dunder methods (__init__, __str__, __repr__, etc.) — not meaningful call-graph nodes
      if (name.startsWith('__') && name.endsWith('__')) continue;
      const line = doc.positionAt(match.index).line;
      const key = `${name}:${line}`;
      if (!seen.has(key)) {
        seen.add(key);
        const lineText = doc.lineAt(line).text;
        const params = extractParams(lineText);
        const comment = extractComment(doc, line);
        results.push({
          name,
          filePath: uri.fsPath,
          line,
          kind: 'function',
          params,
          comment,
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

/** Extract the first meaningful comment line right after a function declaration. */
function extractComment(doc: vscode.TextDocument, funcLine: number): string {
  const maxLook = Math.min(funcLine + 5, doc.lineCount);
  for (let i = funcLine + 1; i < maxLook; i++) {
    const raw = doc.lineAt(i).text.trim();
    if (raw === '' || raw === '{' || raw === ':') continue;
    // Python docstring (single or triple quote)
    if (raw.startsWith('"""') || raw.startsWith("'''")) {
      return raw.replace(/^['"]{3}/, '').replace(/['"]{3}.*$/, '').trim();
    }
    // JS/TS/Go/Rust single-line comment
    if (raw.startsWith('//')) {
      return raw.replace(/^\/\/\s*/, '').trim();
    }
    // Block comment continuation
    if (raw.startsWith('*') && !raw.startsWith('*/')) {
      return raw.replace(/^\*\s*/, '').trim();
    }
    // Python/shell hash comment
    if (raw.startsWith('#')) {
      return raw.replace(/^#\s*/, '').trim();
    }
    break; // non-comment code line — stop looking
  }
  return '';
}

export async function parseWorkspaceFunctions(targetDir?: string): Promise<FunctionInfo[]> {
  const pattern = targetDir
    ? new vscode.RelativePattern(targetDir, '**/*.{ts,tsx,js,jsx,py,go,rs,java,cs,cpp,c,h,swift}')
    : '**/*.{ts,tsx,js,jsx,py,go,rs,java,cs,cpp,c,h,swift}';

  const files = await vscode.workspace.findFiles(
    pattern,
    '{**/node_modules/**,**/__pycache__/**,**/venv/**,**/.venv/**,**/site-packages/**,**/.tox/**}',
    500
  );

  const allFunctions: FunctionInfo[] = [];
  for (const file of files) {
    // Skip Python files starting with _ (private/internal/venv helpers)
    // Covers __init__.py, __main__.py, _internal.py, _vendor.py, etc.
    const base = path.basename(file.fsPath);
    if (base.endsWith('.py') && base.startsWith('_')) continue;

    const fns = await parseFunctions(file);
    allFunctions.push(...fns);
  }

  return allFunctions;
}

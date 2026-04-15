/**
 * @module references
 * @description Scans files for function call sites and builds caller→callee edges.
 *
 * ┌────────────────────────┬──────────────────────────────────────────────────┐
 * │ Function               │ Role                                            │
 * ├────────────────────────┼──────────────────────────────────────────────────┤
 * │ findReferences         │ FunctionInfo[] → FlowEdge[].                    │
 * │                        │ Called by: extension.ts (activate command)       │
 * │ nodeId                 │ FunctionInfo → unique string ID for graph node. │
 * │                        │ Called by: findReferences, webview.ts           │
 * │ findEnclosingFunction  │ Resolves which function "owns" a given line.    │
 * │                        │ Called by: findReferences (internal)            │
 * │ escapeRegex            │ Escapes special regex characters in names.      │
 * │                        │ Called by: findReferences (internal)            │
 * │ deduplicateEdges       │ Removes duplicate source→target pairs.         │
 * │                        │ Called by: findReferences (internal)            │
 * └────────────────────────┴──────────────────────────────────────────────────┘
 */
import * as vscode from 'vscode';
import { FunctionInfo } from './parser';

export interface FlowEdge {
  source: string; // "filePath:line:functionName"
  target: string; // "filePath:line:functionName"
  callerFile: string;
  callerLine: number;
  args: string[];       // arguments at the call site
  params: string[];     // parameters of the target function
}

export async function findReferences(
  functions: FunctionInfo[]
): Promise<FlowEdge[]> {
  const edges: FlowEdge[] = [];
  const funcByName = new Map<string, FunctionInfo[]>();

  // Group functions by name for lookup
  for (const fn of functions) {
    const list = funcByName.get(fn.name) || [];
    list.push(fn);
    funcByName.set(fn.name, list);
  }

  // Collect all unique file URIs from the functions
  const fileSet = new Set<string>();
  for (const fn of functions) {
    fileSet.add(fn.filePath);
  }

  // For each file, scan for calls to known function names
  for (const filePath of fileSet) {
    const uri = vscode.Uri.file(filePath);
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(uri);
    } catch {
      continue;
    }

    const text = doc.getText();
    const lines = text.split('\n');

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];

      for (const [name, targets] of funcByName) {
        // Look for function calls: name( or name.call( or .name( etc.
        const callPattern = new RegExp(
          `\\b${escapeRegex(name)}\\s*\\(`,
          'g'
        );
        let callMatch: RegExpExecArray | null;
        while ((callMatch = callPattern.exec(line)) !== null) {
          // Find which function "owns" this line (the caller)
          const callerFn = findEnclosingFunction(functions, filePath, lineIdx);

          for (const target of targets) {
            // Skip self-references (the definition line itself)
            if (target.filePath === filePath && target.line === lineIdx) {
              continue;
            }
            // Skip recursive self-call at definition
            if (
              callerFn &&
              callerFn.name === target.name &&
              callerFn.filePath === target.filePath &&
              callerFn.line === target.line
            ) {
              continue;
            }

            const sourceId = callerFn
              ? nodeId(callerFn)
              : `${filePath}:${lineIdx}:<top-level>`;

            // Extract call arguments from the line
            const callArgs = extractCallArgs(line, callMatch.index);

            edges.push({
              source: sourceId,
              target: nodeId(target),
              callerFile: filePath,
              callerLine: lineIdx,
              args: callArgs,
              params: target.params,
            });
          }
        }
      }
    }
  }

  return deduplicateEdges(edges);
}

function findEnclosingFunction(
  functions: FunctionInfo[],
  filePath: string,
  line: number
): FunctionInfo | undefined {
  // Find the closest function definition that is above or at the given line
  let best: FunctionInfo | undefined;
  for (const fn of functions) {
    if (fn.filePath === filePath && fn.line <= line) {
      if (!best || fn.line > best.line) {
        best = fn;
      }
    }
  }
  return best;
}

export function nodeId(fn: FunctionInfo): string {
  return `${fn.filePath}:${fn.line}:${fn.name}`;
}

function extractCallArgs(line: string, matchStart: number): string[] {
  const parenIdx = line.indexOf('(', matchStart);
  if (parenIdx === -1) { return []; }
  // Balanced paren extraction
  let depth = 0;
  let closeIdx = -1;
  for (let i = parenIdx; i < line.length; i++) {
    if (line[i] === '(') depth++;
    if (line[i] === ')') depth--;
    if (depth === 0) { closeIdx = i; break; }
  }
  if (closeIdx === -1) { return []; }
  const inner = line.slice(parenIdx + 1, closeIdx).trim();
  if (inner.length === 0) { return []; }

  // Split on top-level commas only
  const args: string[] = [];
  let current = '';
  let d = 0;
  for (const ch of inner) {
    if (ch === '(' || ch === '<' || ch === '[' || ch === '{') d++;
    if (ch === ')' || ch === '>' || ch === ']' || ch === '}') d--;
    if (ch === ',' && d === 0) {
      args.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) args.push(current.trim());
  return args;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function deduplicateEdges(edges: FlowEdge[]): FlowEdge[] {
  const seen = new Set<string>();
  return edges.filter((e) => {
    const key = `${e.source}->${e.target}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

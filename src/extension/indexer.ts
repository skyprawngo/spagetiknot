/**
 * @module indexer
 * @description Orchestrates full and incremental indexing of a target directory.
 *
 * Responsibilities: parse functions, build call-graph edges, manage FileWatcher lifecycle.
 * Does NOT handle webview messages or extension lifecycle.
 *
 * ┌─────────────────────────┬────────────────────────────────────────────────────┐
 * │ Export                  │ Role                                               │
 * ├─────────────────────────┼────────────────────────────────────────────────────┤
 * │ runIndexing             │ Full re-index: parse → edge-build → notify webview │
 * │ buildDirItems           │ Build directory list for the dir-picker UI         │
 * │ SerializedFunction      │ Wire-format type for webview messages              │
 * │ SerializedEdge          │ Wire-format type for webview messages              │
 * └─────────────────────────┴────────────────────────────────────────────────────┘
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { parseWorkspaceFunctions, FunctionInfo } from './parser';
import { findReferences, FlowEdge } from './references';
import { FileWatcher } from './watcher';
import { log } from './logger';

// ── Wire types (no VS Code references, safe to serialize) ────────────────────

export interface SerializedFunction {
  name: string;
  filePath: string;
  line: number;
  params: string[];
  comment: string;
}

export interface SerializedEdge {
  source: string;
  target: string;
  args: string[];
  params: string[];
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run a full index of `targetDir`:
 *  1. Stops any existing watcher.
 *  2. Parses all functions and builds all edges.
 *  3. Posts `loadData` to the webview.
 *  4. Starts a new FileWatcher that posts `incrementalUpdate` on each file change.
 *
 * Returns the new watcher, or undefined if no functions were found.
 */
export async function runIndexing(
  panel: vscode.WebviewPanel,
  targetDir: string,
  currentWatcher: FileWatcher | undefined,
  savedLayout?: any,
): Promise<FileWatcher | undefined> {
  currentWatcher?.stop();
  log('runIndexing start:', targetDir);

  panel.webview.postMessage({ command: 'indexingStart' });

  const functions = await parseWorkspaceFunctions(targetDir);
  log('Functions found:', functions.length);

  if (functions.length === 0) {
    panel.webview.postMessage({ command: 'loadData', functions: [], edges: [], targetDir });
    vscode.window.showWarningMessage('SpagetiKnot: No functions found in ' + targetDir);
    return undefined;
  }

  const edges = await findReferences(functions);
  log('Edges found:', edges.length);

  panel.webview.postMessage({
    command: 'loadData',
    targetDir,
    functions: serializeFunctions(functions),
    edges: serializeEdges(edges),
    savedLayout: savedLayout ? {
      groups: savedLayout.groups,
      nodes: savedLayout.nodes,
      groupModes: savedLayout.groupModes,
      view: savedLayout.view,
      fileColors: savedLayout.fileColors,
    } : undefined,
  });

  const watcher = new FileWatcher(targetDir, functions, (updatedFns, updatedEdges, changedFiles) => {
    panel.webview.postMessage({
      command: 'incrementalUpdate',
      targetDir,
      functions: serializeFunctions(updatedFns),
      edges: serializeEdges(updatedEdges),
      changedFiles,
    });
  });
  watcher.start();
  return watcher;
}

/** Build the flat list of directories shown in the dir-picker. */
export async function buildDirItems(
  rootPath: string,
): Promise<{ label: string; dir: string }[]> {
  const subdirs = getSubdirectories(rootPath);
  return [
    { label: '$(folder) Entire workspace', dir: rootPath },
    ...subdirs.map(d => ({ label: '$(folder) ' + path.relative(rootPath, d), dir: d })),
  ];
}

// ── Serialization helpers ─────────────────────────────────────────────────────

function serializeFunctions(fns: FunctionInfo[]): SerializedFunction[] {
  return fns.map(fn => ({
    name: fn.name,
    filePath: fn.filePath,
    line: fn.line,
    params: fn.params,
    comment: fn.comment,
  }));
}

function serializeEdges(edges: FlowEdge[]): SerializedEdge[] {
  return edges.map(e => ({
    source: e.source,
    target: e.target,
    args: e.args,
    params: e.params,
  }));
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function getSubdirectories(rootPath: string): string[] {
  const entries = fs.readdirSync(rootPath, { withFileTypes: true });
  return entries
    .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
    .map(e => path.join(rootPath, e.name))
    .slice(0, 20);
}

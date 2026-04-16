import * as vscode from 'vscode';
import { parseFunctions, FunctionInfo } from './parser';
import { findReferences, FlowEdge, ExternalCall } from './references';

type OnUpdateCallback = (
  functions: FunctionInfo[],
  edges: FlowEdge[],
  externalCalls: ExternalCall[],
  changedFiles: string[],
) => void;

export class FileWatcher {
  private watcher: vscode.FileSystemWatcher | undefined;
  private targetDir: string;
  private functions: FunctionInfo[] = [];
  private onUpdate: OnUpdateCallback;
  private debounceTimer: NodeJS.Timeout | undefined;
  private pendingFiles = new Set<string>();

  constructor(targetDir: string, initialFunctions: FunctionInfo[], onUpdate: OnUpdateCallback) {
    this.targetDir = targetDir;
    this.functions = initialFunctions;
    this.onUpdate = onUpdate;
  }

  start(): void {
    const pattern = new vscode.RelativePattern(
      this.targetDir,
      '**/*.{ts,tsx,js,jsx,py,go,rs,java,cs,cpp,c,h,swift}'
    );

    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

    this.watcher.onDidChange((uri) => this.scheduleReindex(uri));
    this.watcher.onDidCreate((uri) => this.scheduleReindex(uri));
    this.watcher.onDidDelete((uri) => this.scheduleReindexDelete(uri));
  }

  stop(): void {
    this.watcher?.dispose();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
  }

  /** Replace the full function list (e.g. after a full re-index) */
  setFunctions(fns: FunctionInfo[]): void {
    this.functions = fns;
  }

  private scheduleReindex(uri: vscode.Uri): void {
    this.pendingFiles.add(uri.fsPath);
    this.debounce();
  }

  private scheduleReindexDelete(uri: vscode.Uri): void {
    // Remove functions from the deleted file
    const before = this.functions.length;
    this.functions = this.functions.filter(f => f.filePath !== uri.fsPath);
    if (this.functions.length !== before) {
      this.pendingFiles.add(uri.fsPath);
      this.debounce();
    }
  }

  private debounce(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.processChanges(), 800);
  }

  private async processChanges(): Promise<void> {
    const changedFiles = [...this.pendingFiles];
    this.pendingFiles.clear();

    for (const filePath of changedFiles) {
      // Remove old entries for this file
      this.functions = this.functions.filter(f => f.filePath !== filePath);

      // Re-parse if the file still exists
      try {
        const uri = vscode.Uri.file(filePath);
        const newFns = await parseFunctions(uri);
        this.functions.push(...newFns);
      } catch {
        // File was deleted or unreadable — already removed above
      }
    }

    // Rebuild all edges (edges depend on the full function set)
    const { edges, externalCalls } = await findReferences(this.functions);
    this.onUpdate(this.functions, edges, externalCalls, changedFiles);
  }
}

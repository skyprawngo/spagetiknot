import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

let logPath: string | undefined;
let channel: vscode.OutputChannel | undefined;

export function initLogger(): void {
  const ws = vscode.workspace.workspaceFolders;
  if (ws && ws.length > 0) {
    const dir = path.join(ws[0].uri.fsPath, '.spageti');
    fs.mkdirSync(dir, { recursive: true });
    logPath = path.join(dir, 'debug.log');
    // Clear previous log
    fs.writeFileSync(logPath, `[SpagetiKnot] Log started at ${new Date().toISOString()}\n`);
  }
  channel = vscode.window.createOutputChannel('SpagetiKnot');
}

export function log(...args: any[]): void {
  const msg = `[${new Date().toISOString()}] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`;
  console.log('[SpagetiKnot]', ...args);
  channel?.appendLine(msg);
  if (logPath) {
    try { fs.appendFileSync(logPath, msg + '\n'); } catch { /* ignore */ }
  }
}

export function logError(label: string, err: unknown): void {
  const msg = err instanceof Error ? err.message + '\n' + err.stack : String(err);
  log(`ERROR [${label}]`, msg);
}

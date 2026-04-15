/**
 * @module extension
 * @description VS Code extension entry point.
 *
 * Responsibilities: register the command, create/reveal the panel, wire up the
 * message handler and file watcher.  All indexing and message-handling logic
 * lives in dedicated modules.
 */
import * as vscode from 'vscode';
import { createFlowPanel } from './webviewPanel';
import { runIndexing, buildDirItems } from './indexer';
import { attachMessageHandler } from './messageHandler';
import { listSavedLayouts, loadLayout, saveLastSession, loadLastSession } from './storage';
import { FileWatcher } from './watcher';
import { initLogger, log } from './logger';

let activePanel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  initLogger();
  log('Extension activated');

  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right, 100,
  );
  statusBarItem.text    = '$(type-hierarchy) SpagetiKnot';
  statusBarItem.tooltip = 'SSDF: SpagetiKnot Show Flow Diagram';
  statusBarItem.command = 'spagetiknot.showFlowDiagram';
  statusBarItem.show();

  const disposable = vscode.commands.registerCommand(
    'spagetiknot.showFlowDiagram',
    () => openOrRevealPanel(context),
  );

  context.subscriptions.push(disposable, statusBarItem);
}

export function deactivate(): void {}

// ── Panel lifecycle ───────────────────────────────────────────────────────────

async function openOrRevealPanel(context: vscode.ExtensionContext): Promise<void> {
  // Single-instance: focus existing panel instead of opening a new one
  if (activePanel) {
    log('Panel already exists, revealing');
    activePanel.reveal(vscode.ViewColumn.Active);
    return;
  }

  log('Creating new panel');
  const panel = createFlowPanel(context);
  activePanel = panel;
  let panelWatcher: FileWatcher | undefined;

  panel.onDidDispose(() => {
    log('Panel disposed');
    activePanel  = undefined;
    panelWatcher?.stop();
    panelWatcher = undefined;
  }, null, context.subscriptions);

  // Send the saved-layout list so the picker shows them immediately
  panel.webview.postMessage({ command: 'savedLayouts', layouts: listSavedLayouts() });

  const ws = vscode.workspace.workspaceFolders;
  if (!ws || ws.length === 0) {
    panel.webview.postMessage({ command: 'loadData', functions: [], edges: [] });
    vscode.window.showWarningMessage('SpagetiKnot: No workspace folder open.');
    attachMessageHandler(panel, '', () => panelWatcher, w => { panelWatcher = w; }, context);
    return;
  }

  const rootPath = ws[0].uri.fsPath;

  // Attach message handler before any async work so no messages are missed
  attachMessageHandler(panel, rootPath, () => panelWatcher, w => { panelWatcher = w; }, context);

  // Auto-load the last session, skipping the dir picker
  const lastSession = loadLastSession();
  if (lastSession?.targetDir) {
    log('Auto-loading last session:', lastSession.targetDir);
    const savedLayout = lastSession.layoutName
      ? loadLayout(lastSession.layoutName)
      : undefined;
    panelWatcher = await runIndexing(panel, lastSession.targetDir, panelWatcher, savedLayout ?? undefined);
    return;
  }

  // No previous session → show dir picker
  const dirs = await buildDirItems(rootPath);
  panel.webview.postMessage({ command: 'showDirPicker', dirs });
}

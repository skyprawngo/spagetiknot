import * as vscode from 'vscode';
import * as path from 'path';
import { parseWorkspaceFunctions } from './parser';
import { findReferences } from './references';
import { createFlowPanel } from './webviewPanel';
import { saveLayout, loadLayout, listSavedLayouts, deleteLayout } from './storage';
import { FileWatcher } from './watcher';
import { initLogger, log, logError } from './logger';

let activePanel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext) {
  initLogger();
  log('Extension activated');
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.text = '$(type-hierarchy) SpagetiKnot';
  statusBarItem.tooltip = 'SSDF: SpagetiKnot Show Flow Diagram';
  statusBarItem.command = 'spagetiknot.showFlowDiagram';
  statusBarItem.show();

  const disposable = vscode.commands.registerCommand(
    'spagetiknot.showFlowDiagram',
    async () => {
      try {
        // If a panel already exists, just reveal it
        if (activePanel) {
          log('Panel already exists, revealing');
          activePanel.reveal(vscode.ViewColumn.Active);
          return;
        }

        log('Creating new panel');
        const panel = createFlowPanel(context);
        activePanel = panel;

        panel.onDidDispose(() => {
          log('Panel disposed');
          activePanel = undefined;
          activeWatcher?.stop();
          activeWatcher = undefined;
        }, null, context.subscriptions);

        // Send list of saved layouts
        const layouts = listSavedLayouts();
        log('Saved layouts found:', layouts.length);
        panel.webview.postMessage({ command: 'savedLayouts', layouts });

        // Build folder quick-pick items
        const ws = vscode.workspace.workspaceFolders;
        if (!ws || ws.length === 0) {
          log('No workspace folder open');
          panel.webview.postMessage({ command: 'loadData', functions: [], edges: [] });
          vscode.window.showWarningMessage('SpagetiKnot: No workspace folder open.');
          return;
        }

        const rootPath = ws[0].uri.fsPath;
        log('Workspace root:', rootPath);
        const dirs = await getSubdirectories(rootPath);
        log('Subdirectories found:', dirs.length);
        const items: { label: string; dir: string }[] = [
          { label: '$(folder) Entire workspace', dir: rootPath },
          ...dirs.map(d => ({
            label: '$(folder) ' + path.relative(rootPath, d),
            dir: d,
          })),
        ];

        panel.webview.postMessage({
          command: 'showDirPicker',
          dirs: items.map(i => ({ label: i.label, dir: i.dir })),
        });

        // Handle messages from webview
        panel.webview.onDidReceiveMessage(
          async (msg) => {
            try {
              log('Message from webview:', msg.command);

              if (msg.command === 'openFile') {
                const uri = vscode.Uri.file(msg.filePath);
                vscode.window.showTextDocument(uri, {
                  selection: new vscode.Range(msg.line, 0, msg.line, 0),
                });
              }

              if (msg.command === 'selectDir') {
                log('Indexing directory:', msg.dir);
                await runIndexing(panel, msg.dir);
              }

              if (msg.command === 'saveLayout') {
                saveLayout({
                  name: msg.name,
                  targetDir: msg.targetDir,
                  savedAt: new Date().toISOString(),
                  groups: msg.groups,
                  nodes: msg.nodes,
                  groupModes: msg.groupModes,
                  view: msg.view,
                });
                panel.webview.postMessage({
                  command: 'savedLayouts',
                  layouts: listSavedLayouts(),
                });
              }

              if (msg.command === 'loadLayout') {
                const layout = loadLayout(msg.name);
                if (layout) {
                  log('Loading layout:', msg.name, 'targetDir:', layout.targetDir);
                  await runIndexing(panel, layout.targetDir, layout);
                }
              }

              if (msg.command === 'deleteLayout') {
                deleteLayout(msg.name);
                panel.webview.postMessage({
                  command: 'savedLayouts',
                  layouts: listSavedLayouts(),
                });
              }
            } catch (err) {
              logError('onDidReceiveMessage', err);
            }
          },
          undefined,
          context.subscriptions
        );
      } catch (err) {
        logError('showFlowDiagram', err);
      }
    }
  );

  context.subscriptions.push(disposable, statusBarItem);
}

let activeWatcher: FileWatcher | undefined;

async function runIndexing(
  panel: vscode.WebviewPanel,
  targetDir: string,
  savedLayout?: any
): Promise<void> {
  activeWatcher?.stop();
  log('runIndexing start:', targetDir);

  panel.webview.postMessage({ command: 'indexingStart' });

  const functions = await parseWorkspaceFunctions(targetDir);
  log('Functions found:', functions.length);

  if (functions.length === 0) {
    panel.webview.postMessage({ command: 'loadData', functions: [], edges: [], targetDir });
    vscode.window.showWarningMessage('SpagetiKnot: No functions found in ' + targetDir);
    return;
  }

  const edges = await findReferences(functions);
  log('Edges found:', edges.length);

  const serializeFunctions = (fns: typeof functions) => fns.map((fn) => ({
    name: fn.name, filePath: fn.filePath, line: fn.line, params: fn.params,
  }));
  const serializeEdges = (eds: typeof edges) => eds.map((e) => ({
    source: e.source, target: e.target, args: e.args, params: e.params,
  }));

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
    } : undefined,
  });

  // Start file watcher for incremental re-indexing
  activeWatcher = new FileWatcher(targetDir, functions, (updatedFns, updatedEdges, changedFiles) => {
    panel.webview.postMessage({
      command: 'incrementalUpdate',
      targetDir,
      functions: serializeFunctions(updatedFns),
      edges: serializeEdges(updatedEdges),
      changedFiles,
    });
  });
  activeWatcher.start();

}

async function getSubdirectories(rootPath: string): Promise<string[]> {
  const fs = await import('fs');
  const entries = fs.readdirSync(rootPath, { withFileTypes: true });
  return entries
    .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
    .map(e => path.join(rootPath, e.name))
    .slice(0, 20);
}

export function deactivate() {}

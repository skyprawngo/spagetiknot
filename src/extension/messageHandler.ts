/**
 * @module messageHandler
 * @description Routes webview → extension messages to dedicated command handlers.
 *
 * Each `case` handles exactly one command with no cross-concern logic.
 * Does NOT manage watcher lifecycle directly — delegates to the indexer.
 *
 * ┌───────────────────────┬──────────────────────────────────────────────────────┐
 * │ Export                │ Role                                                 │
 * ├───────────────────────┼──────────────────────────────────────────────────────┤
 * │ attachMessageHandler  │ Registers the webview message listener on a panel    │
 * └───────────────────────┴──────────────────────────────────────────────────────┘
 */
import * as vscode from 'vscode';
import { runIndexing, buildDirItems } from './indexer';
import { FileWatcher } from './watcher';
import {
  saveLayout, loadLayout, listSavedLayouts, deleteLayout, saveLastSession,
} from './storage';
import { log, logError } from './logger';

/** Attach the webview message listener to `panel`. */
export function attachMessageHandler(
  panel: vscode.WebviewPanel,
  rootPath: string,
  getWatcher: () => FileWatcher | undefined,
  setWatcher: (w: FileWatcher | undefined) => void,
  context: vscode.ExtensionContext,
): void {
  panel.webview.onDidReceiveMessage(
    async (msg) => {
      try {
        log('Message from webview:', msg.command);
        await dispatch(msg, panel, rootPath, getWatcher, setWatcher);
      } catch (err) {
        logError('messageHandler', err);
      }
    },
    undefined,
    context.subscriptions,
  );
}

// ── Command dispatch ──────────────────────────────────────────────────────────

async function dispatch(
  msg: any,
  panel: vscode.WebviewPanel,
  rootPath: string,
  getWatcher: () => FileWatcher | undefined,
  setWatcher: (w: FileWatcher | undefined) => void,
): Promise<void> {
  switch (msg.command) {

    case 'openFile':
      await vscode.window.showTextDocument(vscode.Uri.file(msg.filePath), {
        selection: new vscode.Range(msg.line, 0, msg.line, 0),
      });
      break;

    case 'copyToClipboard':
      await vscode.env.clipboard.writeText(msg.text);
      vscode.window.setStatusBarMessage(`복사됨: ${msg.text}`, 2500);
      break;

    case 'requestDirPicker': {
      getWatcher()?.stop();
      setWatcher(undefined);
      const dirs = await buildDirItems(rootPath);
      panel.webview.postMessage({ command: 'showDirPicker', dirs });
      break;
    }

    case 'selectDir': {
      log('Indexing directory:', msg.dir);
      const w = await runIndexing(panel, msg.dir, getWatcher());
      setWatcher(w);
      saveLastSession(msg.dir);
      break;
    }

    case 'saveLayout':
      saveLayout({
        name: msg.name,
        targetDir: msg.targetDir,
        savedAt: new Date().toISOString(),
        groups: msg.groups,
        nodes: msg.nodes,
        groupModes: msg.groupModes,
        view: msg.view,
        fileColors: msg.fileColors,
      });
      panel.webview.postMessage({ command: 'savedLayouts', layouts: listSavedLayouts() });
      break;

    case 'loadLayout': {
      const layout = loadLayout(msg.name);
      if (layout) {
        log('Loading layout:', msg.name, 'targetDir:', layout.targetDir);
        const w = await runIndexing(panel, layout.targetDir, getWatcher(), layout);
        setWatcher(w);
        saveLastSession(layout.targetDir, msg.name);
      } else {
        log('Layout not found or corrupted:', msg.name);
        vscode.window.showErrorMessage(
          `SpagetiKnot: Layout "${msg.name}" could not be loaded.`,
        );
        panel.webview.postMessage({ command: 'savedLayouts', layouts: listSavedLayouts() });
      }
      break;
    }

    case 'deleteLayout':
      deleteLayout(msg.name);
      panel.webview.postMessage({ command: 'savedLayouts', layouts: listSavedLayouts() });
      break;

    case 'renameLayout': {
      const layout = loadLayout(msg.oldName);
      if (layout) {
        layout.name = msg.newName;
        saveLayout(layout);
        deleteLayout(msg.oldName);
        panel.webview.postMessage({ command: 'savedLayouts', layouts: listSavedLayouts() });
      }
      break;
    }
  }
}

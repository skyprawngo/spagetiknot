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
  saveLayout, loadLayout, listSavedLayouts, deleteLayout,
  saveLastSession, saveLastDirLayout, loadLastDirLayout,
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
      const dirEntry = loadLastDirLayout(msg.dir);
      let savedLayout: any = undefined;
      let autoLayoutType: string | undefined = undefined;
      if (dirEntry?.layoutName) {
        savedLayout = loadLayout(dirEntry.layoutName);
      } else if (dirEntry?.layoutType) {
        autoLayoutType = dirEntry.layoutType;
      }
      const w = await runIndexing(panel, msg.dir, getWatcher(), savedLayout, autoLayoutType);
      setWatcher(w);
      saveLastSession(msg.dir);
      break;
    }

    case 'setLastLayout': {
      const { layoutType, layoutName } = msg;
      if (msg.targetDir) {
        saveLastDirLayout(msg.targetDir, layoutName ? { layoutName } : { layoutType });
      }
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
        saveLastSession(layout.targetDir);
        saveLastDirLayout(layout.targetDir, { layoutName: msg.name });
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

    case 'getHoverInfo': {
      const { requestId, callerNodeId, name, realName } = msg;
      // callerNodeId format: "filePath:line:functionName"
      // Split from the right to handle Windows paths with drive letters
      const lastColon2 = callerNodeId.lastIndexOf(':');
      const lastColon1 = callerNodeId.lastIndexOf(':', lastColon2 - 1);
      const filePath = callerNodeId.slice(0, lastColon1);
      const startLine = parseInt(callerNodeId.slice(lastColon1 + 1, lastColon2), 10);

      try {
        const uri = vscode.Uri.file(filePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        const searchName = (realName || name) + '(';

        let foundLine = -1;
        let foundChar = -1;
        const limit = Math.min(startLine + 300, doc.lineCount);
        for (let i = startLine; i < limit; i++) {
          const lineText = doc.lineAt(i).text;
          const idx = lineText.indexOf(searchName);
          if (idx !== -1) {
            foundLine = i;
            foundChar = idx + Math.floor(searchName.length / 2);
            break;
          }
        }

        if (foundLine === -1) {
          panel.webview.postMessage({ command: 'hoverResult', requestId, content: '' });
          break;
        }

        const position = new vscode.Position(foundLine, foundChar);
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
          'vscode.executeHoverProvider', uri, position,
        );

        const content = (hovers || [])
          .flatMap(h => h.contents)
          .map(c => {
            if (typeof c === 'string') return c;
            return (c as vscode.MarkdownString).value || '';
          })
          .filter(Boolean)
          .join('\n\n');

        panel.webview.postMessage({ command: 'hoverResult', requestId, content });
      } catch (err) {
        logError('getHoverInfo', err);
        panel.webview.postMessage({ command: 'hoverResult', requestId, content: '' });
      }
      break;
    }
  }
}

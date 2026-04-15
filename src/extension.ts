import * as vscode from 'vscode';
import { parseWorkspaceFunctions } from './parser';
import { findReferences } from './references';
import { createFlowPanel } from './webview';

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand(
    'spagetiknot.showFlowDiagram',
    async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'SpagetiKnot: Analyzing code flow...',
          cancellable: false,
        },
        async () => {
          const functions = await parseWorkspaceFunctions();

          if (functions.length === 0) {
            vscode.window.showWarningMessage(
              'SpagetiKnot: No functions found in the workspace.'
            );
            return;
          }

          const edges = await findReferences(functions);
          createFlowPanel(context, functions, edges);
        }
      );
    }
  );

  context.subscriptions.push(disposable);
}

export function deactivate() {}

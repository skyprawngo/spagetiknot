import * as vscode from 'vscode';
import * as path from 'path';

export function createFlowPanel(
  context: vscode.ExtensionContext
): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    'spagetiknot.flowDiagram',
    'SpagetiKnot Flow',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(context.extensionPath, 'out')),
      ],
    }
  );

  const scriptUri = panel.webview.asWebviewUri(
    vscode.Uri.file(path.join(context.extensionPath, 'out', 'webview', 'main.js'))
  );
  const styleUri = panel.webview.asWebviewUri(
    vscode.Uri.file(path.join(context.extensionPath, 'out', 'webview', 'styles.css'))
  );

  panel.webview.html = getHtml(panel.webview, scriptUri, styleUri);

  return panel;
}

function getHtml(
  webview: vscode.Webview,
  scriptUri: vscode.Uri,
  styleUri: vscode.Uri
): string {
  return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource};" />
<title>SpagetiKnot Flow</title>
<link rel="stylesheet" href="${styleUri}" />
</head>
<body>
<div id="toolbar">
  <span>SpagetiKnot</span>
  <button id="btn-back-to-picker" style="display:none">&#8592; Dir</button>
  <input id="search" type="text" placeholder="Search functions..." />
  <button id="btn-dashboard">Dashboard</button>
  <span class="info" id="stats"></span>
</div>
<canvas id="canvas" style="display:none"></canvas>

<!-- Directory picker (shown first) -->
<div id="dir-picker">
  <div class="picker-title">Select directory to index</div>
  <div id="dir-list"></div>
  <div class="picker-divider"></div>
  <div class="picker-title" style="margin-top:12px">Saved layouts</div>
  <div id="saved-layout-list"></div>
</div>

<div id="loading" style="display:none">Indexing...</div>

<div id="dashboard">
  <div id="dash-header">
    Dashboard
    <span class="close-btn" id="dash-close">&times;</span>
  </div>
  <div id="dash-body">
    <div class="section">
      <div class="section-title">File Group Layout</div>
      <button id="btn-single">Single column</button>
      <button id="btn-horizontal">Horizontal row</button>
      <button id="btn-compact">Compact</button>
      <button id="btn-stacker">Stacker 2-row</button>
      <button id="btn-stacker3">Stacker 3-row</button>
      <button id="btn-stacker4">Stacker 4-row</button>
      <button id="btn-custom" disabled style="opacity:0.4">Custom (no save yet)</button>
    </div>
    <div class="section">
      <div id="dash-saved-layouts"></div>
      <button id="btn-save-layout">+ Save</button>
    </div>
    <div class="section">
      <div class="section-title">View</div>
      <button id="btn-fit">Fit to screen</button>
      <button id="btn-reset">Reset zoom</button>
      <button id="btn-artwork">Artwork Lines: OFF</button>
    </div>
    <div class="section">
      <div class="section-title">Files</div>
      <ul class="file-list" id="file-list"></ul>
    </div>
  </div>
</div>

<div id="edge-info"></div>

<!-- Node context popovers are created dynamically by nodeContext.ts -->

<script src="${scriptUri}"></script>
</body>
</html>`;
}

import { state } from './state';

// @ts-ignore — acquireVsCodeApi is injected by VSCode webview
const vscode = acquireVsCodeApi();

export function postMessage(msg: any): void {
  vscode.postMessage(msg);
}

export function requestSaveLayout(name: string): void {
  postMessage({
    command: 'saveLayout',
    name,
    targetDir: state.targetDir,
    groups: state.fileGroups.map(g => ({ fileName: g.fileName, x: g.x, y: g.y, w: g.w, h: g.h })),
    nodes: state.nodes.map(n => ({ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h })),
    groupModes: Object.fromEntries(state.groupLayoutModes),
    view: { offsetX: state.offsetX, offsetY: state.offsetY, scale: state.scale },
  });
}

import { state, NODE_W, NODE_H, GraphNode, GraphEdge } from './state';
import { initCanvas, resizeCanvas, draw } from './canvas';
import { applyGlobalLayout, layoutNodesInGroup } from './layout';
import { setupCanvasEvents } from './interaction';
import { setupDashboard, updateFileList } from './dashboard';

import { postMessage } from './messaging';

function init(): void {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  initCanvas(canvas);
  setupCanvasEvents(canvas);
  setupDashboard();
}

// Receive messages from extension host
window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data;

  if (msg.command === 'showDirPicker') {
    renderDirPicker(msg.dirs);
  }

  if (msg.command === 'savedLayouts') {
    renderSavedLayouts(msg.layouts);
    renderDashSavedLayouts(msg.layouts);
  }

  if (msg.command === 'indexingStart') {
    document.getElementById('dir-picker')!.style.display = 'none';
    document.getElementById('loading')!.style.display = 'block';
    (document.getElementById('canvas') as HTMLElement).style.display = 'none';
  }

  if (msg.command === 'loadData') {
    document.getElementById('loading')!.style.display = 'none';
    document.getElementById('dir-picker')!.style.display = 'none';
    (document.getElementById('canvas') as HTMLElement).style.display = 'block';

    state.targetDir = msg.targetDir || '';

    state.nodes = (msg.functions || []).map((fn: any) => ({
      id: fn.filePath + ':' + fn.line + ':' + fn.name,
      label: fn.name,
      file: fn.filePath,
      fileName: fn.filePath.replace(/^.*[\\/]/, ''),
      line: fn.line,
      params: fn.params || [],
      x: 0, y: 0, w: NODE_W, h: NODE_H,
    }));

    state.edges = (msg.edges || []).map((e: any) => ({
      source: e.source,
      target: e.target,
      args: e.args || [],
      params: e.params || [],
    }));

    // Auto-assign layout mode: 2-column for groups with 8+ functions
    const countByFile = new Map<string, number>();
    for (const n of state.nodes) {
      countByFile.set(n.fileName, (countByFile.get(n.fileName) || 0) + 1);
    }
    for (const [fileName, count] of countByFile) {
      if (!state.groupLayoutModes.has(fileName)) {
        state.groupLayoutModes.set(fileName, count >= 8 ? 'grid2' : 'single');
      }
    }

    applyGlobalLayout(2);

    // Restore saved layout positions if provided
    if (msg.savedLayout) {
      applySavedLayout(msg.savedLayout);
    }

    updateFileList();
    resizeCanvas();
    draw();
  }

  if (msg.command === 'incrementalUpdate') {
    // Preserve existing positions for unchanged nodes
    const oldPositions = new Map<string, { x: number; y: number; w: number; h: number }>();
    for (const n of state.nodes) oldPositions.set(n.id, { x: n.x, y: n.y, w: n.w, h: n.h });
    const oldGroupPos = new Map<string, { x: number; y: number; w: number; h: number }>();
    for (const g of state.fileGroups) oldGroupPos.set(g.fileName, { x: g.x, y: g.y, w: g.w, h: g.h });

    // Rebuild nodes
    state.nodes = (msg.functions || []).map((fn: any): GraphNode => ({
      id: fn.filePath + ':' + fn.line + ':' + fn.name,
      label: fn.name,
      file: fn.filePath,
      fileName: fn.filePath.replace(/^.*[\\/]/, ''),
      line: fn.line,
      params: fn.params || [],
      x: 0, y: 0, w: NODE_W, h: NODE_H,
    }));
    state.edges = (msg.edges || []).map((e: any): GraphEdge => ({
      source: e.source, target: e.target,
      args: e.args || [], params: e.params || [],
    }));

    // Restore positions for nodes that still exist
    for (const n of state.nodes) {
      const old = oldPositions.get(n.id);
      if (old) { n.x = old.x; n.y = old.y; n.w = old.w; n.h = old.h; }
    }

    // Ensure groups exist for all files, preserve positions
    const fileNames = new Set(state.nodes.map(n => n.fileName));
    // Remove groups for deleted files
    state.fileGroups = state.fileGroups.filter(g => fileNames.has(g.fileName));
    // Add groups for new files
    for (const fn of fileNames) {
      if (!state.fileGroups.find(g => g.fileName === fn)) {
        state.fileGroups.push({ fileName: fn, x: 60, y: 60, w: 0, h: 0 });
      }
      if (!state.groupLayoutModes.has(fn)) {
        const fnCount = state.nodes.filter(n => n.fileName === fn).length;
        state.groupLayoutModes.set(fn, fnCount >= 8 ? 'grid2' : 'single');
      }
    }
    // Re-layout new nodes inside their groups
    for (const g of state.fileGroups) {
      const old = oldGroupPos.get(g.fileName);
      if (old) { g.x = old.x; g.y = old.y; g.w = old.w; g.h = old.h; }
      layoutNodesInGroup(g);
    }

    updateFileList();
    draw();
  }
});

function applySavedLayout(layout: any): void {
  if (layout.groupModes) {
    for (const [k, v] of Object.entries(layout.groupModes)) {
      state.groupLayoutModes.set(k, v as string);
    }
  }
  if (layout.groups) {
    const gMap = new Map(layout.groups.map((g: any) => [g.fileName, g]));
    for (const g of state.fileGroups) {
      const saved = gMap.get(g.fileName) as any;
      if (saved) { g.x = saved.x; g.y = saved.y; g.w = saved.w; g.h = saved.h; }
    }
  }
  if (layout.nodes) {
    const nMap = new Map(layout.nodes.map((n: any) => [n.id, n]));
    for (const n of state.nodes) {
      const saved = nMap.get(n.id) as any;
      if (saved) { n.x = saved.x; n.y = saved.y; n.w = saved.w; n.h = saved.h; }
    }
  }
  if (layout.view) {
    state.offsetX = layout.view.offsetX || 0;
    state.offsetY = layout.view.offsetY || 0;
    state.scale = layout.view.scale || 1;
  }
}

function renderDirPicker(dirs: { label: string; dir: string }[]): void {
  const listEl = document.getElementById('dir-list')!;
  listEl.innerHTML = '';
  for (const d of dirs) {
    const item = document.createElement('div');
    item.className = 'dir-item';
    item.textContent = d.label;
    item.addEventListener('click', () => {
      postMessage({ command: 'selectDir', dir: d.dir });
    });
    listEl.appendChild(item);
  }
}

function renderSavedLayouts(layouts: { name: string; targetDir: string; savedAt: string }[]): void {
  const listEl = document.getElementById('saved-layout-list')!;
  listEl.innerHTML = '';
  if (layouts.length === 0) {
    listEl.innerHTML = '<div style="opacity:0.4;font-size:11px;padding:4px">No saved layouts</div>';
    return;
  }
  for (const l of layouts) {
    const item = document.createElement('div');
    item.className = 'layout-item';

    const label = document.createElement('span');
    label.textContent = l.name;
    item.appendChild(label);

    const meta = document.createElement('span');
    meta.className = 'layout-meta';
    meta.textContent = new Date(l.savedAt).toLocaleDateString();
    item.appendChild(meta);

    const del = document.createElement('span');
    del.className = 'delete-btn';
    del.textContent = '\u00d7';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      postMessage({ command: 'deleteLayout', name: l.name });
    });
    item.appendChild(del);

    item.addEventListener('click', () => {
      postMessage({ command: 'loadLayout', name: l.name });
    });
    listEl.appendChild(item);
  }
}

function renderDashSavedLayouts(layouts: { name: string; targetDir: string; savedAt: string }[]): void {
  const el = document.getElementById('dash-saved-layouts');
  if (!el) return;
  el.innerHTML = '';
  for (const l of layouts) {
    const item = document.createElement('div');
    item.className = 'dash-layout-item';
    item.textContent = l.name;

    const del = document.createElement('span');
    del.className = 'del';
    del.textContent = '\u00d7';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      postMessage({ command: 'deleteLayout', name: l.name });
    });
    item.appendChild(del);

    item.addEventListener('click', () => {
      postMessage({ command: 'loadLayout', name: l.name });
    });
    el.appendChild(item);
  }
}

// Boot
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

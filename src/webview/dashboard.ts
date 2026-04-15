import { state, GraphNode } from './state';
import { draw } from './canvas';
import { applyGlobalLayout, applyStackerLayout, fitToScreen, restoreCustomSnapshot, layoutNodesInGroup } from './layout';
import { colorForFile } from './colors';
import { requestSaveLayout } from './messaging';

export function showEdgeInfo(ei: number, screenX: number, screenY: number): void {
  const e = state.edges[ei];
  if (!e) return;
  const nodeMap = new Map<string, GraphNode>();
  state.nodes.forEach(n => nodeMap.set(n.id, n));
  const srcNode = nodeMap.get(e.source);
  const tgtNode = nodeMap.get(e.target);
  if (!srcNode || !tgtNode) return;

  const el = document.getElementById('edge-info')!;
  let html = '<div class="title">' + escHtml(srcNode.label) + ' \u2192 ' + escHtml(tgtNode.label) + '</div>';

  const maxLen = Math.max(e.args.length, e.params.length);
  if (maxLen > 0) {
    for (let i = 0; i < maxLen; i++) {
      const arg = e.args[i] || '\u2014';
      const param = e.params[i] || '\u2014';
      html += '<div class="row"><span class="arg">' + escHtml(arg) + '</span><span class="arrow">\u2192</span><span class="param">' + escHtml(param) + '</span></div>';
    }
  } else {
    html += '<div class="row" style="opacity:0.5">No parameters detected</div>';
  }

  el.innerHTML = html;
  el.style.display = 'block';
  let left = screenX + 12;
  let top = screenY + 12;
  if (left + 280 > window.innerWidth) left = screenX - 240;
  if (top + 150 > window.innerHeight) top = screenY - 120;
  el.style.left = left + 'px';
  el.style.top = top + 'px';
}

export function hideEdgeInfo(): void {
  document.getElementById('edge-info')!.style.display = 'none';
  state.selectedEdgeIdx = -1;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function setupDashboard(): void {
  const dashEl = document.getElementById('dashboard')!;
  const dashHeader = document.getElementById('dash-header')!;
  let dragging = false, dx = 0, dy = 0;

  document.getElementById('btn-dashboard')!.addEventListener('click', () => {
    dashEl.classList.toggle('hidden');
  });
  document.getElementById('dash-close')!.addEventListener('click', () => {
    dashEl.classList.add('hidden');
  });

  dashHeader.addEventListener('mousedown', (e: MouseEvent) => {
    dragging = true;
    const rect = dashEl.getBoundingClientRect();
    dx = e.clientX - rect.left;
    dy = e.clientY - rect.top;
    dashHeader.style.cursor = 'grabbing';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e: MouseEvent) => {
    if (!dragging) return;
    dashEl.style.left = (e.clientX - dx) + 'px';
    dashEl.style.top = (e.clientY - dy) + 'px';
    dashEl.style.right = 'auto';
  });

  document.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; dashHeader.style.cursor = 'grab'; }
  });

  // Layout buttons
  document.getElementById('btn-single')!.addEventListener('click', () => { applyGlobalLayout(1); draw(); });
  document.getElementById('btn-horizontal')!.addEventListener('click', () => { applyGlobalLayout(0); draw(); });
  document.getElementById('btn-compact')!.addEventListener('click', () => { applyGlobalLayout(-1); draw(); });
  document.getElementById('btn-stacker')!.addEventListener('click', () => { applyStackerLayout(); draw(); });
  document.getElementById('btn-custom')!.addEventListener('click', () => { restoreCustomSnapshot(); draw(); });
  document.getElementById('btn-fit')!.addEventListener('click', () => { fitToScreen(); draw(); });
  document.getElementById('btn-reset')!.addEventListener('click', () => {
    state.scale = 1; state.offsetX = 0; state.offsetY = 0; draw();
  });

  // Artwork line toggle — re-layouts groups to add/remove trace spacing
  const artworkBtn = document.getElementById('btn-artwork')!;
  artworkBtn.addEventListener('click', () => {
    state.artworkLineMode = !state.artworkLineMode;
    artworkBtn.textContent = 'Artwork Lines: ' + (state.artworkLineMode ? 'ON' : 'OFF');
    // Re-layout all groups with updated spacing
    for (const g of state.fileGroups) {
      layoutNodesInGroup(g);
    }
    draw();
  });

  // Save layout button
  document.getElementById('btn-save-layout')!.addEventListener('click', () => {
    const input = document.getElementById('layout-name-input') as HTMLInputElement;
    const name = input.value.trim();
    if (!name) return;
    requestSaveLayout(name);
    input.value = '';
  });
}

export function updateFileList(): void {
  const listEl = document.getElementById('file-list')!;
  listEl.innerHTML = '';
  const seen = new Set<string>();
  for (const n of state.nodes) {
    if (seen.has(n.fileName)) continue;
    seen.add(n.fileName);
    const count = state.nodes.filter(x => x.fileName === n.fileName).length;
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = colorForFile(n.fileName);
    li.appendChild(dot);
    li.appendChild(document.createTextNode(n.fileName + ' (' + count + ')'));
    listEl.appendChild(li);
  }
}

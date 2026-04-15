import { state, NODE_W, NODE_H, GROUP_PAD, GROUP_HEADER, NODE_GAP } from './state';
import { draw, resizeCanvas } from './canvas';
import {
  layoutNodesInGroup, resolveGroupOverlaps, expandGroupToFitNode,
  saveCustomSnapshot,
} from './layout';
import {
  hitTestNode, hitTestGroupHeader, hitTestGroupBtn,
  hitTestGroupResize, hitTestEdge, getResizeCursor, screenToWorld,
} from './hitTest';
import { showEdgeInfo, hideEdgeInfo } from './dashboard';
import { postMessage } from './messaging';

function isInMultiSelection(wx: number, wy: number): boolean {
  const hit = hitTestNode(wx, wy);
  if (hit && state.selectedNodes.has(hit.id)) return true;
  const gh = hitTestGroupHeader(wx, wy);
  if (gh && state.selectedGroupNames.has(gh.fileName)) return true;
  return false;
}

function clearMultiSelection(): void {
  state.selectedNodes.clear();
  state.selectedGroupNames.clear();
}

function computeRectSelection(): void {
  const rx = Math.min(state.rectStartWx, state.rectCurWx);
  const ry = Math.min(state.rectStartWy, state.rectCurWy);
  const rw = Math.abs(state.rectCurWx - state.rectStartWx);
  const rh = Math.abs(state.rectCurWy - state.rectStartWy);

  // AutoCAD-style:
  //   Left-to-right (crossing): select anything that intersects the rect
  //   Right-to-left (window):   select only items fully inside the rect
  const isWindowMode = state.rectCurWx < state.rectStartWx;

  state.selectedNodes.clear();
  state.selectedGroupNames.clear();

  for (const n of state.nodes) {
    const hit = isWindowMode
      ? (n.x >= rx && n.y >= ry && n.x + n.w <= rx + rw && n.y + n.h <= ry + rh)  // fully inside
      : (n.x + n.w > rx && n.x < rx + rw && n.y + n.h > ry && n.y < ry + rh);     // intersects
    if (hit) state.selectedNodes.add(n.id);
  }

  for (const g of state.fileGroups) {
    const hit = isWindowMode
      ? (g.x >= rx && g.y >= ry && g.x + g.w <= rx + rw && g.y + g.h <= ry + rh)
      : (g.x + g.w > rx && g.x < rx + rw && g.y + g.h > ry && g.y < ry + rh);
    if (hit) {
      state.selectedGroupNames.add(g.fileName);
      // Also select all nodes in that group
      for (const n of state.nodes) {
        if (n.fileName === g.fileName) state.selectedNodes.add(n.id);
      }
    }
  }
}

export function setupCanvasEvents(canvas: HTMLCanvasElement): void {
  canvas.addEventListener('mousedown', (e) => {
    const w = screenToWorld(e.offsetX, e.offsetY);

    // Middle click: pan
    if (e.button === 1) {
      e.preventDefault();
      state.panning = true;
      state.panStartX = e.offsetX - state.offsetX;
      state.panStartY = e.offsetY - state.offsetY;
      canvas.style.cursor = 'grabbing';
      return;
    }

    if (e.button !== 0) return;

    // Group layout button
    const btnG = hitTestGroupBtn(w.x, w.y);
    if (btnG) {
      const cur = state.groupLayoutModes.get(btnG.fileName) || 'single';
      const next = cur === 'single' ? 'grid2' : cur === 'grid2' ? 'grid3' : 'single';
      state.groupLayoutModes.set(btnG.fileName, next);
      layoutNodesInGroup(btnG);
      resolveGroupOverlaps(btnG);
      draw();
      return;
    }

    // Group resize
    const rh = hitTestGroupResize(w.x, w.y);
    if (rh) {
      state.resizingGroup = rh.group;
      state.resizeEdge = rh.edge;
      state.resizeStartX = w.x;
      state.resizeStartY = w.y;
      state.resizeOrigW = rh.group.w;
      state.resizeOrigH = rh.group.h;
      return;
    }

    // Batch drag (multi-selected)
    if ((state.selectedNodes.size > 0 || state.selectedGroupNames.size > 0) && isInMultiSelection(w.x, w.y)) {
      state.batchDragging = true;
      state.batchDragStartWx = w.x;
      state.batchDragStartWy = w.y;
      return;
    }

    // Group header drag
    const gh = hitTestGroupHeader(w.x, w.y);
    if (gh && !hitTestNode(w.x, w.y)) {
      clearMultiSelection();
      state.draggingGroup = gh;
      state.dragGroupDx = w.x - gh.x;
      state.dragGroupDy = w.y - gh.y;
      return;
    }

    // Node click/drag
    const hit = hitTestNode(w.x, w.y);
    if (hit) {
      clearMultiSelection();
      hideEdgeInfo();
      state.selectedNode = (state.selectedNode === hit) ? null : hit;
      state.selectedEdgeIdx = -1;
      state.dragNode = hit;
      hit._dx = w.x - hit.x;
      hit._dy = w.y - hit.y;
      hit._moved = false;
      draw();
      return;
    }

    // Edge click
    const ei = hitTestEdge(w.x, w.y);
    if (ei >= 0) {
      clearMultiSelection();
      state.selectedNode = null;
      state.selectedEdgeIdx = ei;
      showEdgeInfo(ei, e.clientX, e.clientY);
      draw();
      return;
    }

    // Empty space → rectangle selection
    state.selectedNode = null;
    state.selectedEdgeIdx = -1;
    hideEdgeInfo();
    clearMultiSelection();
    state.rectSelecting = true;
    state.rectStartWx = w.x;
    state.rectStartWy = w.y;
    state.rectCurWx = w.x;
    state.rectCurWy = w.y;
    draw();
  });

  canvas.addEventListener('mousemove', (e) => {
    const w = screenToWorld(e.offsetX, e.offsetY);

    if (state.panning) {
      state.offsetX = e.offsetX - state.panStartX;
      state.offsetY = e.offsetY - state.panStartY;
      draw(); return;
    }

    if (state.rectSelecting) {
      state.rectCurWx = w.x;
      state.rectCurWy = w.y;
      computeRectSelection();
      draw(); return;
    }

    if (state.batchDragging) {
      const dx = w.x - state.batchDragStartWx;
      const dy = w.y - state.batchDragStartWy;
      state.batchDragStartWx = w.x;
      state.batchDragStartWy = w.y;
      // Move selected groups (and their nodes together)
      for (const g of state.fileGroups) {
        if (state.selectedGroupNames.has(g.fileName)) { g.x += dx; g.y += dy; }
      }
      for (const n of state.nodes) {
        if (state.selectedNodes.has(n.id)) {
          // Skip nodes whose group is also selected (already moved with group)
          if (!state.selectedGroupNames.has(n.fileName)) {
            n.x += dx;
            n.y += dy;
            expandGroupToFitNode(n);
          } else {
            n.x += dx;
            n.y += dy;
          }
        }
      }
      draw(); return;
    }

    if (state.resizingGroup) {
      const dx = w.x - state.resizeStartX, dy = w.y - state.resizeStartY;
      const minW = NODE_W + GROUP_PAD * 2;
      const minH = GROUP_HEADER + NODE_H + GROUP_PAD * 2;
      if (state.resizeEdge === 'right' || state.resizeEdge === 'corner')
        state.resizingGroup.w = Math.max(minW, state.resizeOrigW + dx);
      if (state.resizeEdge === 'bottom' || state.resizeEdge === 'corner')
        state.resizingGroup.h = Math.max(minH, state.resizeOrigH + dy);
      draw(); return;
    }

    if (state.draggingGroup) {
      const nx = w.x - state.dragGroupDx, ny = w.y - state.dragGroupDy;
      const dx = nx - state.draggingGroup.x, dy = ny - state.draggingGroup.y;
      state.draggingGroup.x = nx;
      state.draggingGroup.y = ny;
      for (const n of state.nodes) {
        if (n.fileName === state.draggingGroup.fileName) { n.x += dx; n.y += dy; }
      }
      draw(); return;
    }

    if (state.dragNode) {
      state.dragNode._moved = true;
      state.dragNode.x = w.x - (state.dragNode._dx || 0);
      state.dragNode.y = w.y - (state.dragNode._dy || 0);
      expandGroupToFitNode(state.dragNode);
      draw(); return;
    }

    // Cursor logic
    const rh = hitTestGroupResize(w.x, w.y);
    if (rh) { canvas.style.cursor = getResizeCursor(rh.edge); if (state.hoveredNode) { state.hoveredNode = null; draw(); } return; }

    const btnG = hitTestGroupBtn(w.x, w.y);
    if (btnG) { canvas.style.cursor = 'pointer'; if (state.hoveredNode) { state.hoveredNode = null; draw(); } return; }

    const gh = hitTestGroupHeader(w.x, w.y);
    if (gh && !hitTestNode(w.x, w.y)) { canvas.style.cursor = 'grab'; if (state.hoveredNode) { state.hoveredNode = null; draw(); } return; }

    if ((state.selectedNodes.size > 0 || state.selectedGroupNames.size > 0) && isInMultiSelection(w.x, w.y)) {
      canvas.style.cursor = 'move'; if (state.hoveredNode) { state.hoveredNode = null; draw(); } return;
    }

    const hit = hitTestNode(w.x, w.y);
    if (hit !== state.hoveredNode) { state.hoveredNode = hit; canvas.style.cursor = hit ? 'pointer' : 'default'; draw(); return; }
    if (!hit) { canvas.style.cursor = 'crosshair'; }
  });

  canvas.addEventListener('mouseup', () => {
    if (state.panning) { state.panning = false; canvas.style.cursor = 'default'; return; }
    if (state.rectSelecting) { state.rectSelecting = false; computeRectSelection(); draw(); return; }
    if (state.batchDragging) { state.batchDragging = false; saveCustomSnapshot(); return; }

    const didMoveNode = state.dragNode && state.dragNode._moved;
    const didMoveGroup = state.draggingGroup !== null;
    state.dragNode = null;
    state.resizingGroup = null;
    state.draggingGroup = null;
    if (didMoveNode || didMoveGroup) saveCustomSnapshot();
  });

  canvas.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('dblclick', (e) => {
    const w = screenToWorld(e.offsetX, e.offsetY);
    const gh = hitTestGroupHeader(w.x, w.y);
    if (gh && !hitTestNode(w.x, w.y)) {
      const pad = 40;
      const targetScale = Math.min((state.width - pad * 2) / gh.w, (state.height - pad * 2) / gh.h, 3);
      state.scale = Math.max(0.2, targetScale);
      state.offsetX = state.width / 2 - (gh.x + gh.w / 2) * state.scale;
      state.offsetY = state.height / 2 - (gh.y + gh.h / 2) * state.scale;
      draw(); return;
    }
    const hit = hitTestNode(w.x, w.y);
    if (hit) { postMessage({ command: 'openFile', filePath: hit.file, line: hit.line }); }
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const zf = e.deltaY < 0 ? 1.1 : 0.9;
    const wx = (e.offsetX - state.offsetX) / state.scale;
    const wy = (e.offsetY - state.offsetY) / state.scale;
    state.scale *= zf;
    state.scale = Math.max(0.1, Math.min(5, state.scale));
    state.offsetX = e.offsetX - wx * state.scale;
    state.offsetY = e.offsetY - wy * state.scale;
    draw();
  }, { passive: false });

  const searchInput = document.getElementById('search') as HTMLInputElement;
  searchInput.addEventListener('input', () => {
    state.searchTerm = searchInput.value.toLowerCase();
    draw();
  });

  window.addEventListener('resize', () => { resizeCanvas(); draw(); });
}

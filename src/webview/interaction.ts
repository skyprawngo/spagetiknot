import { state, NODE_W, NODE_H, GROUP_PAD, GROUP_HEADER, NODE_GAP } from './state';
import { draw, scheduleDraw, resizeCanvas } from './canvas';
import {
  layoutNodesInGroup, expandGroupToFitNode,
  saveCustomSnapshot, resolveAllOverlaps,
} from './layout';
import {
  hitTestNode, hitTestGroupHeader, hitTestGroupBtn, hitTestGroupRouteBtn,
  hitTestGroupResize, hitTestEdge, getResizeCursor, screenToWorld,
} from './hitTest';
import { showEdgeInfo, hideEdgeInfo } from './dashboard';
import { postMessage } from './messaging';
import { show as showNodeContext, hide as hideNodeContext, hasPopovers } from './nodeContext';
import { colorForFile, setFileColor } from './colors';

/** Invalidate artwork routing cache — call whenever node/group positions change */
function invalidateRouteCache(): void {
  state.cachedRoutes = null;
  state.cachedPads = null;
}

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

    // Cmd+클릭: go to definition
    if (e.metaKey && e.button === 0) {
      const hit = hitTestNode(w.x, w.y);
      if (hit) {
        postMessage({ command: 'openFile', filePath: hit.file, line: hit.line });
        return;
      }
      const gh = hitTestGroupHeader(w.x, w.y);
      if (gh) {
        const node = state.nodes.find(n => n.fileName === gh.fileName);
        if (node) postMessage({ command: 'openFile', filePath: node.file, line: 0 });
        return;
      }
    }

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

    // While any popover is open, all left-clicks on the canvas are absorbed by the
    // document-level "outside click" listener in nodeContext (which pops the top
    // popover).  Skip canvas-level selection / drag so the node highlight is
    // preserved until the last popover is dismissed.
    if (hasPopovers()) return;

    // Color palette button
    const routeBtnG = hitTestGroupRouteBtn(w.x, w.y);
    if (routeBtnG) {
      openColorPicker(routeBtnG.fileName, e.clientX, e.clientY);
      return;
    }

    // Group layout button
    const btnG = hitTestGroupBtn(w.x, w.y);
    if (btnG) {
      const cur = state.groupLayoutModes.get(btnG.fileName) || 'single';
      const next = cur === 'single' ? 'grid2' : cur === 'grid2' ? 'grid3' : 'single';
      state.groupLayoutModes.set(btnG.fileName, next);
      layoutNodesInGroup(btnG);
      resolveAllOverlaps();
      invalidateRouteCache();
      scheduleDraw();
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
      state.selectedEdgeIdx = -1;
      if (state.selectedNode === hit) {
        // Already selected — show popover, keep selected, no drag
        e.stopPropagation();
        showNodeContext(hit, e.clientX, e.clientY);
        scheduleDraw();
        return;
      }
      state.selectedNode = hit;
      state.dragNode = hit;
      hit._dx = w.x - hit.x;
      hit._dy = w.y - hit.y;
      hit._moved = false;
      scheduleDraw();
      return;
    }

    // Edge click
    const ei = hitTestEdge(w.x, w.y);
    if (ei >= 0) {
      clearMultiSelection();
      state.selectedNode = null;
      state.selectedEdgeIdx = ei;
      showEdgeInfo(ei, e.clientX, e.clientY);
      scheduleDraw();
      return;
    }

    // Empty space → rectangle selection (clears selection)
    state.selectedNode = null;
    state.selectedEdgeIdx = -1;
    hideEdgeInfo();
    clearMultiSelection();
    state.rectSelecting = true;
    state.rectStartWx = w.x;
    state.rectStartWy = w.y;
    state.rectCurWx = w.x;
    state.rectCurWy = w.y;
    scheduleDraw();
  });

  canvas.addEventListener('mousemove', (e) => {
    const w = screenToWorld(e.offsetX, e.offsetY);

    if (state.panning) {
      state.offsetX = e.offsetX - state.panStartX;
      state.offsetY = e.offsetY - state.panStartY;
      scheduleDraw();
      return;
    }

    if (state.rectSelecting) {
      state.rectCurWx = w.x;
      state.rectCurWy = w.y;
      computeRectSelection();
      scheduleDraw();
      return;
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
      invalidateRouteCache();
      scheduleDraw();
      return;
    }

    if (state.resizingGroup) {
      const dx = w.x - state.resizeStartX, dy = w.y - state.resizeStartY;
      const minW = NODE_W + GROUP_PAD * 2;
      const minH = GROUP_HEADER + NODE_H + GROUP_PAD * 2;
      if (state.resizeEdge === 'right' || state.resizeEdge === 'corner')
        state.resizingGroup.w = Math.max(minW, state.resizeOrigW + dx);
      if (state.resizeEdge === 'bottom' || state.resizeEdge === 'corner')
        state.resizingGroup.h = Math.max(minH, state.resizeOrigH + dy);
      invalidateRouteCache();
      scheduleDraw();
      return;
    }

    if (state.draggingGroup) {
      const nx = w.x - state.dragGroupDx, ny = w.y - state.dragGroupDy;
      const dx = nx - state.draggingGroup.x, dy = ny - state.draggingGroup.y;
      state.draggingGroup.x = nx;
      state.draggingGroup.y = ny;
      for (const n of state.nodes) {
        if (n.fileName === state.draggingGroup.fileName) { n.x += dx; n.y += dy; }
      }
      invalidateRouteCache();
      scheduleDraw();
      return;
    }

    if (state.dragNode) {
      state.dragNode._moved = true;
      state.dragNode.x = w.x - (state.dragNode._dx || 0);
      state.dragNode.y = w.y - (state.dragNode._dy || 0);
      expandGroupToFitNode(state.dragNode);
      invalidateRouteCache();
      scheduleDraw();
      return;
    }

    // Cursor logic
    const rh = hitTestGroupResize(w.x, w.y);
    if (rh) {
      canvas.style.cursor = getResizeCursor(rh.edge);
      if (state.hoveredNode) { state.hoveredNode = null; scheduleDraw(); }
      return;
    }

    const routeBtnG2 = hitTestGroupRouteBtn(w.x, w.y);
    if (routeBtnG2) {
      canvas.style.cursor = 'pointer';
      if (state.hoveredNode) { state.hoveredNode = null; scheduleDraw(); }
      return;
    }

    const btnG = hitTestGroupBtn(w.x, w.y);
    if (btnG) {
      canvas.style.cursor = 'pointer';
      if (state.hoveredNode) { state.hoveredNode = null; scheduleDraw(); }
      return;
    }

    const gh = hitTestGroupHeader(w.x, w.y);
    if (gh && !hitTestNode(w.x, w.y)) {
      canvas.style.cursor = 'grab';
      if (state.hoveredNode) { state.hoveredNode = null; scheduleDraw(); }
      return;
    }

    if ((state.selectedNodes.size > 0 || state.selectedGroupNames.size > 0) && isInMultiSelection(w.x, w.y)) {
      canvas.style.cursor = 'move';
      if (state.hoveredNode) { state.hoveredNode = null; scheduleDraw(); }
      return;
    }

    const hit = hitTestNode(w.x, w.y);
    if (hit !== state.hoveredNode) {
      state.hoveredNode = hit;
      canvas.style.cursor = hit ? 'pointer' : 'default';
      scheduleDraw();
      return;
    }
    if (!hit) { canvas.style.cursor = 'crosshair'; }
  });

  canvas.addEventListener('mouseup', () => {
    if (state.panning) { state.panning = false; canvas.style.cursor = 'default'; return; }
    if (state.rectSelecting) { state.rectSelecting = false; computeRectSelection(); scheduleDraw(); return; }
    if (state.batchDragging) { state.batchDragging = false; saveCustomSnapshot(); return; }

    const didMoveNode = state.dragNode && state.dragNode._moved;
    const didMoveGroup = state.draggingGroup !== null;
    state.dragNode = null;
    state.resizingGroup = null;
    state.draggingGroup = null;
    if (didMoveNode || didMoveGroup) saveCustomSnapshot();
  });

  canvas.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });

  // 우클릭 → 코드 바로가기
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const w = screenToWorld(e.offsetX, e.offsetY);
    const hit = hitTestNode(w.x, w.y);
    if (hit) {
      postMessage({ command: 'openFile', filePath: hit.file, line: hit.line });
    } else {
      hideNodeContext();
    }
  });

  // 더블클릭 → 노드면 팝오버, 그룹 헤더면 줌
  canvas.addEventListener('dblclick', (e) => {
    const w = screenToWorld(e.offsetX, e.offsetY);
    const gh = hitTestGroupHeader(w.x, w.y);
    if (gh && !hitTestNode(w.x, w.y)) {
      const pad = 40;
      const targetScale = Math.min((state.width - pad * 2) / gh.w, (state.height - pad * 2) / gh.h, 3);
      state.scale = Math.max(0.2, targetScale);
      state.offsetX = state.width / 2 - (gh.x + gh.w / 2) * state.scale;
      state.offsetY = state.height / 2 - (gh.y + gh.h / 2) * state.scale;
      scheduleDraw();
      return;
    }
    const hit = hitTestNode(w.x, w.y);
    if (hit) {
      state.selectedNode = hit; // keep node selected after double-click toggle
      showNodeContext(hit, e.clientX, e.clientY);
      scheduleDraw();
    }
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey) {
      // 핀치 줌 (터치패드): deltaY가 픽셀 단위 소수로 연속 발생하므로
      // 고정 배율 대신 deltaY 크기에 비례한 연속 줌 적용
      const zf = Math.pow(0.994, e.deltaY);
      const wx = (e.offsetX - state.offsetX) / state.scale;
      const wy = (e.offsetY - state.offsetY) / state.scale;
      state.scale *= zf;
      state.scale = Math.max(0.1, Math.min(5, state.scale));
      state.offsetX = e.offsetX - wx * state.scale;
      state.offsetY = e.offsetY - wy * state.scale;
    } else if (e.deltaMode === 0 && (e.deltaX !== 0 || Math.abs(e.deltaY) < 50)) {
      // 두 손가락 스크롤 패닝 (터치패드: deltaMode=0, 픽셀 단위 작은 값)
      state.offsetX -= e.deltaX;
      state.offsetY -= e.deltaY;
    } else {
      // 마우스 휠 줌 (단계적 고정 배율)
      const zf = e.deltaY < 0 ? 1.06 : 0.94;
      const wx = (e.offsetX - state.offsetX) / state.scale;
      const wy = (e.offsetY - state.offsetY) / state.scale;
      state.scale *= zf;
      state.scale = Math.max(0.1, Math.min(5, state.scale));
      state.offsetX = e.offsetX - wx * state.scale;
      state.offsetY = e.offsetY - wy * state.scale;
    }
    scheduleDraw();
  }, { passive: false });

  const searchInput = document.getElementById('search') as HTMLInputElement;
  searchInput.addEventListener('input', () => {
    state.searchTerm = searchInput.value.toLowerCase();
    scheduleDraw();
  });

  window.addEventListener('resize', () => { resizeCanvas(); scheduleDraw(); });

  // Cmd+C: 선택된 함수의 파일 경로 + 함수명 복사
  window.addEventListener('keydown', (e) => {
    if (e.key === 'c' && e.metaKey && !e.shiftKey && !e.altKey) {
      if (state.selectedNode) {
        e.preventDefault();
        postMessage({
          command: 'copyToClipboard',
          text: `${state.selectedNode.file}:${state.selectedNode.label}`,
        });
      }
    }
  });
}

/** Open the OS/browser native color picker for a file group. */
function openColorPicker(fileName: string, clientX: number, clientY: number): void {
  const current = colorForFile(fileName);
  const input = document.createElement('input');
  input.type = 'color';
  input.value = current;
  // Position the invisible input at the mouse location so the OS picker opens nearby
  input.style.cssText = `position:fixed;opacity:0;pointer-events:none;width:0;height:0;left:${clientX}px;top:${clientY}px;`;
  document.body.appendChild(input);

  input.addEventListener('input', () => {
    setFileColor(fileName, input.value);
    state.cachedRoutes = null;
    scheduleDraw();
  });
  input.addEventListener('change', () => {
    setFileColor(fileName, input.value);
    state.cachedRoutes = null;
    scheduleDraw();
    input.remove();
  });
  input.addEventListener('blur', () => input.remove());

  input.click();
}

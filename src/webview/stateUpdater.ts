/**
 * @module stateUpdater
 * @description Applies incoming extension-host messages to the webview state.
 *
 * Responsibilities: state mutation, layout recalculation, triggering redraws.
 * Does NOT handle DOM rendering (that belongs to dirPickerUI / dashboard).
 *
 * ┌─────────────────────────┬──────────────────────────────────────────────────────┐
 * │ Export                  │ Role                                                 │
 * ├─────────────────────────┼──────────────────────────────────────────────────────┤
 * │ applyLoadData           │ Full reset + rebuild from loadData message           │
 * │ applyIncrementalUpdate  │ Partial update — preserves positions of untouched    │
 * │                         │ nodes and groups; re-layouts only changed files      │
 * │ applySavedLayout        │ Overlay saved group/node positions onto current state│
 * └─────────────────────────┴──────────────────────────────────────────────────────┘
 */
import { state, NODE_W, NODE_H, GraphNode, GraphEdge, ExternalCallee } from './state';
import { applyGlobalLayout, applyMultiRowStackerLayout, fitToScreen, layoutNodesInGroup } from './layout';
import { clearFileColors, restoreFileColors } from './colors';
import { resizeCanvas, draw } from './canvas';
import { updateFileList } from './dashboard';

// ── Full reload ───────────────────────────────────────────────────────────────

/**
 * Called on `loadData` messages (initial index or layout load).
 * Resets ALL state then builds nodes/edges from scratch.
 */
export function applyLoadData(msg: any): void {
  clearFileColors();
  resetInteractionState();

  state.targetDir = msg.targetDir || '';
  state.nodes = (msg.functions || []).map(makeNode);
  state.edges = (msg.edges || []).map(makeEdge);
  buildExternalCallMap(msg.externalCalls || []);

  // Auto-assign layout mode: 2-column for groups with 8+ functions
  const countByFile = new Map<string, number>();
  for (const n of state.nodes) {
    countByFile.set(n.fileName, (countByFile.get(n.fileName) || 0) + 1);
  }
  for (const [fileName, count] of countByFile) {
    state.groupLayoutModes.set(fileName, count >= 8 ? 'grid2' : 'single');
  }

  applyGlobalLayout(2);

  if (msg.savedLayout) {
    applySavedLayout(msg.savedLayout);
  } else if (msg.autoLayoutType) {
    applyAutoLayoutType(msg.autoLayoutType);
    fitToScreen();
  }

  updateFileList();
  resizeCanvas();
  draw();
}

// ── Incremental update ────────────────────────────────────────────────────────

/**
 * Called on `incrementalUpdate` messages (file saved / created / deleted).
 *
 * Position-preservation contract:
 *  - Nodes whose ID is unchanged keep their exact (x, y, w, h).
 *  - Groups whose source file was NOT in `changedFiles` keep their position.
 *  - Groups whose source file changed get `layoutNodesInGroup` re-run (within
 *    the group's existing screen position), so newly added/removed functions
 *    are placed without disrupting other groups.
 */
export function applyIncrementalUpdate(msg: any): void {
  // Snapshot positions before rebuilding
  const oldPositions = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const n of state.nodes) {
    oldPositions.set(n.id, { x: n.x, y: n.y, w: n.w, h: n.h });
  }

  const oldGroupPos = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const g of state.fileGroups) {
    oldGroupPos.set(g.fileName, { x: g.x, y: g.y, w: g.w, h: g.h });
  }

  // Rebuild from message
  state.nodes = (msg.functions || []).map(makeNode);
  state.edges = (msg.edges || []).map(makeEdge);
  buildExternalCallMap(msg.externalCalls || []);

  // Restore positions for nodes whose ID survived the update
  for (const n of state.nodes) {
    const saved = oldPositions.get(n.id);
    if (saved) { n.x = saved.x; n.y = saved.y; n.w = saved.w; n.h = saved.h; }
  }

  // Sync group list: remove stale, add new
  const fileNames = new Set(state.nodes.map(n => n.fileName));
  state.fileGroups = state.fileGroups.filter(g => fileNames.has(g.fileName));
  for (const fn of fileNames) {
    if (!state.fileGroups.find(g => g.fileName === fn)) {
      state.fileGroups.push({ fileName: fn, x: 60, y: 60, w: 0, h: 0 });
    }
    if (!state.groupLayoutModes.has(fn)) {
      const count = state.nodes.filter(n => n.fileName === fn).length;
      state.groupLayoutModes.set(fn, count >= 8 ? 'grid2' : 'single');
    }
  }

  // Changed file names (basename only, matching GraphNode.fileName)
  const changedFileNames = new Set(
    (msg.changedFiles as string[] || []).map((fp: string) => fp.replace(/^.*[\\/]/, '')),
  );

  for (const g of state.fileGroups) {
    const oldG = oldGroupPos.get(g.fileName);
    const isNew = !oldG;
    const fileChanged = changedFileNames.has(g.fileName);

    if (isNew || fileChanged) {
      // Re-layout: either a brand-new group, or its source file changed
      if (oldG) { g.x = oldG.x; g.y = oldG.y; g.w = oldG.w; g.h = oldG.h; }
      layoutNodesInGroup(g);
    } else {
      // Untouched group — restore saved position, keep user layout intact
      g.x = oldG.x; g.y = oldG.y; g.w = oldG.w; g.h = oldG.h;
    }
  }

  updateFileList();
  draw();
}

// ── Saved layout restore ──────────────────────────────────────────────────────

/**
 * Overlay saved group/node positions and view transform onto the current state.
 * Called after `applyLoadData` when a layout is loaded from disk.
 */
export function applySavedLayout(layout: any): void {
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
    state.offsetX = layout.view.offsetX ?? 0;
    state.offsetY = layout.view.offsetY ?? 0;
    state.scale   = layout.view.scale   ?? 1;
  }
  if (layout.fileColors) {
    restoreFileColors(layout.fileColors);
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function resetInteractionState(): void {
  state.groupLayoutModes.clear();
  state.dragNode       = null;
  state.selectedNode   = null;
  state.hoveredNode    = null;
  state.resizingGroup  = null;
  state.draggingGroup  = null;
  state.panning        = false;
  state.rectSelecting  = false;
  state.batchDragging  = false;
  state.cachedRoutes   = null;
  state.customSnapshot = null;
  state.selectedEdgeIdx = -1;
  state.selectedNodes.clear();
  state.selectedGroupNames.clear();
}

function makeNode(fn: any): GraphNode {
  return {
    id:       fn.filePath + ':' + fn.line + ':' + fn.name,
    label:    fn.name,
    file:     fn.filePath,
    fileName: fn.filePath.replace(/^.*[\\/]/, ''),
    line:     fn.line,
    params:   fn.params  || [],
    comment:  fn.comment || '',
    x: 0, y: 0, w: NODE_W, h: NODE_H,
  };
}

function makeEdge(e: any): GraphEdge {
  return {
    source: e.source, target: e.target,
    args:   e.args   || [],
    params: e.params || [],
  };
}

function applyAutoLayoutType(layoutType: string): void {
  switch (layoutType) {
    case 'stacker2':    applyMultiRowStackerLayout(2); break;
    case 'stacker3':    applyMultiRowStackerLayout(3); break;
    case 'stacker4':    applyMultiRowStackerLayout(4); break;
    case '1col':        applyGlobalLayout(1); break;
    case 'horizontal':  applyGlobalLayout(0); break;
    case 'compact':     applyGlobalLayout(-1); break;
    default:            applyGlobalLayout(2); break;
  }
}

function buildExternalCallMap(raw: any[]): void {
  state.externalCallMap.clear();
  for (const c of raw) {
    const list = state.externalCallMap.get(c.callerNodeId) || [];
    list.push({ name: c.name, realName: c.realName, module: c.module } as ExternalCallee);
    state.externalCallMap.set(c.callerNodeId, list);
  }
}

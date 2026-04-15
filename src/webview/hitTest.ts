import { state, GraphNode, FileGroup, GROUP_HEADER, GROUP_BTN_SIZE, RESIZE_MARGIN, EDGE_HIT_DIST } from './state';

export function hitTestNode(wx: number, wy: number): GraphNode | null {
  for (let i = state.nodes.length - 1; i >= 0; i--) {
    const n = state.nodes[i];
    if (wx >= n.x && wx <= n.x + n.w && wy >= n.y && wy <= n.y + n.h) return n;
  }
  return null;
}

export function hitTestGroupHeader(wx: number, wy: number): FileGroup | null {
  for (const g of state.fileGroups) {
    if (wx >= g.x && wx <= g.x + g.w && wy >= g.y && wy <= g.y + GROUP_HEADER) return g;
  }
  return null;
}

export function hitTestGroupBtn(wx: number, wy: number): FileGroup | null {
  for (const g of state.fileGroups) {
    const bx = g.x + g.w - GROUP_BTN_SIZE - 6;
    const by = g.y + 6;
    if (wx >= bx && wx <= bx + GROUP_BTN_SIZE && wy >= by && wy <= by + GROUP_BTN_SIZE) return g;
  }
  return null;
}

export function hitTestGroupResize(wx: number, wy: number): { group: FileGroup; edge: string } | null {
  for (const g of state.fileGroups) {
    const onR = Math.abs(wx - (g.x + g.w)) < RESIZE_MARGIN && wy >= g.y && wy <= g.y + g.h;
    const onB = Math.abs(wy - (g.y + g.h)) < RESIZE_MARGIN && wx >= g.x && wx <= g.x + g.w;
    if (onR && onB) return { group: g, edge: 'corner' };
    if (onR) return { group: g, edge: 'right' };
    if (onB) return { group: g, edge: 'bottom' };
  }
  return null;
}

export function hitTestEdge(wx: number, wy: number): number {
  const threshold = EDGE_HIT_DIST / state.scale + 2;

  // Artwork mode: test against routed polyline paths
  if (state.artworkLineMode && state.cachedRoutes) {
    for (const routed of state.cachedRoutes) {
      const path = routed.path as [number, number][];
      if (path.length < 2) continue;
      for (let i = 0; i < path.length - 1; i++) {
        const d = distToSegment(wx, wy, path[i][0], path[i][1], path[i + 1][0], path[i + 1][1]);
        if (d < threshold) return routed.edgeIdx;
      }
    }
    return -1;
  }

  // Normal mode: test against straight center-to-center lines
  const nodeMap = new Map<string, GraphNode>();
  state.nodes.forEach(n => nodeMap.set(n.id, n));
  for (let ei = 0; ei < state.edges.length; ei++) {
    const e = state.edges[ei];
    const a = nodeMap.get(e.source);
    const b = nodeMap.get(e.target);
    if (!a || !b) continue;
    const ax = a.x + a.w / 2, ay = a.y + a.h / 2;
    const bx = b.x + b.w / 2, by = b.y + b.h / 2;
    const d = distToSegment(wx, wy, ax, ay, bx, by);
    if (d < threshold) return ei;
  }
  return -1;
}

function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.sqrt((px - x1) ** 2 + (py - y1) ** 2);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const nx = x1 + t * dx, ny = y1 + t * dy;
  return Math.sqrt((px - nx) ** 2 + (py - ny) ** 2);
}

export function getResizeCursor(edge: string): string {
  if (edge === 'corner') return 'nwse-resize';
  if (edge === 'right') return 'ew-resize';
  if (edge === 'bottom') return 'ns-resize';
  return 'default';
}

export function screenToWorld(sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - state.offsetX) / state.scale, y: (sy - state.offsetY) / state.scale };
}

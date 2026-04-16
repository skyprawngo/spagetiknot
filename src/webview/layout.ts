import {
  state, GraphNode, FileGroup,
  NODE_W, NODE_W_MAX, NODE_H, GROUP_PAD, GROUP_HEADER, GROUP_GAP_X, GROUP_GAP_Y, NODE_GAP,
} from './state';

// bold 13px monospace ≈ 8px per character; 32px horizontal padding
const CHAR_PX = 8;
const LABEL_H_PAD = 32;

export function computeNodeWidth(label: string): number {
  return Math.min(NODE_W_MAX, Math.max(NODE_W, label.length * CHAR_PX + LABEL_H_PAD));
}

export function getSortedGroupEntries(): [string, GraphNode[]][] {
  const groupMap = new Map<string, GraphNode[]>();
  for (const n of state.nodes) {
    if (!groupMap.has(n.fileName)) groupMap.set(n.fileName, []);
    groupMap.get(n.fileName)!.push(n);
  }
  return [...groupMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

export function getGroupNodes(fileName: string): GraphNode[] {
  return state.nodes.filter(n => n.fileName === fileName);
}

export function layoutNodesInGroup(g: FileGroup): void {
  const gNodes = getGroupNodes(g.fileName);
  if (gNodes.length === 0) return;
  const mode = state.groupLayoutModes.get(g.fileName) || 'single';

  const cols = mode === 'grid3' ? 3 : mode === 'grid2' ? 2 : 1;

  // Artwork mode: wider gaps between nodes so traces have room
  const gap    = state.artworkLineMode ? NODE_GAP + 20 : NODE_GAP;
  const colGap = state.artworkLineMode ? 36 : 6;

  // Compute per-node widths based on label length
  gNodes.forEach(n => {
    n.h = NODE_H;
    n.w = computeNodeWidth(n.label);
  });

  if (cols === 1) {
    // Single column: each node keeps its own width; group = widest node
    const groupInnerW = Math.max(...gNodes.map(n => n.w));
    gNodes.forEach((n, i) => {
      n.x = g.x + GROUP_PAD;
      n.y = g.y + GROUP_HEADER + GROUP_PAD + i * (NODE_H + gap);
    });
    const rows = gNodes.length;
    g.w = groupInnerW + GROUP_PAD * 2;
    g.h = GROUP_HEADER + rows * (NODE_H + gap) - gap + GROUP_PAD * 2;
  } else {
    // Grid: uniform width = widest node in the group
    const uniformW = Math.max(...gNodes.map(n => n.w));
    gNodes.forEach((n, i) => {
      n.w = uniformW;
      const col = i % cols;
      const row = Math.floor(i / cols);
      n.x = g.x + GROUP_PAD + col * (uniformW + colGap);
      n.y = g.y + GROUP_HEADER + GROUP_PAD + row * (NODE_H + gap);
    });
    const rows = Math.ceil(gNodes.length / cols);
    g.w = cols * uniformW + (cols - 1) * colGap + GROUP_PAD * 2;
    g.h = GROUP_HEADER + rows * (NODE_H + gap) - gap + GROUP_PAD * 2;
  }
}

export function measureGroup(fileName: string): { w: number; h: number } {
  const g: FileGroup = { fileName, x: 0, y: 0, w: 0, h: 0 };
  if (!state.groupLayoutModes.has(fileName)) state.groupLayoutModes.set(fileName, 'single');
  layoutNodesInGroup(g);
  return { w: g.w, h: g.h };
}

export function applyGlobalLayout(colCount: number): void {
  const entries = getSortedGroupEntries();
  const sizes = entries.map(([fn]) => measureGroup(fn));
  state.fileGroups = [];

  if (colCount === 0) {
    let cx = 60;
    for (let i = 0; i < entries.length; i++) {
      const [fileName] = entries[i];
      const g: FileGroup = { fileName, x: cx, y: 60, w: 0, h: 0 };
      state.fileGroups.push(g);
      layoutNodesInGroup(g);
      cx += g.w + GROUP_GAP_X;
    }
  } else if (colCount === -1) {
    const maxColW = [0, 0];
    const assignments: number[] = [];
    const tempColY = [0, 0];
    for (let i = 0; i < entries.length; i++) {
      const col = tempColY[0] <= tempColY[1] ? 0 : 1;
      assignments.push(col);
      maxColW[col] = Math.max(maxColW[col], sizes[i].w);
      tempColY[col] += sizes[i].h + 16;
    }
    const colX = [60, 60 + maxColW[0] + 20];
    const colY = [60, 60];
    for (let i = 0; i < entries.length; i++) {
      const [fileName] = entries[i];
      const col = assignments[i];
      const g: FileGroup = { fileName, x: colX[col], y: colY[col], w: 0, h: 0 };
      state.fileGroups.push(g);
      layoutNodesInGroup(g);
      colY[col] += g.h + 16;
    }
  } else {
    const cols = colCount;
    const maxColW = new Array(cols).fill(0);
    for (let gi = 0; gi < entries.length; gi++) {
      const col = gi % cols;
      maxColW[col] = Math.max(maxColW[col], sizes[gi].w);
    }
    const colXs = [60];
    for (let c = 1; c < cols; c++) colXs.push(colXs[c - 1] + maxColW[c - 1] + GROUP_GAP_X);
    const colY = new Array(cols).fill(60);
    for (let gi = 0; gi < entries.length; gi++) {
      const [fileName] = entries[gi];
      const col = gi % cols;
      const g: FileGroup = { fileName, x: colXs[col], y: colY[col], w: 0, h: 0 };
      state.fileGroups.push(g);
      layoutNodesInGroup(g);
      colY[col] += g.h + GROUP_GAP_Y;
    }
  }
}

export function applyStackerLayout(): void {
  applyMultiRowStackerLayout(2);
}

/**
 * Multi-row stagger layout.
 *   numRows  — total number of horizontal bands (2, 3, or 4)
 *   Odd-numbered rows (1, 3, …) share x = 60 (left-aligned)
 *   Even-numbered rows (2, 4, …) share x = 60 + staggerOffset
 */
export function applyMultiRowStackerLayout(numRows: number): void {
  const entries = getSortedGroupEntries();
  state.fileGroups = [];
  if (entries.length === 0) return;

  // Distribute groups round-robin across rows
  const rows: [string, any[][]][] = Array.from({ length: numRows }, () => []);
  // rows[r] = list of [fileName, ...] entries assigned to band r
  const rowEntries: Array<Array<[string, any[]]>> = Array.from({ length: numRows }, () => []);
  for (let i = 0; i < entries.length; i++) {
    rowEntries[i % numRows].push(entries[i]);
  }

  // Compute stagger offset from average width of row-0 groups
  const row0Widths = rowEntries[0].map(([fn]) => measureGroup(fn).w);
  const avgW = row0Widths.length > 0
    ? row0Widths.reduce((s, v) => s + v, 0) / row0Widths.length
    : NODE_W;
  const staggerOffset = avgW * 0.4;

  // x origin per row: odd-index rows (0, 2, …) → 60; even-index rows (1, 3, …) → 60 + offset
  const rowStartX = (r: number) => r % 2 === 0 ? 60 : 60 + staggerOffset;

  // First pass: measure max height per row and compute cumulative y positions
  const maxRowH: number[] = rowEntries.map((re) =>
    re.length > 0 ? Math.max(...re.map(([fn]) => measureGroup(fn).h)) : 0
  );

  // y for the BOTTOM of each row (groups are bottom-aligned within their band)
  const rowBottomY: number[] = [];
  let curY = 60;
  for (let r = 0; r < numRows; r++) {
    curY += maxRowH[r];
    rowBottomY.push(curY);
    curY += GROUP_GAP_Y * 1.5;
  }

  // Second pass: place groups
  for (let r = 0; r < numRows; r++) {
    let cx = rowStartX(r);
    const bottomY = rowBottomY[r];
    for (const [fileName] of rowEntries[r]) {
      const { h } = measureGroup(fileName);
      // bottom-align within the row band: set final y before laying out nodes
      const g: FileGroup = { fileName, x: cx, y: bottomY - h, w: 0, h: 0 };
      state.fileGroups.push(g);
      layoutNodesInGroup(g);
      cx += g.w + GROUP_GAP_X;
    }
  }
}

export function fitToScreen(): void {
  if (state.fileGroups.length === 0) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const g of state.fileGroups) {
    minX = Math.min(minX, g.x); minY = Math.min(minY, g.y);
    maxX = Math.max(maxX, g.x + g.w); maxY = Math.max(maxY, g.y + g.h);
  }
  const cw = maxX - minX, ch = maxY - minY;
  const pad = 40;
  state.scale = Math.min((state.width - pad * 2) / cw, (state.height - pad * 2) / ch, 2);
  state.scale = Math.max(0.1, state.scale);
  state.offsetX = pad - minX * state.scale + (state.width - pad * 2 - cw * state.scale) / 2;
  state.offsetY = pad - minY * state.scale + (state.height - pad * 2 - ch * state.scale) / 2;
}

export function resolveGroupOverlaps(_changed?: FileGroup): void {
  resolveAllOverlaps();
}

/**
 * Full all-pairs overlap resolution.
 * Iterates until no two groups overlap (or max iterations exceeded).
 * Handles cascade: A pushes B, B pushes C, etc.
 */
export function resolveAllOverlaps(): void {
  const margin = 12;
  const gs = state.fileGroups;
  const maxIter = gs.length * gs.length * 4 + 8;
  let didMove = true;
  let iter = 0;
  while (didMove && iter++ < maxIter) {
    didMove = false;
    for (let i = 0; i < gs.length; i++) {
      for (let j = i + 1; j < gs.length; j++) {
        const a = gs[i];
        const b = gs[j];
        const ax = a.x - margin, ay = a.y - margin;
        const aw = a.w + margin * 2, ah = a.h + margin * 2;
        // No overlap?
        if (b.x + b.w <= ax || b.x >= ax + aw ||
            b.y + b.h <= ay || b.y >= ay + ah) continue;

        // Compute minimum-distance push direction (push b away from a)
        const pushR = (ax + aw) - b.x;
        const pushL = (b.x + b.w) - ax;
        const pushD = (ay + ah) - b.y;
        const pushU = (b.y + b.h) - ay;
        const minPush = Math.min(pushR, pushL, pushD, pushU);

        let dx = 0, dy = 0;
        if (minPush === pushR)      dx =  pushR;
        else if (minPush === pushL) dx = -pushL;
        else if (minPush === pushD) dy =  pushD;
        else                        dy = -pushU;

        b.x += dx; b.y += dy;
        for (const n of state.nodes) {
          if (n.fileName === b.fileName) { n.x += dx; n.y += dy; }
        }
        didMove = true;
      }
    }
  }
}

export function expandGroupToFitNode(node: GraphNode): void {
  const g = state.fileGroups.find(g => g.fileName === node.fileName);
  if (!g) return;
  const needL = node.x - GROUP_PAD;
  const needT = node.y - GROUP_HEADER - GROUP_PAD;
  const needR = node.x + node.w + GROUP_PAD;
  const needB = node.y + node.h + GROUP_PAD;
  if (needL < g.x) { g.w += g.x - needL; g.x = needL; }
  if (needT < g.y) { g.h += g.y - needT; g.y = needT; }
  if (needR > g.x + g.w) { g.w = needR - g.x; }
  if (needB > g.y + g.h) { g.h = needB - g.y; }
}

export function saveCustomSnapshot(): void {
  state.customSnapshot = {
    groups: state.fileGroups.map(g => ({ fileName: g.fileName, x: g.x, y: g.y, w: g.w, h: g.h })),
    nodes: state.nodes.map(n => ({ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h })),
    modes: [...state.groupLayoutModes.entries()],
  };
  const btn = document.getElementById('btn-custom') as HTMLButtonElement;
  btn.disabled = false;
  btn.style.opacity = '1';
  btn.textContent = 'Custom';
}

export function restoreCustomSnapshot(): void {
  if (!state.customSnapshot) return;
  const gMap = new Map(state.customSnapshot.groups.map(g => [g.fileName, g]));
  for (const g of state.fileGroups) {
    const saved = gMap.get(g.fileName);
    if (saved) { g.x = saved.x; g.y = saved.y; g.w = saved.w; g.h = saved.h; }
  }
  const nMap = new Map(state.customSnapshot.nodes.map(n => [n.id, n]));
  for (const n of state.nodes) {
    const saved = nMap.get(n.id);
    if (saved) { n.x = saved.x; n.y = saved.y; n.w = saved.w; n.h = saved.h; }
  }
  for (const [k, v] of state.customSnapshot.modes) {
    state.groupLayoutModes.set(k, v);
  }
}

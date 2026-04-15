import {
  state, GraphNode, FileGroup,
  NODE_W, NODE_H, GROUP_PAD, GROUP_HEADER, GROUP_GAP_X, GROUP_GAP_Y, NODE_GAP,
} from './state';

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
  const nodeW = cols === 1 ? NODE_W : (NODE_W * 0.9);
  const innerPad = cols > 1 ? 6 : 0;

  // Artwork mode: wider gaps between nodes so traces have room
  const gap = state.artworkLineMode ? NODE_GAP + 20 : NODE_GAP;
  const colGap = state.artworkLineMode ? innerPad + 30 : innerPad;

  const rows = Math.ceil(gNodes.length / cols);
  gNodes.forEach((n, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    n.w = nodeW;
    n.h = NODE_H;
    n.x = g.x + GROUP_PAD + col * (nodeW + colGap);
    n.y = g.y + GROUP_HEADER + GROUP_PAD + row * (NODE_H + gap);
  });

  const totalW = cols * nodeW + (cols - 1) * colGap + GROUP_PAD * 2;
  const totalH = GROUP_HEADER + rows * (NODE_H + gap) - gap + GROUP_PAD * 2;
  g.w = totalW;
  g.h = totalH;
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
  const entries = getSortedGroupEntries();
  const sizes = entries.map(([fn]) => measureGroup(fn));
  state.fileGroups = [];

  const row1Entries = entries.filter((_, i) => i % 2 === 0);
  const row2Entries = entries.filter((_, i) => i % 2 === 1);
  const row1Sizes = sizes.filter((_, i) => i % 2 === 0);

  const avgRow1W = row1Sizes.length > 0 ? row1Sizes.reduce((s, v) => s + v.w, 0) / row1Sizes.length : NODE_W;
  const staggerOffset = avgRow1W * 0.4;

  let cx1 = 60;
  let maxRow1H = 0;
  for (const [fileName] of row1Entries) {
    const g: FileGroup = { fileName, x: cx1, y: 60, w: 0, h: 0 };
    state.fileGroups.push(g);
    layoutNodesInGroup(g);
    maxRow1H = Math.max(maxRow1H, g.h);
    cx1 += g.w + GROUP_GAP_X;
  }

  const row2ActualH = row2Entries.map((e) => measureGroup(e[0]).h);
  const maxRow2H = Math.max(...row2ActualH, 0);
  const row2Bottom = 60 + maxRow1H + GROUP_GAP_Y * 1.5 + maxRow2H;

  let cx2 = 60 + staggerOffset;
  for (let i = 0; i < row2Entries.length; i++) {
    const [fileName] = row2Entries[i];
    const h = row2ActualH[i];
    const g: FileGroup = { fileName, x: cx2, y: row2Bottom - h, w: 0, h: 0 };
    state.fileGroups.push(g);
    layoutNodesInGroup(g);
    cx2 += g.w + GROUP_GAP_X;
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

export function resolveGroupOverlaps(changed: FileGroup): void {
  const margin = 12;
  let maxIter = state.fileGroups.length * 4;
  let didMove = true;
  while (didMove && maxIter-- > 0) {
    didMove = false;
    for (const other of state.fileGroups) {
      if (other === changed) continue;
      const ox = changed.x - margin, oy = changed.y - margin;
      const ow = changed.w + margin * 2, oh = changed.h + margin * 2;
      if (other.x + other.w <= ox || other.x >= ox + ow ||
          other.y + other.h <= oy || other.y >= oy + oh) continue;

      const pushR = (ox + ow) - other.x;
      const pushL = (other.x + other.w) - ox;
      const pushD = (oy + oh) - other.y;
      const pushU = (other.y + other.h) - oy;
      const minPush = Math.min(pushR, pushL, pushD, pushU);

      let dx = 0, dy = 0;
      if (minPush === pushR) dx = pushR;
      else if (minPush === pushL) dx = -pushL;
      else if (minPush === pushD) dy = pushD;
      else dy = -pushU;

      other.x += dx;
      other.y += dy;
      for (const n of state.nodes) {
        if (n.fileName === other.fileName) { n.x += dx; n.y += dy; }
      }
      didMove = true;
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

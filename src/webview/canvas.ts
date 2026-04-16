import {
  state, GraphNode,
  GROUP_PAD, GROUP_HEADER, GROUP_BTN_SIZE,
} from './state';
import { colorForFile } from './colors';
import { routeAllEdges, computeAllPads, RoutedEdge, Pad } from './routing';
import { getTheme, withAlpha, Theme } from './theme';
import { DEFAULT_FONT } from './selectionScale';

let ctx: CanvasRenderingContext2D;
let canvasEl: HTMLCanvasElement;

export function initCanvas(canvas: HTMLCanvasElement): void {
  canvasEl = canvas;
  ctx = canvas.getContext('2d')!;
}

export function resizeCanvas(): void {
  state.width = canvasEl.clientWidth || window.innerWidth;
  state.height = canvasEl.clientHeight || (window.innerHeight - 36);
  canvasEl.width = state.width * devicePixelRatio;
  canvasEl.height = state.height * devicePixelRatio;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
}

// ──────────────────────────────────────────────
//  RAF-based draw scheduler
//  Multiple scheduleDraw() calls in the same tick
//  collapse into a single draw() per animation frame.
// ──────────────────────────────────────────────
let rafPending = false;

export function scheduleDraw(): void {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    draw();
  });
}

// ──────────────────────────────────────────────
//  Viewport culling
//  World-space rect → is any part visible on screen?
// ──────────────────────────────────────────────
function inViewport(x: number, y: number, w: number, h: number): boolean {
  const { offsetX, offsetY, scale, width, height } = state;
  return (
    (x + w) * scale + offsetX > 0 &&
    x * scale + offsetX < width &&
    (y + h) * scale + offsetY > 0 &&
    y * scale + offsetY < height
  );
}

// Stats DOM — only update when the text actually changes
let lastStatsText = '';

export function draw(): void {
  const theme = getTheme();

  const { width, height, nodes, edges, fileGroups, offsetX, offsetY, scale,
    selectedNode, selectedEdgeIdx, searchTerm, hoveredNode,
    selectedNodes, selectedGroupNames, rectSelecting,
    rectStartWx, rectStartWy, rectCurWx, rectCurWy } = state;

  if (width === 0 || height === 0) return;
  ctx.save();
  ctx.clearRect(0, 0, width, height);
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);

  const nodeMap = new Map<string, GraphNode>();
  nodes.forEach(n => nodeMap.set(n.id, n));

  // --- File group boxes ---
  for (const g of fileGroups) {
    if (!inViewport(g.x, g.y, g.w, g.h)) continue;

    const color = colorForFile(g.fileName);
    const isGroupSel = selectedGroupNames.has(g.fileName);
    ctx.fillStyle = isGroupSel ? withAlpha(theme.caller, 0.06) : withAlpha(theme.foreground, 0.03);
    ctx.strokeStyle = isGroupSel ? theme.caller : color;
    ctx.lineWidth = isGroupSel ? 2 : 1;
    ctx.globalAlpha = isGroupSel ? 0.9 : 0.6;
    roundRect(g.x, g.y, g.w, g.h, 8);
    ctx.fill();
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.fillStyle = color;
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(g.fileName, g.x + 12, g.y + GROUP_HEADER / 2);

    // Color palette button (left of layout button) — shows current file color as swatch
    const routeBtnX = g.x + g.w - (GROUP_BTN_SIZE + 6) * 2;
    const routeBtnY = g.y + 6;
    ctx.fillStyle = withAlpha(theme.foreground, 0.06);
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.8;
    roundRect(routeBtnX, routeBtnY, GROUP_BTN_SIZE, GROUP_BTN_SIZE, 3);
    ctx.fill();
    ctx.stroke();
    // Filled circle swatch in the current group color
    const swatchR = GROUP_BTN_SIZE / 2 - 3;
    const swatchCx = routeBtnX + GROUP_BTN_SIZE / 2;
    const swatchCy = routeBtnY + GROUP_BTN_SIZE / 2;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(swatchCx, swatchCy, swatchR, 0, Math.PI * 2);
    ctx.fill();

    // Layout toggle button
    const btnX = g.x + g.w - GROUP_BTN_SIZE - 6;
    const btnY = g.y + 6;
    ctx.fillStyle = withAlpha(theme.foreground, 0.08);
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.8;
    roundRect(btnX, btnY, GROUP_BTN_SIZE, GROUP_BTN_SIZE, 3);
    ctx.fill();
    ctx.stroke();
    const mode = state.groupLayoutModes.get(g.fileName) || 'single';
    ctx.fillStyle = color;
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(mode === 'grid3' ? '|||' : mode === 'grid2' ? '||' : '|', btnX + GROUP_BTN_SIZE / 2, btnY + GROUP_BTN_SIZE / 2);

    // Resize handle
    const hx = g.x + g.w - 6;
    const hy = g.y + g.h - 6;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.4;
    ctx.beginPath();
    ctx.moveTo(hx + 6, hy);
    ctx.lineTo(hx + 6, hy + 6);
    ctx.lineTo(hx, hy + 6);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // --- Connection highlighting (caller/callee classification) ---
  const calleeIds = new Set<string>(); // selected node calls these
  const callerIds = new Set<string>(); // these call selected node
  const selectedEdges = new Set<number>();
  if (selectedNode) {
    for (let ei = 0; ei < edges.length; ei++) {
      const e = edges[ei];
      if (e.source === selectedNode.id) {
        calleeIds.add(e.target);
        selectedEdges.add(ei);
      }
      if (e.target === selectedNode.id) {
        callerIds.add(e.source);
        selectedEdges.add(ei);
      }
    }
  }

  // --- Artwork routing — use cache, only recompute when invalidated ---
  const artMode = state.artworkLineMode;
  let routedEdges: RoutedEdge[] | null = null;
  let allPads: Map<number, { sourcePad: Pad; targetPad: Pad }> | null = null;

  if (artMode) {
    if (!state.cachedRoutes) {
      state.cachedRoutes = routeAllEdges();
      state.cachedPads = computeAllPads();
    }
    routedEdges = state.cachedRoutes as RoutedEdge[];
    allPads = state.cachedPads as Map<number, { sourcePad: Pad; targetPad: Pad }>;
  }

  // --- Render order depends on mode ---
  // Normal: Edges → Nodes (edges behind)
  // Artwork: Nodes → Edges → Pads (traces visible on top)
  if (artMode) {
    drawNodes(nodes, searchTerm, selectedNode, hoveredNode, calleeIds, callerIds, selectedNodes, theme);
    drawEdges(edges, nodes, nodeMap, searchTerm, selectedNode, selectedEdges, selectedEdgeIdx, artMode, routedEdges, theme);
    if (allPads) {
      for (const [, { sourcePad, targetPad }] of allPads) {
        drawPad(sourcePad, theme);
        drawPad(targetPad, theme);
      }
    }
  } else {
    drawEdges(edges, nodes, nodeMap, searchTerm, selectedNode, selectedEdges, selectedEdgeIdx, artMode, null, theme);
    drawNodes(nodes, searchTerm, selectedNode, hoveredNode, calleeIds, callerIds, selectedNodes, theme);
  }

  // --- Selection rectangle (AutoCAD style) ---
  if (rectSelecting) {
    const rx = Math.min(rectStartWx, rectCurWx);
    const ry = Math.min(rectStartWy, rectCurWy);
    const rw = Math.abs(rectCurWx - rectStartWx);
    const rh = Math.abs(rectCurWy - rectStartWy);
    const isWindowMode = rectCurWx < rectStartWx;
    // Crossing (L→R): green solid, Window (R→L): blue dashed
    ctx.strokeStyle = isWindowMode ? theme.caller : theme.callee;
    ctx.lineWidth = 1 / scale;
    ctx.setLineDash(isWindowMode ? [4 / scale, 4 / scale] : []);
    ctx.fillStyle = isWindowMode ? withAlpha(theme.caller, 0.08) : withAlpha(theme.callee, 0.08);
    ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.fill(); ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.restore();

  // Stats — skip DOM write if unchanged
  const statsText = `${nodes.length} functions, ${edges.length} connections`;
  if (statsText !== lastStatsText) {
    (document.getElementById('stats') as HTMLElement).textContent = statsText;
    lastStatsText = statsText;
  }
}

// ============================================================
//  SUB-RENDERERS
// ============================================================

const MID_ARROW_INTERVAL = 80; // px between mid-path arrows

function drawEdges(
  edges: any[], nodes: GraphNode[], nodeMap: Map<string, GraphNode>,
  searchTerm: string, selectedNode: GraphNode | null,
  selectedEdges: Set<number>, selectedEdgeIdx: number,
  artMode: boolean, routedEdges: RoutedEdge[] | null,
  theme: Theme
): void {
  const routedMap = new Map<number, RoutedEdge>();
  if (routedEdges) routedEdges.forEach(r => routedMap.set(r.edgeIdx, r));

  for (let ei = 0; ei < edges.length; ei++) {
    const e = edges[ei];
    const a = nodeMap.get(e.source);
    const b = nodeMap.get(e.target);
    if (!a || !b) continue;

    const isSearchHit = searchTerm && (
      a.label.toLowerCase().includes(searchTerm) ||
      b.label.toLowerCase().includes(searchTerm)
    );
    const isSelEdge = selectedEdges.has(ei);
    const isClickedEdge = selectedEdgeIdx === ei;

    // --- Determine stroke style ---
    if (isClickedEdge) {
      ctx.strokeStyle = theme.foreground;
      ctx.lineWidth = artMode ? 4 : 3;
      ctx.globalAlpha = 1;
    } else if (isSelEdge) {
      ctx.strokeStyle = theme.selected;
      ctx.lineWidth = artMode ? 3.5 : 2.5;
      ctx.globalAlpha = 1;
    } else if (isSearchHit) {
      ctx.strokeStyle = theme.search;
      ctx.lineWidth = artMode ? 3 : 2;
      ctx.globalAlpha = 1;
    } else if (artMode) {
      // Color by source file
      ctx.strokeStyle = colorForFile(a.fileName);
      ctx.lineWidth = 2.5;
      ctx.globalAlpha = selectedNode ? 0.15 : 0.75;
    } else {
      ctx.strokeStyle = theme.edgeDefault;
      ctx.lineWidth = 1;
      ctx.globalAlpha = selectedNode ? 0.15 : 1;
    }

    if (artMode) {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const routed = routedMap.get(ei);
      if (routed && routed.path.length >= 2) {
        const path = routed.path;
        // Draw trace line
        ctx.beginPath();
        ctx.moveTo(path[0][0], path[0][1]);
        for (let i = 1; i < path.length; i++) ctx.lineTo(path[i][0], path[i][1]);
        ctx.stroke();

        // Mid-path directional arrows
        const savedAlpha = ctx.globalAlpha;
        ctx.fillStyle = ctx.strokeStyle as string;
        ctx.globalAlpha = Math.min(savedAlpha + 0.15, 1);
        drawMidArrows(path);
        ctx.globalAlpha = savedAlpha;
      }
      ctx.lineCap = 'butt';
      ctx.lineJoin = 'miter';
    } else {
      // Standard straight line with end arrow
      const ax = a.x + a.w / 2, ay = a.y + a.h / 2;
      const bx = b.x + b.w / 2, by = b.y + b.h / 2;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();

      const angle = Math.atan2(by - ay, bx - ax);
      const al = 10;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx - al * Math.cos(angle - 0.4), by - al * Math.sin(angle - 0.4));
      ctx.moveTo(bx, by);
      ctx.lineTo(bx - al * Math.cos(angle + 0.4), by - al * Math.sin(angle + 0.4));
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
  }
}

/** Draw small directional arrows along a polyline path at regular intervals */
function drawMidArrows(path: [number, number][]): void {
  // Walk along the polyline, placing arrows every MID_ARROW_INTERVAL px
  let accumulated = 0;
  const arrowSize = 6;

  for (let i = 0; i < path.length - 1; i++) {
    const [x1, y1] = path[i];
    const [x2, y2] = path[i + 1];
    const dx = x2 - x1, dy = y2 - y1;
    const segLen = Math.sqrt(dx * dx + dy * dy);
    if (segLen < 1) continue;

    const angle = Math.atan2(dy, dx);
    let walked = 0;

    // Check positions along this segment
    while (walked < segLen) {
      const remaining = MID_ARROW_INTERVAL - accumulated;
      if (walked + remaining > segLen) {
        accumulated += segLen - walked;
        break;
      }
      walked += remaining;
      accumulated = 0;

      // Arrow position
      const t = walked / segLen;
      const ax = x1 + t * dx;
      const ay = y1 + t * dy;

      // Draw filled triangle arrow
      ctx.beginPath();
      ctx.moveTo(ax + arrowSize * Math.cos(angle), ay + arrowSize * Math.sin(angle));
      ctx.lineTo(ax - arrowSize * 0.6 * Math.cos(angle - 0.6), ay - arrowSize * 0.6 * Math.sin(angle - 0.6));
      ctx.lineTo(ax - arrowSize * 0.6 * Math.cos(angle + 0.6), ay - arrowSize * 0.6 * Math.sin(angle + 0.6));
      ctx.closePath();
      ctx.fill();
    }
  }
}

function drawNodes(
  nodes: GraphNode[], searchTerm: string,
  selectedNode: GraphNode | null, hoveredNode: GraphNode | null,
  calleeIds: Set<string>, callerIds: Set<string>, selectedNodes: Set<string>,
  theme: Theme
): void {
  for (const n of nodes) {
    if (!inViewport(n.x, n.y, n.w, n.h)) continue;

    const matched = searchTerm && n.label.toLowerCase().includes(searchTerm);
    const dimmed = searchTerm && !matched;
    const isHovered = hoveredNode === n;
    const isSelected = selectedNode === n;
    const isCallee = calleeIds.has(n.id);
    const isCaller = callerIds.has(n.id);
    const isConnected = isCallee || isCaller;
    const isMultiSel = selectedNodes.has(n.id);
    const color = colorForFile(n.fileName);

    // Dim unrelated nodes when a node is selected
    if (dimmed || (selectedNode && !isSelected && !isConnected)) {
      ctx.globalAlpha = 0.15;
    } else {
      ctx.globalAlpha = 1;
    }

    // Glow — only set shadowBlur for highlighted nodes
    ctx.shadowBlur = 0;
    if (isSelected)       { ctx.shadowColor = theme.selected; ctx.shadowBlur = 20; }
    else if (isMultiSel)  { ctx.shadowColor = theme.caller;   ctx.shadowBlur = 16; }
    else if (isCallee)    { ctx.shadowColor = theme.callee;   ctx.shadowBlur = 14; }
    else if (isCaller)    { ctx.shadowColor = theme.caller;   ctx.shadowBlur = 14; }
    else if (isHovered)   { ctx.shadowColor = color;          ctx.shadowBlur = 12; }

    const connColor = isCallee ? theme.callee : isCaller ? theme.caller : color;
    ctx.fillStyle = isSelected  ? theme.fillSelected
                  : isMultiSel  ? theme.fillMultiSel
                  : isConnected ? theme.fillConnected
                  : isHovered   ? theme.fillHover
                  :               theme.fillDefault;
    ctx.strokeStyle = isSelected  ? theme.selected
                    : isMultiSel  ? theme.caller
                    : isConnected ? connColor
                    :               color;
    ctx.lineWidth = isSelected ? 3 : isMultiSel ? 2.5 : isConnected ? 2.5 : isHovered ? 2.5 : 1.5;
    roundRect(n.x, n.y, n.w, n.h, 6);
    ctx.fill(); ctx.stroke();
    ctx.shadowBlur = 0;

    const textColor = isSelected ? theme.selected
                    : isCallee   ? theme.callee
                    : isCaller   ? theme.caller
                    :              theme.foreground;
    ctx.font = `bold ${DEFAULT_FONT}px monospace`;
    ctx.textBaseline = 'middle';
    drawLabelWithAccent(n.label, n.x + n.w / 2, n.y + n.h / 2, textColor, color);
    ctx.globalAlpha = 1;
  }
}

function roundRect(x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/** Draw a small circular pad on the node edge */
function drawPad(pad: Pad, theme: Theme): void {
  const r = 3;
  ctx.fillStyle = theme.padFill;
  ctx.globalAlpha = 0.7;
  ctx.beginPath();
  ctx.arc(pad.x, pad.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}

/**
 * Render a function label centered at (cx, cy).
 * Every uppercase letter is drawn in accentColor; all other characters in textColor.
 * Consecutive same-color characters are batched into a single fillText call.
 */
function drawLabelWithAccent(
  label: string,
  cx: number,
  cy: number,
  textColor: string,
  accentColor: string,
): void {
  // font already set by caller
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  const totalW = ctx.measureText(label).width;
  let x = cx - totalW / 2;

  // Walk through the label, grouping consecutive chars by color
  let seg = '';
  let segIsAccent = label.length > 0 && /[A-Z]/.test(label[0]);

  for (const ch of label) {
    const isAccent = /[A-Z]/.test(ch);
    if (isAccent !== segIsAccent) {
      ctx.fillStyle = segIsAccent ? accentColor : textColor;
      ctx.fillText(seg, x, cy);
      x += ctx.measureText(seg).width;
      seg = ch;
      segIsAccent = isAccent;
    } else {
      seg += ch;
    }
  }
  if (seg.length > 0) {
    ctx.fillStyle = segIsAccent ? accentColor : textColor;
    ctx.fillText(seg, x, cy);
  }

  ctx.textAlign = 'center'; // restore default
}

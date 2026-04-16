/**
 * @module selectionScale
 * @description Visual 150% scaling for selected + connected (caller/callee) nodes.
 *
 * Strategy — pure visual overlay (no mutation of actual node data):
 *   • getVisualBounds(n) returns the screen rect to draw/hit-test.
 *   • Actual n.x / n.y / n.w / n.h are NEVER changed, so drag, layout-restore,
 *     and all other systems continue to work on the true node data.
 *   • Overlap resolution computes per-node extraX/extraY offsets to push scaled
 *     nodes apart; only affected (scaled) nodes are moved — others stay put.
 *
 * Public API:
 *   applySelectionScale(node)  — call when a node becomes selected
 *   clearSelectionScale()      — call when selection is cleared
 *   getVisualBounds(node)      — use instead of n.x/y/w/h for drawing & hit-test
 *   isScaledNode(id)           — true if the node has scaling applied (font size)
 */

import { state, GraphNode } from './state';

// ── Constants ─────────────────────────────────────────────────────────────────

export const SEL_SCALE      = 1.5;   // 150 %
export const DEFAULT_FONT   = 15;    // px  (up from 13)
export const SCALED_FONT    = Math.round(DEFAULT_FONT * SEL_SCALE); // 22 px
const OVERLAP_GAP  = 4;    // minimum spacing between visual boxes
const MAX_ITER     = 8;
const MAX_DISP     = 48;   // max pixels a scaled node can move from its true center

// ── Internal state ────────────────────────────────────────────────────────────

interface ScaleEntry {
  scaledW: number;
  scaledH: number;
  extraX:  number;   // additional positional shift from overlap resolution
  extraY:  number;
}

const entries = new Map<string, ScaleEntry>();

// ── Public API ────────────────────────────────────────────────────────────────

export function isScaledNode(nodeId: string): boolean {
  return entries.has(nodeId);
}

/** Returns the visual bounding box to use for drawing and hit-testing. */
export function getVisualBounds(
  n: GraphNode,
): { x: number; y: number; w: number; h: number } {
  const e = entries.get(n.id);
  if (!e) return { x: n.x, y: n.y, w: n.w, h: n.h };
  const cx = n.x + n.w / 2 + e.extraX;
  const cy = n.y + n.h / 2 + e.extraY;
  return { x: cx - e.scaledW / 2, y: cy - e.scaledH / 2, w: e.scaledW, h: e.scaledH };
}

/** Compute 150% visual overrides for the selected node and its direct callers/callees. */
export function applySelectionScale(selectedNode: GraphNode): void {
  entries.clear();

  const calleeIds = new Set<string>();
  const callerIds = new Set<string>();
  for (const e of state.edges) {
    if (e.source === selectedNode.id) calleeIds.add(e.target);
    if (e.target === selectedNode.id) callerIds.add(e.source);
  }

  const affectedIds = new Set([selectedNode.id, ...calleeIds, ...callerIds]);
  for (const id of affectedIds) {
    const n = state.nodes.find(node => node.id === id);
    if (!n) continue;
    entries.set(id, {
      scaledW: Math.round(n.w * SEL_SCALE),
      scaledH: Math.round(n.h * SEL_SCALE),
      extraX:  0,
      extraY:  0,
    });
  }

  resolveOverlaps(affectedIds);
}

/** Remove all visual overrides — nodes revert to their actual x/y/w/h. */
export function clearSelectionScale(): void {
  entries.clear();
}

// ── Overlap resolution ────────────────────────────────────────────────────────

/**
 * Iteratively push scaled nodes apart until no overlaps remain.
 *
 * Each iteration accumulates deltas for ALL pairs first, then applies them
 * all at once — prevents the same pair from being processed twice (A→B then
 * B→A) and avoids the oscillation / runaway-displacement that single-step
 * application causes.
 *
 * Displacement is capped at MAX_DISP so nodes can never fly to a wrong place.
 */
function resolveOverlaps(affectedIds: Set<string>): void {
  if (affectedIds.size === 0) return;

  const affectedNodes = state.nodes.filter(n => affectedIds.has(n.id));
  const allNodes      = state.nodes;
  const vb = (n: GraphNode) => getVisualBounds(n);
  const g  = OVERLAP_GAP / 2;

  for (let iter = 0; iter < MAX_ITER; iter++) {
    // Accumulated delta for this pass — applied all at once at the end
    const deltas = new Map<string, { dx: number; dy: number }>();
    for (const a of affectedNodes) deltas.set(a.id, { dx: 0, dy: 0 });

    let anyOverlap = false;

    for (let ai = 0; ai < affectedNodes.length; ai++) {
      const a  = affectedNodes[ai];
      const av = vb(a);
      const ax1 = av.x - g, ax2 = av.x + av.w + g;
      const ay1 = av.y - g, ay2 = av.y + av.h + g;

      for (let bi = 0; bi < allNodes.length; bi++) {
        const b = allNodes[bi];
        if (b === a) continue;

        // For affected-vs-affected, only process the pair once (ai < bi)
        const bIsAffected = affectedIds.has(b.id);
        const bAffIdx = bIsAffected ? affectedNodes.indexOf(b) : -1;
        if (bIsAffected && bAffIdx <= ai) continue;

        const bv = vb(b);
        const bx1 = bv.x - g, bx2 = bv.x + bv.w + g;
        const by1 = bv.y - g, by2 = bv.y + bv.h + g;

        if (ax2 <= bx1 || bx2 <= ax1 || ay2 <= by1 || by2 <= ay1) continue;

        // Minimum-penetration-axis push
        const penUp    = ay2 - by1;
        const penDown  = by2 - ay1;
        const penLeft  = ax2 - bx1;
        const penRight = bx2 - ax1;
        const minPen   = Math.min(penUp, penDown, penLeft, penRight);

        let dx = 0, dy = 0;
        if      (minPen === penUp)    dy = -penUp;
        else if (minPen === penDown)  dy =  penDown;
        else if (minPen === penLeft)  dx = -penLeft;
        else                          dx =  penRight;

        const da = deltas.get(a.id)!;
        if (bIsAffected) {
          // Both scaled — share equally; update b's delta too
          da.dx += dx / 2;  da.dy += dy / 2;
          const db = deltas.get(b.id)!;
          db.dx -= dx / 2;  db.dy -= dy / 2;
        } else {
          // Only a is scaled — takes the full push
          da.dx += dx;  da.dy += dy;
        }
        anyOverlap = true;
      }
    }

    if (!anyOverlap) break;

    // Apply deltas with displacement cap
    for (const a of affectedNodes) {
      const ae = entries.get(a.id)!;
      const d  = deltas.get(a.id)!;
      ae.extraX = Math.max(-MAX_DISP, Math.min(MAX_DISP, ae.extraX + d.dx));
      ae.extraY = Math.max(-MAX_DISP, Math.min(MAX_DISP, ae.extraY + d.dy));
    }
  }
}

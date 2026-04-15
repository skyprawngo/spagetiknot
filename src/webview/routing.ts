/**
 * @module routing
 * @description PCB-style trace routing with node pads and collision avoidance.
 *
 * Responsibilities:
 *   - Calculate pad positions on each node (in: left→top, out: right→bottom)
 *   - Route traces between pads using H/V/45° segments
 *   - Avoid routing through other node bounding boxes
 *   - Align parallel traces with consistent offset
 *
 * NOTE: Full grid-based routing (per 트레이스라우팅전략.md) is pending implementation.
 *       Old group-boundary routing has been removed.
 */

import { state, GraphNode, GraphEdge, NODE_H } from './state';

// ============================================================
//  TYPES
// ============================================================

export interface Pad {
  x: number;
  y: number;
  side: 'left' | 'right' | 'top' | 'bottom';
  nodeId: string;
}

export interface RoutedEdge {
  edgeIdx: number;
  path: [number, number][];
  sourcePad: Pad;
  targetPad: Pad;
}

// ============================================================
//  PAD CALCULATION
// ============================================================

const PAD_MIN_SPACING = 10;

/** Compute how many pads fit on a given side length */
function maxPadsOnSide(sideLen: number): number {
  return Math.max(1, Math.floor((sideLen - 4) / PAD_MIN_SPACING));
}

/**
 * Allocate pad positions for all nodes based on their edges.
 * Returns a map: edgeIdx → { sourcePad, targetPad }
 */
export function computeAllPads(): Map<number, { sourcePad: Pad; targetPad: Pad }> {
  const { nodes, edges } = state;
  const nodeMap = new Map<string, GraphNode>();
  nodes.forEach(n => nodeMap.set(n.id, n));

  // Count in-edges (target) and out-edges (source) per node
  const inEdges = new Map<string, number[]>();   // nodeId → edgeIdx[]
  const outEdges = new Map<string, number[]>();

  for (let ei = 0; ei < edges.length; ei++) {
    const e = edges[ei];
    if (!nodeMap.has(e.source) || !nodeMap.has(e.target)) continue;

    if (!outEdges.has(e.source)) outEdges.set(e.source, []);
    outEdges.get(e.source)!.push(ei);

    if (!inEdges.has(e.target)) inEdges.set(e.target, []);
    inEdges.get(e.target)!.push(ei);
  }

  const padMap = new Map<number, { sourcePad: Pad; targetPad: Pad }>();

  // Compute in-pads (left → top overflow)
  const inPadsByNode = new Map<string, Pad[]>();
  for (const [nodeId, edgeIdxs] of inEdges) {
    const n = nodeMap.get(nodeId)!;
    const pads = allocatePads(n, edgeIdxs.length, 'in');
    inPadsByNode.set(nodeId, pads);
  }

  // Compute out-pads (right → bottom overflow)
  const outPadsByNode = new Map<string, Pad[]>();
  for (const [nodeId, edgeIdxs] of outEdges) {
    const n = nodeMap.get(nodeId)!;
    const pads = allocatePads(n, edgeIdxs.length, 'out');
    outPadsByNode.set(nodeId, pads);
  }

  // Assign pads to edges
  const inPadIdx = new Map<string, number>();
  const outPadIdx = new Map<string, number>();

  for (let ei = 0; ei < edges.length; ei++) {
    const e = edges[ei];
    if (!nodeMap.has(e.source) || !nodeMap.has(e.target)) continue;

    // Source out-pad
    const srcPads = outPadsByNode.get(e.source);
    if (!srcPads || srcPads.length === 0) continue;
    const si = outPadIdx.get(e.source) || 0;
    const sourcePad = srcPads[Math.min(si, srcPads.length - 1)];
    outPadIdx.set(e.source, si + 1);

    // Target in-pad
    const tgtPads = inPadsByNode.get(e.target);
    if (!tgtPads || tgtPads.length === 0) continue;
    const ti = inPadIdx.get(e.target) || 0;
    const targetPad = tgtPads[Math.min(ti, tgtPads.length - 1)];
    inPadIdx.set(e.target, ti + 1);

    padMap.set(ei, { sourcePad, targetPad });
  }

  return padMap;
}

function allocatePads(node: GraphNode, count: number, direction: 'in' | 'out'): Pad[] {
  if (count === 0) return [];

  const primarySide = direction === 'in' ? 'left' : 'right';
  const overflowSide = direction === 'in' ? 'top' : 'bottom';

  // Primary side: left or right (vertical edge of the node)
  const primaryLen = node.h;
  const maxPrimary = maxPadsOnSide(primaryLen);
  const primaryCount = Math.min(count, maxPrimary);
  const overflowCount = count - primaryCount;

  const pads: Pad[] = [];

  // Primary pads along left/right edge
  for (let i = 0; i < primaryCount; i++) {
    const t = (i + 1) / (primaryCount + 1);
    const py = node.y + t * node.h;
    const px = primarySide === 'left' ? node.x : node.x + node.w;
    pads.push({ x: px, y: py, side: primarySide, nodeId: node.id });
  }

  // Overflow pads along top/bottom edge
  if (overflowCount > 0) {
    const overflowLen = node.w;
    const actualOverflow = Math.min(overflowCount, maxPadsOnSide(overflowLen));
    for (let i = 0; i < actualOverflow; i++) {
      const t = (i + 1) / (actualOverflow + 1);
      const px = node.x + t * node.w;
      const py = overflowSide === 'top' ? node.y : node.y + node.h;
      pads.push({ x: px, y: py, side: overflowSide, nodeId: node.id });
    }
  }

  return pads;
}

// ============================================================
//  STUB: Grid-based trace routing (TODO)
// ============================================================

/**
 * Route all edges for a single file group (Phase 1 — local grid).
 * Currently a stub that returns straight pad-to-pad lines.
 */
export function routeGroupEdges(groupFileName: string): RoutedEdge[] {
  const padMap = computeAllPads();
  const { nodes, edges } = state;
  const nodeMap = new Map<string, GraphNode>();
  nodes.forEach(n => nodeMap.set(n.id, n));

  const routed: RoutedEdge[] = [];

  for (let ei = 0; ei < edges.length; ei++) {
    const e = edges[ei];
    const srcNode = nodeMap.get(e.source);
    const tgtNode = nodeMap.get(e.target);
    if (!srcNode || !tgtNode) continue;

    // Only internal edges for this group
    if (srcNode.fileName !== groupFileName || tgtNode.fileName !== groupFileName) continue;

    const pads = padMap.get(ei);
    if (!pads) continue;
    const { sourcePad, targetPad } = pads;

    // Stub: straight line from pad to pad
    const path: [number, number][] = [[sourcePad.x, sourcePad.y], [targetPad.x, targetPad.y]];
    routed.push({ edgeIdx: ei, path, sourcePad, targetPad });
  }

  return routed;
}

/**
 * Route all edges (both internal and external).
 * Currently a stub that returns straight pad-to-pad lines.
 */
export function routeAllEdges(): RoutedEdge[] {
  const padMap = computeAllPads();
  const { nodes, edges } = state;
  const nodeMap = new Map<string, GraphNode>();
  nodes.forEach(n => nodeMap.set(n.id, n));

  const routed: RoutedEdge[] = [];

  for (let ei = 0; ei < edges.length; ei++) {
    const pads = padMap.get(ei);
    if (!pads) continue;
    const { sourcePad, targetPad } = pads;

    // Stub: straight line from pad to pad
    const path: [number, number][] = [[sourcePad.x, sourcePad.y], [targetPad.x, targetPad.y]];
    routed.push({ edgeIdx: ei, path, sourcePad, targetPad });
  }

  return routed;
}

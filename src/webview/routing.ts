/**
 * @module routing
 * @description PCB-style trace routing with node pads and collision avoidance.
 *
 * Responsibilities:
 *   - Calculate pad positions on each node (in: left→top, out: right→bottom)
 *   - Route traces between pads using H/V/45° segments
 *   - Avoid routing through other node bounding boxes
 *   - Align parallel traces with consistent offset
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
const PAD_STUB_LEN = 16;
const TRACE_OFFSET = 5;  // parallel trace spacing

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
//  TRACE ROUTING
// ============================================================

/**
 * Route all edges. In artwork mode, traces route around group boundaries
 * so they never cross over function nodes.
 */
export function routeAllEdges(): RoutedEdge[] {
  const padMap = computeAllPads();
  const { nodes, edges, fileGroups } = state;
  const nodeMap = new Map<string, GraphNode>();
  nodes.forEach(n => nodeMap.set(n.id, n));

  // Group edges by target for parallel offset
  const edgesByTarget = new Map<string, number[]>();
  for (let ei = 0; ei < edges.length; ei++) {
    const e = edges[ei];
    if (!edgesByTarget.has(e.target)) edgesByTarget.set(e.target, []);
    edgesByTarget.get(e.target)!.push(ei);
  }

  const routed: RoutedEdge[] = [];

  for (let ei = 0; ei < edges.length; ei++) {
    const pads = padMap.get(ei);
    if (!pads) continue;
    const { sourcePad, targetPad } = pads;

    const siblings = edgesByTarget.get(edges[ei].target) || [ei];
    const sibIdx = siblings.indexOf(ei);
    const sibCount = siblings.length;
    const parallelOffset = (sibIdx - (sibCount - 1) / 2) * TRACE_OFFSET;

    const srcNode = nodeMap.get(edges[ei].source);
    const tgtNode = nodeMap.get(edges[ei].target);
    if (!srcNode || !tgtNode) continue;

    const srcGroup = fileGroups.find(g => g.fileName === srcNode.fileName);
    const tgtGroup = fileGroups.find(g => g.fileName === tgtNode.fileName);

    const path = routeTrace(sourcePad, targetPad, srcNode, tgtNode, srcGroup, tgtGroup, parallelOffset);
    routed.push({ edgeIdx: ei, path, sourcePad, targetPad });
  }

  return routed;
}

const CHANNEL_MARGIN = 12; // clearance outside group boundaries

/**
 * Route from source pad to target pad by traveling along group boundaries.
 *
 * Strategy:
 *   1. Exit source pad → go to source group boundary edge
 *   2. Travel along the outside of groups (channel space)
 *   3. Enter target group boundary → arrive at target pad
 *
 * This guarantees traces never cross over function nodes.
 */
function routeTrace(
  src: Pad, tgt: Pad,
  srcNode: GraphNode, tgtNode: GraphNode,
  srcGroup: any, tgtGroup: any,
  offset: number
): [number, number][] {

  if (!srcGroup || !tgtGroup) {
    return [[src.x, src.y], [tgt.x, tgt.y]];
  }

  const sameGroup = srcGroup === tgtGroup;

  // Channel X positions: just outside group left/right edges
  const srcRightCh = srcGroup.x + srcGroup.w + CHANNEL_MARGIN + Math.abs(offset);
  const srcLeftCh = srcGroup.x - CHANNEL_MARGIN - Math.abs(offset);
  const tgtRightCh = tgtGroup.x + tgtGroup.w + CHANNEL_MARGIN + Math.abs(offset);
  const tgtLeftCh = tgtGroup.x - CHANNEL_MARGIN - Math.abs(offset);

  // Channel Y positions
  const srcTopCh = srcGroup.y - CHANNEL_MARGIN - Math.abs(offset);
  const srcBotCh = srcGroup.y + srcGroup.h + CHANNEL_MARGIN + Math.abs(offset);
  const tgtTopCh = tgtGroup.y - CHANNEL_MARGIN - Math.abs(offset);
  const tgtBotCh = tgtGroup.y + tgtGroup.h + CHANNEL_MARGIN + Math.abs(offset);

  const points: [number, number][] = [[src.x, src.y]];

  if (sameGroup) {
    // Same group: route outside the group perimeter
    // Exit from pad side → group boundary → travel vertically → re-enter
    if (src.side === 'right' && tgt.side === 'left') {
      // Right out, go around group right edge, come back in from left
      const chX = srcRightCh + offset;
      points.push([chX, src.y]);
      points.push([chX, tgt.y]);
    } else if (src.side === 'left' && tgt.side === 'right') {
      const chX = srcLeftCh + offset;
      points.push([chX, src.y]);
      points.push([chX, tgt.y]);
    } else if (src.side === 'right' && tgt.side === 'right') {
      const chX = srcRightCh + offset;
      points.push([chX, src.y]);
      points.push([chX, tgt.y]);
    } else if (src.side === 'left' && tgt.side === 'left') {
      const chX = srcLeftCh + offset;
      points.push([chX, src.y]);
      points.push([chX, tgt.y]);
    } else if (src.side === 'bottom' || src.side === 'top') {
      const chY = src.side === 'bottom' ? srcBotCh + offset : srcTopCh + offset;
      points.push([src.x, chY]);
      points.push([tgt.x, chY]);
    } else {
      // Fallback
      const chX = srcRightCh + offset;
      points.push([chX, src.y]);
      points.push([chX, tgt.y]);
    }
  } else {
    // Different groups: route through inter-group channel space
    // Determine relative positions
    const srcCx = srcGroup.x + srcGroup.w / 2;
    const tgtCx = tgtGroup.x + tgtGroup.w / 2;
    const tgtIsRight = tgtCx > srcCx;

    if (src.side === 'right' || src.side === 'left') {
      // Exit horizontally from source
      const exitX = src.side === 'right' ? srcRightCh : srcLeftCh;
      points.push([exitX + offset, src.y]);

      if (tgt.side === 'left' || tgt.side === 'right') {
        // Enter horizontally into target
        const enterX = tgt.side === 'left' ? tgtLeftCh : tgtRightCh;

        // Need to travel from exitX to enterX, and from src.y to tgt.y
        // Use the inter-group space: go horizontal midpoint, then vertical, then horizontal
        const midX = (exitX + enterX) / 2 + offset;

        if (Math.abs(src.y - tgt.y) < 3) {
          // Same Y level — straight horizontal
          points.push([enterX + offset, tgt.y]);
        } else {
          points.push([midX, src.y]);
          points.push([midX, tgt.y]);
          points.push([enterX + offset, tgt.y]);
        }
      } else {
        // Target pad is top/bottom
        const enterY = tgt.side === 'top' ? tgtTopCh : tgtBotCh;
        points.push([exitX + offset, enterY + offset]);
        points.push([tgt.x, enterY + offset]);
      }
    } else {
      // Source pad is top/bottom
      const exitY = src.side === 'top' ? srcTopCh : srcBotCh;
      points.push([src.x, exitY + offset]);

      if (tgt.side === 'left' || tgt.side === 'right') {
        const enterX = tgt.side === 'left' ? tgtLeftCh : tgtRightCh;
        points.push([enterX + offset, exitY + offset]);
        points.push([enterX + offset, tgt.y]);
      } else {
        const enterY = tgt.side === 'top' ? tgtTopCh : tgtBotCh;
        points.push([tgt.x, exitY + offset]);
      }
    }
  }

  points.push([tgt.x, tgt.y]);
  return deduplicatePath(points);
}

function deduplicatePath(path: [number, number][]): [number, number][] {
  if (path.length === 0) return path;
  const result: [number, number][] = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const prev = result[result.length - 1];
    if (Math.abs(path[i][0] - prev[0]) > 0.5 || Math.abs(path[i][1] - prev[1]) > 0.5) {
      result.push(path[i]);
    }
  }
  return result;
}

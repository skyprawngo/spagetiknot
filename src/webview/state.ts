/** Shared mutable state for the webview canvas application. */

export interface GraphNode {
  id: string;
  label: string;
  file: string;
  fileName: string;
  line: number;
  params: string[];
  comment: string;
  x: number;
  y: number;
  w: number;
  h: number;
  _dx?: number;
  _dy?: number;
  _moved?: boolean;
}

export interface GraphEdge {
  source: string;
  target: string;
  args: string[];
  params: string[];
}

/** A call from a project function to an external library function (popover-only). */
export interface ExternalCallee {
  name: string;     // alias used in source (e.g. 'http_get' or 'requests.get')
  realName: string; // original exported name (e.g. 'get')
  module: string;   // library name (e.g. 'requests', 'axios')
}

export interface FileGroup {
  fileName: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CustomSnapshot {
  groups: { fileName: string; x: number; y: number; w: number; h: number }[];
  nodes: { id: string; x: number; y: number; w: number; h: number }[];
  modes: [string, string][];
}

export const state = {
  targetDir: '' as string,
  nodes: [] as GraphNode[],
  edges: [] as GraphEdge[],
  /** nodeId → list of external library callees (for popover display only) */
  externalCallMap: new Map<string, ExternalCallee[]>(),
  fileGroups: [] as FileGroup[],
  groupLayoutModes: new Map<string, string>(),

  width: 0,
  height: 0,
  offsetX: 0,
  offsetY: 0,
  scale: 1,

  // Interaction state
  panning: false,
  panStartX: 0,
  panStartY: 0,
  dragNode: null as GraphNode | null,
  hoveredNode: null as GraphNode | null,
  searchTerm: '',
  selectedNode: null as GraphNode | null,
  selectedEdgeIdx: -1,
  artworkLineMode: false,
  cachedRoutes: null as any[] | null,  // RoutedEdge[] cache for hit-test
  cachedPads: null as Map<number, { sourcePad: any; targetPad: any }> | null,
  debugRoutedGroups: new Set<string>(),  // groups with debug routing active

  // Group resize
  resizingGroup: null as FileGroup | null,
  resizeEdge: '',
  resizeStartX: 0,
  resizeStartY: 0,
  resizeOrigW: 0,
  resizeOrigH: 0,

  // Group drag
  draggingGroup: null as FileGroup | null,
  dragGroupDx: 0,
  dragGroupDy: 0,

  // Rectangle selection
  rectSelecting: false,
  rectStartWx: 0,
  rectStartWy: 0,
  rectCurWx: 0,
  rectCurWy: 0,
  selectedNodes: new Set<string>(),
  selectedGroupNames: new Set<string>(),

  // Batch drag
  batchDragging: false,
  batchDragStartWx: 0,
  batchDragStartWy: 0,

  // Custom layout
  customSnapshot: null as CustomSnapshot | null,
};

// Layout constants
export const NODE_W     = 140; // minimum / fallback width
export const NODE_W_MAX = 400; // maximum width (very long names capped here)
export const NODE_H     = 36;  // single-row height (filename row removed)
export const GROUP_PAD = 16;
export const GROUP_HEADER = 30;
export const GROUP_GAP_X = 40;
export const GROUP_GAP_Y = 30;
export const NODE_GAP = 8;
export const RESIZE_MARGIN = 8;
export const EDGE_HIT_DIST = 6;
export const GROUP_BTN_SIZE = 18;

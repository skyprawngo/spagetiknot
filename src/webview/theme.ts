/**
 * @module theme
 * @description Reads VSCode CSS custom properties at draw-time and provides
 * a typed Theme object for canvas rendering.
 *
 * All colors in canvas.ts come from here — no hardcoded hex in the renderer.
 * CSS custom properties (--sk-*, --vscode-*) are defined in styles.css and
 * automatically reflect the active VSCode colour theme.
 */

// ── CSS variable reader ───────────────────────────────────────────────────────

const _root = () => document.body;

function cssVar(name: string, fallback = ''): string {
  return getComputedStyle(_root()).getPropertyValue(name).trim() || fallback;
}

// ── Color parsing / blending ──────────────────────────────────────────────────

/** Parse a CSS color string into [r, g, b] (0-255). Handles #rgb, #rrggbb, rgb(), rgba(). */
function parseRgb(color: string): [number, number, number] | null {
  const s = color.trim();
  if (s.startsWith('#')) {
    const h = s.slice(1);
    if (h.length === 3 || h.length === 4) {
      return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
    }
    if (h.length >= 6) {
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
  }
  const m = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) return [+m[1], +m[2], +m[3]];
  return null;
}

/** Alpha-blend `fg` over `bg` at opacity `a` (0–1). Returns `rgb(r,g,b)` string. */
function blend(bg: string, fg: string, a: number): string {
  const b = parseRgb(bg);
  const f = parseRgb(fg);
  if (!b || !f) return fg;
  return `rgb(${Math.round(b[0] * (1 - a) + f[0] * a)},${Math.round(b[1] * (1 - a) + f[1] * a)},${Math.round(b[2] * (1 - a) + f[2] * a)})`;
}

/** Convert a color string to `rgba(r,g,b,alpha)`. */
export function withAlpha(color: string, alpha: number): string {
  const p = parseRgb(color);
  if (!p) return color;
  return `rgba(${p[0]},${p[1]},${p[2]},${alpha})`;
}

// ── Theme interface ───────────────────────────────────────────────────────────

export interface Theme {
  // Semantic accent colours
  selected:     string;  // selected node / edge   (yellow)
  callee:       string;  // callee connections      (green)
  caller:       string;  // caller connections      (cyan/blue)
  search:       string;  // search match            (orange)
  error:        string;  // delete / error          (red)

  // Node fill states (pre-blended with the editor background)
  fillDefault:   string;
  fillHover:     string;
  fillSelected:  string;
  fillMultiSel:  string;
  fillConnected: string;

  // General canvas colours
  background:  string;
  foreground:  string;
  edgeDefault: string;  // non-highlighted edges
  padFill:     string;  // artwork-mode pad dots

  // Colour palette for auto-assigning file group colours
  palette: string[];
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Build a Theme from the current VSCode CSS variables.
 * Call once per draw() so colours stay in sync if the user switches theme.
 */
export function getTheme(): Theme {
  const bg       = cssVar('--vscode-editor-background', '#1e1e1e');
  const fg       = cssVar('--vscode-editor-foreground', '#cccccc');
  const selected = cssVar('--sk-accent-selected', '#ffd54f');
  const callee   = cssVar('--sk-accent-callee',   '#81c784');
  const caller   = cssVar('--sk-accent-caller',   '#4fc3f7');
  const search   = cssVar('--sk-accent-search',   '#ffb74d');
  const error    = cssVar('--sk-error',            '#e57373');

  // Node fills: alpha-blend the accent over the editor background
  const fillDefault   = bg;
  const fillHover     = cssVar('--vscode-list-hoverBackground')     || blend(bg, fg,       0.07);
  const fillSelected  = cssVar('--vscode-list-activeSelectionBackground')   || blend(bg, selected, 0.20);
  const fillMultiSel  = cssVar('--vscode-list-inactiveSelectionBackground') || blend(bg, caller,   0.20);
  const fillConnected = blend(bg, callee, 0.09);

  // Edge default: foreground at low opacity
  const fgRgb = parseRgb(fg);
  const edgeDefault = fgRgb
    ? `rgba(${fgRgb[0]},${fgRgb[1]},${fgRgb[2]},0.30)`
    : 'rgba(150,150,150,0.30)';

  const palette = [
    cssVar('--vscode-charts-blue',   '#4fc3f7'),
    cssVar('--vscode-charts-green',  '#81c784'),
    cssVar('--vscode-charts-orange', '#ffb74d'),
    cssVar('--vscode-charts-red',    '#e57373'),
    cssVar('--vscode-charts-purple', '#ba68c8'),
    '#4dd0e1', '#aed581', '#ff8a65', '#f06292', '#7986cb', '#a1887f', '#90a4ae',
  ];

  return {
    selected, callee, caller, search, error,
    fillDefault, fillHover, fillSelected, fillMultiSel, fillConnected,
    background: bg,
    foreground: fg,
    edgeDefault,
    padFill: fg,
    palette,
  };
}

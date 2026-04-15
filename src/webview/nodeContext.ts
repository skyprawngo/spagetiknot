/**
 * @module nodeContext
 * @description Stackable popover for function nodes (3-column layout).
 *
 * Stack behaviour:
 *   - show()         → push a new popover onto the stack
 *   - click outside  → pop (remove) the top popover only
 *   - Escape         → pop all popovers
 *   - Cmd+click item → copy filepath:functionname, no push
 *   - click item     → push new popover for that function
 */

import { state, GraphNode } from './state';
import { scheduleDraw } from './canvas';
import { postMessage } from './messaging';

/** Live stack of popover DOM elements (bottom → top). */
const stack: HTMLElement[] = [];

// ── Public API ─────────────────────────────────────────────────────────────

export function setupNodeContext(): void {
  // Click outside top popover → pop it
  document.addEventListener('mousedown', (e) => {
    if (stack.length === 0) return;
    const top = stack[stack.length - 1];
    if (!top.contains(e.target as Node)) {
      popTop();
    }
  });

  // Escape → clear entire stack
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') popAll();
  });
}

/** Push a new popover for the given node onto the stack. */
export function show(node: GraphNode, clientX: number, clientY: number): void {
  const el = buildPopoverEl();
  populatePopover(el, node);
  document.body.appendChild(el);

  // z-index increases with stack depth so newer is always on top
  const depth = stack.length;
  el.style.zIndex = String(100 + depth);
  stack.push(el);

  // Position off-screen first, then snap in after measure
  el.style.left = '-9999px';
  el.style.top  = '-9999px';

  requestAnimationFrame(() => {
    // If caller/callee lists overflow their container, switch to 2-column grid
    const callerList = el.querySelector('.nc-caller-list') as HTMLElement | null;
    const calleeList = el.querySelector('.nc-callee-list') as HTMLElement | null;
    if (callerList && callerList.scrollHeight > callerList.clientHeight) {
      callerList.classList.add('nc-list-2col');
    }
    if (calleeList && calleeList.scrollHeight > calleeList.clientHeight) {
      calleeList.classList.add('nc-list-2col');
    }

    const pw = el.offsetWidth;
    const ph = el.offsetHeight;
    // Cascade: each new popover offset slightly down
    const cascade = depth * 22;
    // Center column 2 (160 px, centered in the popover) directly below the cursor
    let x = clientX - pw / 2;
    let y = clientY + 14 + cascade;
    x = Math.max(8, Math.min(x, window.innerWidth - pw - 8));
    if (y + ph > window.innerHeight - 8) y = Math.max(8, clientY - ph - 14);
    el.style.left = x + 'px';
    el.style.top  = y + 'px';
  });
}

/** Pop (close) the top popover. */
export function hide(): void {
  popTop();
}

// ── Internal helpers ────────────────────────────────────────────────────────

function popTop(): void {
  const top = stack.pop();
  if (top) top.remove();
}

function popAll(): void {
  for (const el of [...stack]) el.remove();
  stack.length = 0;
}

function buildPopoverEl(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'nc-popover';
  el.innerHTML = `
    <span class="nc-close-btn">&times;</span>
    <div class="nc-body">
      <div class="nc-col nc-col-caller">
        <div class="nc-col-label caller">Caller&ensp;<span class="nc-caller-count">0</span></div>
        <div class="nc-list nc-caller-list"></div>
      </div>
      <div class="nc-col nc-col-center">
        <div class="nc-center-top">
          <div class="nc-title"></div>
          <div class="nc-subtitle"></div>
        </div>
        <div class="nc-center-divider"></div>
        <div class="nc-center-bottom">
          <div class="nc-comment"></div>
        </div>
      </div>
      <div class="nc-col nc-col-callee">
        <div class="nc-col-label callee">Callee&ensp;<span class="nc-callee-count">0</span></div>
        <div class="nc-list nc-callee-list"></div>
      </div>
    </div>`;

  el.querySelector('.nc-close-btn')!.addEventListener('click', (e) => {
    e.stopPropagation();
    // Remove this specific popover (may not be the top)
    const idx = stack.indexOf(el);
    if (idx !== -1) stack.splice(idx, 1);
    el.remove();
  });

  return el;
}

function populatePopover(el: HTMLElement, node: GraphNode): void {
  // Build caller/callee sets
  const nodeMap = new Map(state.nodes.map(n => [n.id, n]));
  const callerMap = new Map<string, GraphNode>();
  const calleeMap = new Map<string, GraphNode>();

  for (const e of state.edges) {
    if (e.target === node.id) {
      const n = nodeMap.get(e.source);
      if (n && n !== node) callerMap.set(n.id, n);
    }
    if (e.source === node.id) {
      const n = nodeMap.get(e.target);
      if (n && n !== node) calleeMap.set(n.id, n);
    }
  }

  const callers = [...callerMap.values()];
  const callees = [...calleeMap.values()];

  // Center column
  (el.querySelector('.nc-title') as HTMLElement).textContent = node.label;
  (el.querySelector('.nc-subtitle') as HTMLElement).textContent =
    `${node.fileName} : ${node.line + 1}`;

  const commentEl = el.querySelector('.nc-comment') as HTMLElement;
  if (node.comment) {
    commentEl.textContent = node.comment;
    commentEl.className = 'nc-comment has-comment';
  } else {
    commentEl.textContent = '// 주석없음';
    commentEl.className = 'nc-comment no-comment';
  }

  // Counts
  (el.querySelector('.nc-caller-count') as HTMLElement).textContent = String(callers.length);
  (el.querySelector('.nc-callee-count') as HTMLElement).textContent = String(callees.length);

  // Lists
  renderList(el.querySelector('.nc-caller-list')!, callers, 'caller');
  renderList(el.querySelector('.nc-callee-list')!, callees, 'callee');
}

function renderList(
  container: Element,
  nodes: GraphNode[],
  kind: 'caller' | 'callee',
): void {
  container.innerHTML = '';

  if (nodes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'nc-empty';
    empty.textContent = '없음';
    container.appendChild(empty);
    return;
  }

  for (const n of nodes) {
    const item = document.createElement('div');
    item.className = `nc-item ${kind}`;
    item.innerHTML =
      `<span class="nc-fn-name">${escHtml(n.label)}</span>` +
      `<span class="nc-fn-file">${escHtml(n.fileName)}</span>`;

    item.addEventListener('click', (e) => {
      e.stopPropagation(); // prevent the outside-click handler from popping

      if (e.metaKey) {
        // Cmd+click → copy filepath:functionname
        postMessage({ command: 'copyToClipboard', text: `${n.file}:${n.label}` });
        return;
      }

      // Regular click → push new popover for this function
      state.selectedNode = n;
      scheduleDraw();
      show(n, e.clientX, e.clientY);
    });

    container.appendChild(item);
  }
}

function centerOn(node: GraphNode): void {
  state.offsetX = state.width  / 2 - (node.x + node.w / 2) * state.scale;
  state.offsetY = state.height / 2 - (node.y + node.h / 2) * state.scale;
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

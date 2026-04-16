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
 *
 * External callees (library functions) appear at the bottom of the Callee column.
 * Clicking one shows a 1-column external-function popover.
 */

import { state, GraphNode, ExternalCallee } from './state';
import { scheduleDraw } from './canvas';
import { postMessage } from './messaging';

/** Pending async hover requests: requestId → hover content element. */
const pendingHovers = new Map<string, HTMLElement>();
let hoverReqCounter = 0;

/** Live stack of popover DOM elements (bottom → top). */
const stack: HTMLElement[] = [];

/** Returns true if one or more popovers are currently open. */
export function hasPopovers(): boolean {
  return stack.length > 0;
}

// ── Public API ─────────────────────────────────────────────────────────────

export function setupNodeContext(): void {
  document.addEventListener('mousedown', (e) => {
    if (stack.length === 0) return;
    const top = stack[stack.length - 1];
    if (!top.contains(e.target as Node)) popTop();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') popAll();
  });
}

/** Push a new 3-column project-function popover onto the stack. */
export function show(node: GraphNode, clientX: number, clientY: number): void {
  if (stack.some(el => el.dataset.nodeId === node.id)) return;

  const el = buildPopoverEl(node.id);
  populatePopover(el, node);
  document.body.appendChild(el);

  const depth = stack.length;
  el.style.zIndex = String(100 + depth);
  stack.push(el);

  positionPopover(el, clientX, clientY, depth);
}

/** Pop (close) the top popover. */
export function hide(): void {
  popTop();
}

// ── Internal helpers ────────────────────────────────────────────────────────

function popTop(): void {
  const top = stack.pop();
  if (!top) return;
  top.remove();

  if (stack.length > 0) {
    const nodeId = stack[stack.length - 1].dataset.nodeId;
    const node = nodeId ? state.nodes.find(n => n.id === nodeId) : undefined;
    if (node) { state.selectedNode = node; scheduleDraw(); }
  } else {
    state.selectedNode = null;
    scheduleDraw();
  }
}

function popAll(): void {
  for (const el of [...stack]) el.remove();
  stack.length = 0;
  state.selectedNode = null;
  scheduleDraw();
}

function positionPopover(el: HTMLElement, clientX: number, clientY: number, depth: number): void {
  el.style.left = '-9999px';
  el.style.top  = '-9999px';

  requestAnimationFrame(() => {
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
    const cascade = depth * 22;
    let x = clientX - pw / 2;
    let y = clientY + 14 + cascade;
    x = Math.max(8, Math.min(x, window.innerWidth - pw - 8));
    if (y + ph > window.innerHeight - 8) y = Math.max(8, clientY - ph - 14);
    el.style.left = x + 'px';
    el.style.top  = y + 'px';
  });
}

// ── 3-column project-function popover ──────────────────────────────────────

function buildPopoverEl(nodeId: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'nc-popover';
  el.dataset.nodeId = nodeId;
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
    const idx = stack.indexOf(el);
    if (idx !== -1) stack.splice(idx, 1);
    el.remove();
  });

  return el;
}

function populatePopover(el: HTMLElement, node: GraphNode): void {
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
  const extCallees = state.externalCallMap.get(node.id) || [];

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

  const totalCalleeCount = callees.length + extCallees.length;
  (el.querySelector('.nc-caller-count') as HTMLElement).textContent = String(callers.length);
  (el.querySelector('.nc-callee-count') as HTMLElement).textContent = String(totalCalleeCount);

  renderCallerList(el.querySelector('.nc-caller-list')!, callers);
  renderCalleeList(el.querySelector('.nc-callee-list')!, callees, extCallees, node.id);
}

function renderCallerList(container: Element, nodes: GraphNode[]): void {
  container.innerHTML = '';
  if (nodes.length === 0) {
    appendEmpty(container);
    return;
  }
  for (const n of nodes) {
    container.appendChild(makeProjectItem(n, 'caller'));
  }
}

function renderCalleeList(
  container: Element,
  nodes: GraphNode[],
  extCallees: ExternalCallee[],
  callerNodeId: string,
): void {
  container.innerHTML = '';
  const hasAny = nodes.length > 0 || extCallees.length > 0;
  if (!hasAny) { appendEmpty(container); return; }

  for (const n of nodes) {
    container.appendChild(makeProjectItem(n, 'callee'));
  }

  // Divider before external callees
  if (extCallees.length > 0 && nodes.length > 0) {
    const div = document.createElement('div');
    div.className = 'nc-ext-divider';
    container.appendChild(div);
  }

  for (const ext of extCallees) {
    container.appendChild(makeExternalItem(ext, callerNodeId));
  }
}

function makeProjectItem(n: GraphNode, kind: 'caller' | 'callee'): HTMLElement {
  const item = document.createElement('div');
  item.className = `nc-item ${kind}`;
  item.innerHTML =
    `<span class="nc-fn-name">${escHtml(n.label)}</span>` +
    `<span class="nc-fn-file">${escHtml(n.fileName)}</span>`;

  item.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.metaKey) {
      postMessage({ command: 'copyToClipboard', text: `${n.file}:${n.label}` });
      return;
    }
    state.selectedNode = n;
    scheduleDraw();
    show(n, e.clientX, e.clientY);
  });
  return item;
}

function makeExternalItem(ext: ExternalCallee, callerNodeId: string): HTMLElement {
  const item = document.createElement('div');
  item.className = 'nc-item nc-item-ext';
  item.innerHTML =
    `<span class="nc-fn-name">${escHtml(ext.name)}</span>` +
    `<span class="nc-ext-badge">${escHtml(ext.module)}</span>`;

  item.addEventListener('click', (e) => {
    e.stopPropagation();
    showExternalPopover(ext, callerNodeId, e.clientX, e.clientY);
  });
  return item;
}

function appendEmpty(container: Element): void {
  const empty = document.createElement('div');
  empty.className = 'nc-empty';
  empty.textContent = '없음';
  container.appendChild(empty);
}

// ── 1-column external-function popover ─────────────────────────────────────

function showExternalPopover(
  ext: ExternalCallee,
  callerNodeId: string,
  clientX: number,
  clientY: number,
): void {
  const el = document.createElement('div');
  el.className = 'nc-popover nc-ext-popover';

  const aliasLine = ext.name !== ext.realName
    ? `<div class="nc-ext-alias">alias of <code>${escHtml(ext.realName)}</code></div>`
    : '';

  el.innerHTML = `
    <span class="nc-close-btn">&times;</span>
    <div class="nc-ext-body">
      <div class="nc-ext-module-badge">${escHtml(ext.module)}</div>
      <div class="nc-ext-fn-name">${escHtml(ext.name)}</div>
      ${aliasLine}
      <div class="nc-ext-note">외부 라이브러리 함수</div>
      <div class="nc-ext-hover loading">타입 정보 불러오는 중…</div>
    </div>`;

  el.querySelector('.nc-close-btn')!.addEventListener('click', (e) => {
    e.stopPropagation();
    const idx = stack.indexOf(el);
    if (idx !== -1) stack.splice(idx, 1);
    el.remove();
  });

  document.body.appendChild(el);
  const depth = stack.length;
  el.style.zIndex = String(100 + depth);
  stack.push(el);

  positionPopover(el, clientX, clientY, depth);

  // Request hover info from extension host
  const requestId = String(++hoverReqCounter);
  const hoverEl = el.querySelector('.nc-ext-hover') as HTMLElement;
  pendingHovers.set(requestId, hoverEl);
  postMessage({
    command: 'getHoverInfo',
    requestId,
    callerNodeId,
    name: ext.name,
    realName: ext.realName,
    module: ext.module,
  });
}

/** Called by main.ts when the extension host returns hover content. */
export function applyHoverResult(requestId: string, content: string): void {
  const hoverEl = pendingHovers.get(requestId);
  if (!hoverEl) return;
  pendingHovers.delete(requestId);

  if (!content) {
    hoverEl.className = 'nc-ext-hover empty';
    hoverEl.textContent = '타입 정보 없음';
  } else {
    hoverEl.className = 'nc-ext-hover';
    hoverEl.textContent = content;
  }
}

// ── Utilities ───────────────────────────────────────────────────────────────

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

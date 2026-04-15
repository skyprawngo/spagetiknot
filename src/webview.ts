import * as vscode from 'vscode';
import * as path from 'path';
import { FunctionInfo } from './parser';
import { FlowEdge, nodeId } from './references';

export function createFlowPanel(
  context: vscode.ExtensionContext,
  functions: FunctionInfo[],
  edges: FlowEdge[]
): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    'spagetiknot.flowDiagram',
    'SpagetiKnot Flow',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    }
  );

  const nodes = buildNodes(functions);
  const graphEdges = buildEdges(edges);

  panel.webview.html = getHtml(nodes, graphEdges);

  // Handle messages from webview (e.g. clicking a node to jump to file)
  panel.webview.onDidReceiveMessage(
    (msg) => {
      if (msg.command === 'openFile') {
        const uri = vscode.Uri.file(msg.filePath);
        vscode.window.showTextDocument(uri, {
          selection: new vscode.Range(msg.line, 0, msg.line, 0),
        });
      }
    },
    undefined,
    context.subscriptions
  );

  return panel;
}

interface GraphNode {
  id: string;
  label: string;
  file: string;
  fileName: string;
  line: number;
}

interface GraphEdge {
  source: string;
  target: string;
}

function buildNodes(functions: FunctionInfo[]): GraphNode[] {
  return functions.map((fn) => ({
    id: nodeId(fn),
    label: fn.name,
    file: fn.filePath,
    fileName: path.basename(fn.filePath),
    line: fn.line,
  }));
}

function buildEdges(edges: FlowEdge[]): GraphEdge[] {
  return edges.map((e) => ({
    source: e.source,
    target: e.target,
  }));
}

function getHtml(nodes: GraphNode[], edges: GraphEdge[]): string {
  const nodesJson = JSON.stringify(nodes);
  const edgesJson = JSON.stringify(edges);

  return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>SpagetiKnot Flow</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: var(--vscode-editor-background, #1e1e1e);
    color: var(--vscode-editor-foreground, #ccc);
    font-family: var(--vscode-font-family, monospace);
    overflow: hidden;
    width: 100vw;
    height: 100vh;
  }
  #toolbar {
    position: fixed;
    top: 0; left: 0; right: 0;
    height: 36px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 12px;
    background: var(--vscode-titleBar-activeBackground, #333);
    border-bottom: 1px solid var(--vscode-panel-border, #444);
    z-index: 10;
    font-size: 13px;
  }
  #toolbar input {
    background: var(--vscode-input-background, #3c3c3c);
    color: var(--vscode-input-foreground, #ccc);
    border: 1px solid var(--vscode-input-border, #555);
    padding: 2px 8px;
    border-radius: 3px;
    font-size: 12px;
    width: 200px;
  }
  #toolbar .info {
    margin-left: auto;
    font-size: 11px;
    opacity: 0.7;
  }
  canvas {
    display: block;
    margin-top: 36px;
  }
</style>
</head>
<body>
<div id="toolbar">
  <span>SpagetiKnot</span>
  <input id="search" type="text" placeholder="Search functions..." />
  <span class="info" id="stats"></span>
</div>
<canvas id="canvas"></canvas>
<script>
(function() {
  const vscode = acquireVsCodeApi();
  const nodes = ${nodesJson};
  const edges = ${edgesJson};

  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const searchInput = document.getElementById('search');
  const statsEl = document.getElementById('stats');

  let width, height;
  let offsetX = 0, offsetY = 0, scale = 1;
  let dragging = false, dragStartX = 0, dragStartY = 0;
  let dragNode = null;
  let hoveredNode = null;
  let searchTerm = '';

  // Assign positions using a simple force-directed-like layout
  const NODE_W = 160;
  const NODE_H = 50;

  function initPositions() {
    const cols = Math.ceil(Math.sqrt(nodes.length));
    nodes.forEach((n, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      n.x = 100 + col * (NODE_W + 80);
      n.y = 100 + row * (NODE_H + 60);
      n.w = NODE_W;
      n.h = NODE_H;
    });
  }

  // Simple force-directed layout (few iterations for initial placement)
  function forceLayout(iterations) {
    const nodeMap = new Map();
    nodes.forEach(n => nodeMap.set(n.id, n));

    for (let iter = 0; iter < iterations; iter++) {
      // Repulsion between all nodes
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const force = 8000 / (dist * dist);
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          a.x -= fx; a.y -= fy;
          b.x += fx; b.y += fy;
        }
      }

      // Attraction along edges
      for (const e of edges) {
        const a = nodeMap.get(e.source);
        const b = nodeMap.get(e.target);
        if (!a || !b) continue;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = (dist - 200) * 0.01;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.x += fx; a.y += fy;
        b.x -= fx; b.y -= fy;
      }
    }
  }

  function resize() {
    width = window.innerWidth;
    height = window.innerHeight - 36;
    canvas.width = width * devicePixelRatio;
    canvas.height = height * devicePixelRatio;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    draw();
  }

  // Color by file
  const fileColors = new Map();
  const palette = [
    '#4fc3f7','#81c784','#ffb74d','#e57373',
    '#ba68c8','#4dd0e1','#aed581','#ff8a65',
    '#f06292','#7986cb','#a1887f','#90a4ae',
  ];
  function colorForFile(fileName) {
    if (!fileColors.has(fileName)) {
      fileColors.set(fileName, palette[fileColors.size % palette.length]);
    }
    return fileColors.get(fileName);
  }

  function draw() {
    ctx.save();
    ctx.clearRect(0, 0, width, height);
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);

    const nodeMap = new Map();
    nodes.forEach(n => nodeMap.set(n.id, n));

    // Draw edges
    for (const e of edges) {
      const a = nodeMap.get(e.source);
      const b = nodeMap.get(e.target);
      if (!a || !b) continue;

      const isHighlighted = searchTerm && (
        a.label.toLowerCase().includes(searchTerm) ||
        b.label.toLowerCase().includes(searchTerm)
      );

      ctx.beginPath();
      ctx.strokeStyle = isHighlighted ? '#ffeb3b' : 'rgba(150,150,150,0.4)';
      ctx.lineWidth = isHighlighted ? 2 : 1;

      const ax = a.x + a.w / 2;
      const ay = a.y + a.h / 2;
      const bx = b.x + b.w / 2;
      const by = b.y + b.h / 2;

      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();

      // Arrow head
      const angle = Math.atan2(by - ay, bx - ax);
      const arrowLen = 10;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(
        bx - arrowLen * Math.cos(angle - 0.4),
        by - arrowLen * Math.sin(angle - 0.4)
      );
      ctx.moveTo(bx, by);
      ctx.lineTo(
        bx - arrowLen * Math.cos(angle + 0.4),
        by - arrowLen * Math.sin(angle + 0.4)
      );
      ctx.stroke();
    }

    // Draw nodes
    for (const n of nodes) {
      const matched = searchTerm && n.label.toLowerCase().includes(searchTerm);
      const dimmed = searchTerm && !matched;
      const isHovered = hoveredNode === n;

      const color = colorForFile(n.fileName);
      ctx.globalAlpha = dimmed ? 0.2 : 1;

      // Shadow
      if (isHovered) {
        ctx.shadowColor = color;
        ctx.shadowBlur = 12;
      }

      // Box
      ctx.fillStyle = isHovered ? '#2a2a2a' : '#1e1e1e';
      ctx.strokeStyle = color;
      ctx.lineWidth = isHovered ? 2.5 : 1.5;
      roundRect(ctx, n.x, n.y, n.w, n.h, 6);
      ctx.fill();
      ctx.stroke();

      ctx.shadowBlur = 0;

      // Label
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 12px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        truncate(n.label, 18),
        n.x + n.w / 2,
        n.y + n.h / 2 - 7
      );

      // File name
      ctx.fillStyle = color;
      ctx.font = '10px monospace';
      ctx.fillText(
        truncate(n.fileName + ':' + (n.line + 1), 22),
        n.x + n.w / 2,
        n.y + n.h / 2 + 10
      );

      ctx.globalAlpha = 1;
    }

    ctx.restore();
    statsEl.textContent = nodes.length + ' functions, ' + edges.length + ' connections';
  }

  function roundRect(ctx, x, y, w, h, r) {
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

  function truncate(str, max) {
    return str.length > max ? str.slice(0, max - 1) + '…' : str;
  }

  function screenToWorld(sx, sy) {
    return {
      x: (sx - offsetX) / scale,
      y: (sy - offsetY) / scale,
    };
  }

  function hitTest(wx, wy) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (wx >= n.x && wx <= n.x + n.w && wy >= n.y && wy <= n.y + n.h) {
        return n;
      }
    }
    return null;
  }

  // --- Events ---
  canvas.addEventListener('mousedown', (e) => {
    const w = screenToWorld(e.offsetX, e.offsetY);
    const hit = hitTest(w.x, w.y);
    if (hit) {
      dragNode = hit;
      dragNode._dx = w.x - hit.x;
      dragNode._dy = w.y - hit.y;
    } else {
      dragging = true;
      dragStartX = e.offsetX - offsetX;
      dragStartY = e.offsetY - offsetY;
    }
  });

  canvas.addEventListener('mousemove', (e) => {
    if (dragNode) {
      const w = screenToWorld(e.offsetX, e.offsetY);
      dragNode.x = w.x - dragNode._dx;
      dragNode.y = w.y - dragNode._dy;
      draw();
    } else if (dragging) {
      offsetX = e.offsetX - dragStartX;
      offsetY = e.offsetY - dragStartY;
      draw();
    } else {
      const w = screenToWorld(e.offsetX, e.offsetY);
      const hit = hitTest(w.x, w.y);
      if (hit !== hoveredNode) {
        hoveredNode = hit;
        canvas.style.cursor = hit ? 'pointer' : 'default';
        draw();
      }
    }
  });

  canvas.addEventListener('mouseup', () => {
    dragging = false;
    dragNode = null;
  });

  canvas.addEventListener('dblclick', (e) => {
    const w = screenToWorld(e.offsetX, e.offsetY);
    const hit = hitTest(w.x, w.y);
    if (hit) {
      vscode.postMessage({
        command: 'openFile',
        filePath: hit.file,
        line: hit.line,
      });
    }
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
    const wx = (e.offsetX - offsetX) / scale;
    const wy = (e.offsetY - offsetY) / scale;
    scale *= zoomFactor;
    scale = Math.max(0.1, Math.min(5, scale));
    offsetX = e.offsetX - wx * scale;
    offsetY = e.offsetY - wy * scale;
    draw();
  }, { passive: false });

  searchInput.addEventListener('input', (e) => {
    searchTerm = e.target.value.toLowerCase();
    draw();
  });

  window.addEventListener('resize', resize);

  // Init
  initPositions();
  if (nodes.length > 1) {
    forceLayout(80);
  }
  resize();
})();
</script>
</body>
</html>`;
}

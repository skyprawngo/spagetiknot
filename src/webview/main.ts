/**
 * @module main
 * @description Webview entry point.
 *
 * Responsibilities: one-time setup (canvas, events, UI) and message routing.
 * All state mutation, layout logic, and DOM rendering are delegated to
 * dedicated modules.
 */
import { initCanvas, resizeCanvas } from './canvas';
import { setupCanvasEvents } from './interaction';
import { setupDashboard, renderDashSavedLayouts } from './dashboard';
import { setupNodeContext } from './nodeContext';
import { postMessage } from './messaging';
import { applyLoadData, applyIncrementalUpdate } from './stateUpdater';
import { renderDirPicker, renderSavedLayouts } from './dirPickerUI';

// ── Initialisation ────────────────────────────────────────────────────────────

function init(): void {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  initCanvas(canvas);
  setupCanvasEvents(canvas);
  setupDashboard();
  setupNodeContext();

  document.getElementById('btn-back-to-picker')!.addEventListener('click', () => {
    postMessage({ command: 'requestDirPicker' });
  });

  window.addEventListener('resize', () => { resizeCanvas(); });
}

// ── Screen transitions ────────────────────────────────────────────────────────

function showCanvas(): void {
  document.getElementById('dir-picker')!.style.display   = 'none';
  document.getElementById('loading')!.style.display      = 'none';
  (document.getElementById('canvas') as HTMLElement).style.display             = 'block';
  (document.getElementById('btn-back-to-picker') as HTMLElement).style.display = 'inline-block';
}

function showDirPicker(): void {
  document.getElementById('dir-picker')!.style.display   = 'block';
  document.getElementById('loading')!.style.display      = 'none';
  (document.getElementById('canvas') as HTMLElement).style.display             = 'none';
  (document.getElementById('btn-back-to-picker') as HTMLElement).style.display = 'none';
}

function showLoading(): void {
  document.getElementById('dir-picker')!.style.display   = 'none';
  document.getElementById('loading')!.style.display      = 'block';
  (document.getElementById('canvas') as HTMLElement).style.display             = 'none';
  (document.getElementById('btn-back-to-picker') as HTMLElement).style.display = 'none';
}

// ── Message routing ───────────────────────────────────────────────────────────

window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data;

  switch (msg.command) {
    case 'showDirPicker':
      renderDirPicker(msg.dirs);
      showDirPicker();
      break;

    case 'savedLayouts':
      renderSavedLayouts(msg.layouts);
      renderDashSavedLayouts(msg.layouts);
      break;

    case 'indexingStart':
      showLoading();
      break;

    case 'loadData':
      if (!msg.functions || msg.functions.length === 0) {
        showDirPicker();
        break;
      }
      showCanvas();
      applyLoadData(msg);
      break;

    case 'incrementalUpdate':
      applyIncrementalUpdate(msg);
      break;
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

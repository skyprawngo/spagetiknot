/**
 * @module dirPickerUI
 * @description Renders the directory picker and saved-layout list in the dir-picker panel.
 *
 * Responsibilities: DOM construction and event wiring for the picker screen only.
 * Does NOT mutate application state or perform indexing.
 *
 * ┌──────────────────────┬────────────────────────────────────────────────────────┐
 * │ Export               │ Role                                                   │
 * ├──────────────────────┼────────────────────────────────────────────────────────┤
 * │ renderDirPicker      │ Populate #dir-list with clickable directory items      │
 * │ renderSavedLayouts   │ Populate #saved-layout-list in the picker screen       │
 * └──────────────────────┴────────────────────────────────────────────────────────┘
 */
import { postMessage } from './messaging';

export type DirItem = { label: string; dir: string };
export type LayoutMeta = { name: string; targetDir: string; savedAt: string };

/** Populate the #dir-list element with selectable directory rows. */
export function renderDirPicker(dirs: DirItem[]): void {
  const listEl = document.getElementById('dir-list')!;
  listEl.innerHTML = '';
  for (const d of dirs) {
    const item = document.createElement('div');
    item.className = 'dir-item';
    item.textContent = d.label;
    item.addEventListener('click', () => postMessage({ command: 'selectDir', dir: d.dir }));
    listEl.appendChild(item);
  }
}

/** Populate the #saved-layout-list element in the picker screen. */
export function renderSavedLayouts(layouts: LayoutMeta[]): void {
  const listEl = document.getElementById('saved-layout-list')!;
  listEl.innerHTML = '';

  if (layouts.length === 0) {
    listEl.innerHTML = '<div style="opacity:0.4;font-size:11px;padding:4px">No saved layouts</div>';
    return;
  }

  for (const l of layouts) {
    const item = document.createElement('div');
    item.className = 'layout-item';

    const label = document.createElement('span');
    label.textContent = l.name;

    const meta = document.createElement('span');
    meta.className = 'layout-meta';
    meta.textContent = new Date(l.savedAt).toLocaleDateString();

    const del = document.createElement('span');
    del.className = 'delete-btn';
    del.textContent = '\u00d7';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      postMessage({ command: 'deleteLayout', name: l.name });
    });

    item.appendChild(label);
    item.appendChild(meta);
    item.appendChild(del);
    item.addEventListener('click', () => postMessage({ command: 'loadLayout', name: l.name }));
    listEl.appendChild(item);
  }
}

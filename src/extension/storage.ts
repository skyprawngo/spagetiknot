import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface SavedLayout {
  name: string;
  targetDir: string;
  savedAt: string;
  groups: { fileName: string; x: number; y: number; w: number; h: number }[];
  nodes: { id: string; x: number; y: number; w: number; h: number }[];
  groupModes: Record<string, string>;
  view: { offsetX: number; offsetY: number; scale: number };
}

function getSpagetiDir(): string | undefined {
  const ws = vscode.workspace.workspaceFolders;
  if (!ws || ws.length === 0) return undefined;
  return path.join(ws[0].uri.fsPath, '.spageti');
}

function ensureDirs(): string | undefined {
  const dir = getSpagetiDir();
  if (!dir) return undefined;
  const layoutsDir = path.join(dir, 'layouts');
  fs.mkdirSync(layoutsDir, { recursive: true });
  return dir;
}

export function listSavedLayouts(): { name: string; targetDir: string; savedAt: string }[] {
  const dir = getSpagetiDir();
  if (!dir) return [];
  const layoutsDir = path.join(dir, 'layouts');
  if (!fs.existsSync(layoutsDir)) return [];

  const files = fs.readdirSync(layoutsDir).filter(f => f.endsWith('.json'));
  const results: { name: string; targetDir: string; savedAt: string }[] = [];

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(layoutsDir, file), 'utf-8')) as SavedLayout;
      results.push({ name: data.name, targetDir: data.targetDir, savedAt: data.savedAt });
    } catch {
      // skip corrupt files
    }
  }
  return results.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

export function saveLayout(layout: SavedLayout): void {
  const dir = ensureDirs();
  if (!dir) return;
  const filePath = path.join(dir, 'layouts', sanitizeFileName(layout.name) + '.json');
  fs.writeFileSync(filePath, JSON.stringify(layout, null, 2), 'utf-8');
}

export function loadLayout(name: string): SavedLayout | undefined {
  const dir = getSpagetiDir();
  if (!dir) return undefined;
  const filePath = path.join(dir, 'layouts', sanitizeFileName(name) + '.json');
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SavedLayout;
  } catch {
    return undefined;
  }
}

export function deleteLayout(name: string): void {
  const dir = getSpagetiDir();
  if (!dir) return;
  const filePath = path.join(dir, 'layouts', sanitizeFileName(name) + '.json');
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 100);
}

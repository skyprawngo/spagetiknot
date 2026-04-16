import { getTheme } from './theme';

const fileColors = new Map<string, string>();

/** Returns the current color for a file, auto-assigning one if not set. */
export function colorForFile(fileName: string): string {
  if (!fileColors.has(fileName)) {
    const palette = getTheme().palette;
    fileColors.set(fileName, palette[fileColors.size % palette.length]);
  }
  return fileColors.get(fileName)!;
}

/** Override the color for a specific file. */
export function setFileColor(fileName: string, color: string): void {
  fileColors.set(fileName, color);
}

/** Serialize all current file→color assignments for layout saving. */
export function getFileColorMap(): Record<string, string> {
  return Object.fromEntries(fileColors.entries());
}

/** Restore file colors from a saved layout. */
export function restoreFileColors(map: Record<string, string>): void {
  for (const [fileName, color] of Object.entries(map)) {
    fileColors.set(fileName, color);
  }
}

/** Clear all colors (call before re-indexing so auto-palette restarts). */
export function clearFileColors(): void {
  fileColors.clear();
}

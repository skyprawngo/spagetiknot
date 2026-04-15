const fileColors = new Map<string, string>();
const palette = [
  '#4fc3f7', '#81c784', '#ffb74d', '#e57373',
  '#ba68c8', '#4dd0e1', '#aed581', '#ff8a65',
  '#f06292', '#7986cb', '#a1887f', '#90a4ae',
];

export function colorForFile(fileName: string): string {
  if (!fileColors.has(fileName)) {
    fileColors.set(fileName, palette[fileColors.size % palette.length]);
  }
  return fileColors.get(fileName)!;
}

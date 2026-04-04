

export const CURSOR_COLORS = [
  { name: 'blue', hex: '#3b82f6', light: 'rgba(59, 130, 246, 0.2)' },
  { name: 'green', hex: '#10b981', light: 'rgba(16, 185, 129, 0.2)' },
  { name: 'orange', hex: '#f97316', light: 'rgba(249, 115, 22, 0.2)' },
  { name: 'purple', hex: '#a855f7', light: 'rgba(168, 85, 247, 0.2)' },
  { name: 'red', hex: '#ef4444', light: 'rgba(239, 68, 68, 0.2)' },
  { name: 'pink', hex: '#ec4899', light: 'rgba(236, 72, 153, 0.2)' },
  { name: 'yellow', hex: '#eab308', light: 'rgba(234, 179, 8, 0.2)' },
  { name: 'cyan', hex: '#06b6d4', light: 'rgba(6, 182, 212, 0.2)' },
] as const;

export type CursorColor = typeof CURSOR_COLORS[number];

// Server-side: Map userId to consistent color
const userColorMap = new Map<string, CursorColor>();

export function getUserColor(userId: string): CursorColor {
  if (!userColorMap.has(userId)) {
    const colorIndex = userColorMap.size % CURSOR_COLORS.length;
    userColorMap.set(userId, CURSOR_COLORS[colorIndex]);
  }
  return userColorMap.get(userId)!;
}

// Client-side: Get color from name
export function getColorByName(colorName: string): CursorColor | undefined {
  return CURSOR_COLORS.find(c => c.name === colorName);
}

// Clean up when user leaves (optional)
export function clearUserColor(userId: string): void {
  userColorMap.delete(userId);
}
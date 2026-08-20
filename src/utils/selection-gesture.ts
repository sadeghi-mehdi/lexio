export const TEXT_SELECTION_DRAG_THRESHOLD = 5;

export function hasExceededDragThreshold(
  startX: number,
  startY: number,
  currentX: number,
  currentY: number,
  threshold = TEXT_SELECTION_DRAG_THRESHOLD
): boolean {
  return Math.hypot(currentX - startX, currentY - startY) >= threshold;
}

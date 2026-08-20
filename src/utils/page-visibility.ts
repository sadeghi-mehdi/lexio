export interface PageViewportBounds {
  page: number;
  top: number;
  bottom: number;
}

export function findNearestVisiblePage(
  rootTop: number,
  rootBottom: number,
  pages: readonly PageViewportBounds[]
): number | null {
  let mostVisiblePage: number | null = null;
  let greatestVisibleHeight = 0;
  let nearestTopDistance = Number.POSITIVE_INFINITY;
  for (const page of pages) {
    const visibleHeight = Math.max(
      0,
      Math.min(page.bottom, rootBottom) - Math.max(page.top, rootTop)
    );
    if (visibleHeight === 0) continue;
    const topDistance = Math.abs(page.top - rootTop);
    if (
      visibleHeight > greatestVisibleHeight ||
      (visibleHeight === greatestVisibleHeight && topDistance < nearestTopDistance)
    ) {
      greatestVisibleHeight = visibleHeight;
      nearestTopDistance = topDistance;
      mostVisiblePage = page.page;
    }
  }
  return mostVisiblePage;
}

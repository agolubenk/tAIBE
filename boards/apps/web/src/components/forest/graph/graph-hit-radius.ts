// The SVG scales to its container, so a fixed radius in viewBox units is
// smaller than 24 px on a phone (×0.5 at 360 px). Give the hit circle at
// least 12 px of radius on screen (WCAG 2.5.8, TB-223), and no more than 30
// units: the layout keeps nodes ~60 apart, so hit circles do not overlap.
const MIN_SCREEN_RADIUS = 12;
const MIN_RADIUS = 14;
const MAX_RADIUS = 30;

export function graphHitRadius(renderedWidth: number, viewWidth: number) {
  if (!(renderedWidth > 0) || !(viewWidth > 0)) return MIN_RADIUS;
  const scale = renderedWidth / viewWidth;
  const radius = Math.ceil(MIN_SCREEN_RADIUS / scale);
  return Math.min(Math.max(radius, MIN_RADIUS), MAX_RADIUS);
}

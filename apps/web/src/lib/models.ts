/**
 * Shared model-link helpers. The models detail route is a splat (`/models/$`)
 * because public model ids may contain "/".
 */
export function modelHref(publicId: string): string {
  // Encode each segment (never the "/" separators) so splat matching still works.
  return `/models/${publicId
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

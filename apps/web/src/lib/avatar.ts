/** Avatar helpers: Gravatar URL (SHA-256 via crypto.subtle) and client-side image compression. */

export const MAX_AVATAR_BYTES = 1_048_576;

/** https://gravatar.com/avatar/<sha256 hex of trim(lower(email))>?s=128&d=404 */
export async function gravatarUrl(email: string | null | undefined): Promise<string | null> {
  if (!email) return null;
  const data = new TextEncoder().encode(email.trim().toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `https://gravatar.com/avatar/${hex}?s=128&d=404`;
}

function canvasToBlob(canvas: OffscreenCanvas | HTMLCanvasElement, type: string): Promise<Blob> {
  if ("convertToBlob" in canvas) return canvas.convertToBlob({ type, quality: 0.85 });
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("encoding failed"))),
      type,
      0.85,
    ),
  );
}

/**
 * Resize to fit 256x256 and encode webp (jpeg fallback). Rejects oversize results
 * and non-image input; the server re-validates magic bytes regardless.
 */
export async function compressAvatar(file: File): Promise<Blob> {
  if (!file.type.startsWith("image/")) throw new Error("Only image files are allowed");
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  let blob: Blob;
  try {
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
    try {
      blob = await canvasToBlob(canvas, "image/webp");
    } catch {
      blob = await canvasToBlob(canvas, "image/jpeg");
    }
  } catch {
    // OffscreenCanvas unavailable (older Safari): fall back to DOM canvas.
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
    try {
      blob = await canvasToBlob(canvas, "image/webp");
    } catch {
      blob = await canvasToBlob(canvas, "image/jpeg");
    }
  } finally {
    bitmap.close();
  }
  if (blob.size > MAX_AVATAR_BYTES) throw new Error("Compressed avatar is too large");
  return blob;
}

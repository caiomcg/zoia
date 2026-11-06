/**
 * A GIF message (ADR 0051): its whole body is one KLIPY address, which the
 * chat shows as the GIF itself. Anything else, even with such an address in
 * it, is text.
 */

const GIF_URL = /^https:\/\/([a-z0-9-]+\.)*klipy\.com\/[^\s]+$/i;

export function isGifMessage(body: string | null | undefined): boolean {
  return Boolean(body && GIF_URL.test(body.trim()));
}

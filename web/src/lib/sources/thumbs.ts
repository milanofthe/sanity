// The small version of every picture in the open folder.
//
// The backend decodes these across its cores and hands them over in one
// buffer; see the `thumbs` command. What this module is for is the shape of
// that buffer and the rule for when a thumbnail is enough:
//
//   A panel up to 128 pixels across is drawn from the thumbnail. That covers
//   the zooms this app is normally watched at, so the usual case never touches
//   a source file at all. Above it the renderer asks for the source, which is
//   one file for the one panel somebody zoomed into.
//
// Shared by every source, since the web demo bakes the same thumbnails into
// its dump and reads them over HTTP.

/** Longest edge of a thumbnail, matching `thumb::THUMB_MAX` in the backend. */
export const THUMB_MAX = 128;

/**
 * Unpack the reply of the `thumbs` command.
 *
 *     u32 count, then per entry u32 path length, u32 data length, the path as
 *     UTF-8, and the PNG. Zero length means there is none.
 */
export function unpackThumbs(buffer: ArrayBuffer): Map<string, ArrayBuffer> {
  const out = new Map<string, ArrayBuffer>();
  const view = new DataView(buffer);
  const text = new TextDecoder();
  let at = 0;
  if (buffer.byteLength < 4) return out;
  const count = view.getUint32(at, true);
  at += 4;
  for (let i = 0; i < count && at + 8 <= buffer.byteLength; i++) {
    const pathLen = view.getUint32(at, true);
    const dataLen = view.getUint32(at + 4, true);
    at += 8;
    if (at + pathLen + dataLen > buffer.byteLength) break;
    const path = text.decode(new Uint8Array(buffer, at, pathLen));
    at += pathLen;
    if (dataLen > 0) out.set(path, buffer.slice(at, at + dataLen));
    at += dataLen;
  }
  return out;
}

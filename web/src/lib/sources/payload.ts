// Unpacking the payload blob from the backend.
//
// Its own module so it can be tested under node: the Tauri source pulls in
// @tauri-apps/api, which only resolves inside the webview. The format is
// produced by `pack_payloads` in src-tauri/src/lib.rs and both sides assert
// against the same fixture.
//
//   u32  header length in bytes
//   u32  number of entries
//   ...  header: JSON array of [path, byteLength]
//   ...  payloads, in header order

export function unpack(blob: ArrayBuffer): Map<string, ArrayBuffer> {
  if (blob.byteLength < 8) throw new Error('payload blob too short');
  const head = new Uint32Array(blob, 0, 2);
  const headerLen = head[0];
  const count = head[1];
  if (8 + headerLen > blob.byteLength) throw new Error('payload header overruns blob');

  const index: [string, number][] = JSON.parse(
    new TextDecoder().decode(new Uint8Array(blob, 8, headerLen)),
  );
  if (index.length !== count) {
    throw new Error(`payload index has ${index.length} entries, header says ${count}`);
  }

  const out = new Map<string, ArrayBuffer>();
  let offset = 8 + headerLen;
  for (const [path, len] of index) {
    if (offset + len > blob.byteLength) throw new Error(`payload for ${path} overruns blob`);
    out.set(path, blob.slice(offset, offset + len));
    offset += len;
  }
  if (offset !== blob.byteLength) {
    throw new Error(`payload blob has ${blob.byteLength - offset} trailing bytes`);
  }
  return out;
}

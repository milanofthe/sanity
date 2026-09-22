// Pictures decoded to raw premultiplied pixels off the main thread; see
// imagedecode.ts.

interface Request {
  id: number;
  bytes: ArrayBuffer;
  /** Largest side to keep; a larger picture is drawn down to it. */
  maxSide: number;
}

self.onmessage = async (e: MessageEvent<Request>) => {
  const { id, bytes, maxSide } = e.data;
  const post = (msg: object, transfer: Transferable[] = []) =>
    (self as unknown as Worker).postMessage({ id, ...msg }, transfer);
  if (typeof OffscreenCanvas !== 'function') {
    post({ unsupported: true });
    return;
  }
  try {
    const bmp = await createImageBitmap(new Blob([bytes]));
    const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * k));
    const h = Math.max(1, Math.round(bmp.height * k));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      bmp.close();
      post({ unsupported: true });
      return;
    }
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const data = ctx.getImageData(0, 0, w, h).data;
    // Premultiplied, which is how every picture texture is held, and counted
    // on the way: a picture mostly transparent needs a sheet under it.
    let clear = 0;
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a < 128) clear++;
      if (a === 255) continue;
      const f = a / 255;
      data[i] = data[i] * f + 0.5;
      data[i + 1] = data[i + 1] * f + 0.5;
      data[i + 2] = data[i + 2] * f + 0.5;
    }
    const pixels = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    post({ w, h, data: pixels, clear: clear / (w * h) }, [pixels.buffer]);
  } catch {
    post({ failed: true });
  }
};

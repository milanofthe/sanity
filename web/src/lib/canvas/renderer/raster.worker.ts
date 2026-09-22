// Rasterises overviews off the main thread; see rasterpool.ts.

import { OverviewRaster, type RasterInput } from './raster';

const raster = new OverviewRaster();

self.onmessage = (e: MessageEvent<{ id: number; input: RasterInput }>) => {
  const { id, input } = e.data;
  const levels: { level: number; w: number; h: number; data: Uint8Array }[] = [];
  // Copied out of the scratch memory, which the next file reuses, and handed
  // over rather than copied again on the way back.
  raster.run(input, (level, w, h, data) => levels.push({ level, w, h, data: data.slice() }));
  (self as unknown as Worker).postMessage({ id, levels }, levels.map((l) => l.data.buffer));
};

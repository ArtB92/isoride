// Turns Valhalla's nested isodistance polygons into a continuous distance field on a Web Mercator grid,
// then paints it as a heatmap and traces isochrones from it. Distances are in km along the cycling
// network, so a new speed only needs a repaint.

const EARTH_RADIUS = 6378137;
const GRID_CELLS = 512; // cells along the longest side of the reachable area

// From near (green) to far (red), as on tram.camilleroux.com; beyond the scale the colour fades out.
export const PALETTE = [
  [0, [47, 170, 28]],
  [0.25, [132, 210, 84]],
  [0.5, [232, 232, 118]],
  [0.75, [246, 178, 102]],
  [1, [232, 106, 106]],
];
const BEYOND_FADE = 0.06;
const LUT_SIZE = 512;
const EDGE_CELLS = 4;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function paletteColor(t) {
  for (let i = 1; i < PALETTE.length; i += 1) {
    const [stop, color] = PALETTE[i];
    if (t <= stop) {
      const [prevStop, prevColor] = PALETTE[i - 1];
      const mix = (t - prevStop) / (stop - prevStop);
      return prevColor.map((channel, c) => Math.round(channel + (color[c] - channel) * mix));
    }
  }
  return PALETTE[PALETTE.length - 1][1];
}

export function toMercator([lon, lat]) {
  const x = (EARTH_RADIUS * lon * Math.PI) / 180;
  const y = EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  return [x, y];
}

export function fromMercator([x, y]) {
  const lon = (x / EARTH_RADIUS) * (180 / Math.PI);
  const lat = (2 * Math.atan(Math.exp(y / EARTH_RADIUS)) - Math.PI / 2) * (180 / Math.PI);
  return [lon, lat];
}

const polygonsOf = (geometry) => (geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates);

/** Exact Euclidean distance transform (Felzenszwalb) in cells to the nearest cell where `isSource` is true. */
function distanceTransform(isSource, cols, rows) {
  const INF = 1e12;
  const squared = new Float64Array(cols * rows);
  for (let i = 0; i < squared.length; i += 1) squared[i] = isSource[i] ? 0 : INF;
  const size = Math.max(cols, rows);
  const f = new Float64Array(size);
  const d = new Float64Array(size);
  const v = new Int32Array(size);
  const z = new Float64Array(size + 1);
  const pass = (n) => {
    let k = 0;
    v[0] = 0;
    z[0] = -Infinity;
    z[1] = Infinity;
    for (let q = 1; q < n; q += 1) {
      let s;
      do {
        const p = v[k];
        s = (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p);
        if (s <= z[k]) k -= 1;
        else break;
      } while (k >= 0);
      k += 1;
      v[k] = q;
      z[k] = s;
      z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < n; q += 1) {
      while (z[k + 1] < q) k += 1;
      const p = v[k];
      d[q] = (q - p) * (q - p) + f[p];
    }
  };
  for (let col = 0; col < cols; col += 1) {
    for (let row = 0; row < rows; row += 1) f[row] = squared[row * cols + col];
    pass(rows);
    for (let row = 0; row < rows; row += 1) squared[row * cols + col] = d[row];
  }
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) f[col] = squared[row * cols + col];
    pass(cols);
    for (let col = 0; col < cols; col += 1) squared[row * cols + col] = d[col];
  }
  for (let i = 0; i < squared.length; i += 1) squared[i] = Math.sqrt(squared[i]);
  return squared;
}

/**
 * Builds the distance field. `bands` are [{ km, geometry }] from nearest to farthest.
 * Inside band k (between polygons k-1 and k) the distance is interpolated from how far the cell is
 * from each of the two boundaries, which turns stepped contours into a smooth gradient.
 */
export function buildField(origin, bands) {
  const projected = bands.map((band) => ({ km: band.km, polygons: polygonsOf(band.geometry).map((polygon) => polygon.map((ring) => ring.map(toMercator))) }));
  const outer = projected.at(-1).polygons.flat(2);
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of outer) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const pad = Math.max(maxX - minX, maxY - minY) * 0.04 + 1;
  minX -= pad;
  minY -= pad;
  maxX += pad;
  maxY += pad;
  const cell = Math.max(maxX - minX, maxY - minY) / GRID_CELLS;
  const cols = Math.ceil((maxX - minX) / cell);
  const rows = Math.ceil((maxY - minY) / cell);
  maxX = minX + cols * cell;
  maxY = minY + rows * cell;

  // Rasterise each polygon (row 0 is the northern edge, like the image drawn on the map).
  const canvas = document.createElement("canvas");
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const masks = [];
  for (const band of projected) {
    ctx.clearRect(0, 0, cols, rows);
    ctx.beginPath();
    for (const polygon of band.polygons) {
      for (const ring of polygon) {
        ring.forEach(([x, y], i) => {
          const px = (x - minX) / cell;
          const py = (maxY - y) / cell;
          if (i) ctx.lineTo(px, py);
          else ctx.moveTo(px, py);
        });
        ctx.closePath();
      }
    }
    ctx.fillStyle = "#000";
    ctx.fill("evenodd");
    const alpha = ctx.getImageData(0, 0, cols, rows).data;
    const mask = new Uint8Array(cols * rows);
    for (let i = 0; i < mask.length; i += 1) mask[i] = alpha[i * 4 + 3] > 127 ? 1 : 0;
    // Bands are nested: whatever an inner band reaches, the outer ones reach too.
    if (masks.length) {
      const inner = masks.at(-1);
      for (let i = 0; i < mask.length; i += 1) mask[i] |= inner[i];
    }
    masks.push(mask);
  }

  const [ox, oy] = toMercator([origin.lon, origin.lat]);
  const originCol = clamp(Math.floor((ox - minX) / cell), 0, cols - 1);
  const originRow = clamp(Math.floor((maxY - oy) / cell), 0, rows - 1);
  const originMask = new Uint8Array(cols * rows);
  originMask[originRow * cols + originCol] = 1;

  const km = new Float32Array(cols * rows).fill(NaN);
  for (let k = 0; k < masks.length; k += 1) {
    const inner = k ? masks[k - 1] : originMask;
    const mask = masks[k];
    const toInner = distanceTransform(inner, cols, rows);
    const outside = new Uint8Array(mask.length);
    for (let i = 0; i < mask.length; i += 1) outside[i] = mask[i] ? 0 : 1;
    const toOuter = distanceTransform(outside, cols, rows);
    const near = k ? projected[k - 1].km : 0;
    const far = projected[k].km;
    for (let i = 0; i < mask.length; i += 1) {
      if (!mask[i] || (k && inner[i])) continue;
      const a = toInner[i];
      const b = toOuter[i];
      km[i] = near + ((far - near) * a) / Math.max(a + b, 1e-6);
    }
  }
  km[originRow * cols + originCol] = 0;

  // Extend the field a few cells past the reachable area, as if the distance kept growing: the outer
  // isochrone then follows the edge smoothly instead of in steps, and the heatmap fades out softly.
  const reached = new Uint8Array(km.length);
  for (let i = 0; i < km.length; i += 1) reached[i] = Number.isNaN(km[i]) ? 0 : 1;
  const toReached = distanceTransform(reached, cols, rows);
  // The extension spans exactly the fade-out range of the palette, so the colour reaches zero at its edge.
  const edgeKm = projected.at(-1).km;
  for (let i = 0; i < km.length; i += 1) {
    if (!reached[i] && toReached[i] <= EDGE_CELLS) km[i] = edgeKm * (1 + (toReached[i] / EDGE_CELLS) * BEYOND_FADE);
  }

  return {
    km: smooth(km, cols, rows),
    cols,
    rows,
    cell,
    bounds: [minX, minY, maxX, maxY],
    origin,
    maxKm: projected.at(-1).km,
    bands: bands.map((band) => band.km),
    // True length of a cell side at this latitude (Mercator stretches distances by 1/cos(lat)).
    cellMeters: cell * Math.cos((origin.lat * Math.PI) / 180),
  };
}

/** 3×3 weighted average over reached cells: removes the faint grid pattern left by the polygons. */
function smooth(values, cols, rows) {
  const out = new Float32Array(values.length).fill(NaN);
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const index = row * cols + col;
      if (Number.isNaN(values[index])) continue;
      let sum = 0;
      let weight = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const r = row + dy;
          const c = col + dx;
          if (r < 0 || c < 0 || r >= rows || c >= cols) continue;
          const value = values[r * cols + c];
          if (Number.isNaN(value)) continue;
          const w = dx === 0 && dy === 0 ? 4 : dx === 0 || dy === 0 ? 2 : 1;
          sum += value * w;
          weight += w;
        }
      }
      out[index] = sum / weight;
    }
  }
  return out;
}

/** Image corners as MapLibre expects them: top-left, top-right, bottom-right, bottom-left. */
export function fieldCorners(field) {
  const [minX, minY, maxX, maxY] = field.bounds;
  return [
    fromMercator([minX, maxY]),
    fromMercator([maxX, maxY]),
    fromMercator([maxX, minY]),
    fromMercator([minX, minY]),
  ];
}

export function fieldLngLatBounds(field) {
  const [minX, minY, maxX, maxY] = field.bounds;
  return [fromMercator([minX, minY]), fromMercator([maxX, maxY])];
}

/** Paints the field at a given speed and scale; returns a PNG data URL. */
export function paintHeat(field, { speed, maxMinutes, alpha = 0.8 }) {
  const { cols, rows, km } = field;
  const canvas = document.createElement("canvas");
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(cols, rows);
  const lutMax = 1 + BEYOND_FADE;
  const lut = new Uint8ClampedArray(LUT_SIZE * 4);
  for (let i = 0; i < LUT_SIZE; i += 1) {
    const t = (i / (LUT_SIZE - 1)) * lutMax;
    const [r, g, b] = paletteColor(Math.min(t, 1));
    const fade = t <= 1 ? 1 : clamp(1 - (t - 1) / BEYOND_FADE, 0, 1);
    lut.set([r, g, b, Math.round(fade * alpha * 255)], i * 4);
  }
  const kmToIndex = ((LUT_SIZE - 1) * 60) / (speed * maxMinutes * lutMax);
  for (let i = 0; i < km.length; i += 1) {
    const value = km[i];
    if (Number.isNaN(value)) continue;
    const index = Math.round(value * kmToIndex);
    if (index >= LUT_SIZE) continue;
    image.data.set(lut.subarray(index * 4, index * 4 + 4), i * 4);
  }
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL();
}

/** Marching squares at `threshold` km; returns line segments as [lon, lat] pairs and label positions, north first. */
export function contour(field, thresholdKm) {
  const { cols, rows, km, bounds, cell } = field;
  const [minX, , , maxY] = bounds;
  const value = (row, col) => {
    const v = km[row * cols + col];
    return Number.isNaN(v) ? Infinity : v;
  };
  const center = (row, col) => [minX + (col + 0.5) * cell, maxY - (row + 0.5) * cell];
  const between = (pa, va, pb, vb) => {
    const t = Number.isFinite(va) && Number.isFinite(vb) ? clamp((thresholdKm - va) / (vb - va), 0, 1) : 0.5;
    return [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t];
  };
  const segments = [];
  const labels = [];
  for (let row = 0; row < rows - 1; row += 1) {
    for (let col = 0; col < cols - 1; col += 1) {
      const corners = [
        [center(row, col), value(row, col)],
        [center(row, col + 1), value(row, col + 1)],
        [center(row + 1, col + 1), value(row + 1, col + 1)],
        [center(row + 1, col), value(row + 1, col)],
      ];
      const inside = corners.map(([, v]) => v <= thresholdKm);
      const crossings = [];
      for (let k = 0; k < 4; k += 1) {
        const a = corners[k];
        const b = corners[(k + 1) % 4];
        if (inside[k] !== inside[(k + 1) % 4]) crossings.push(between(a[0], a[1], b[0], b[1]));
      }
      const add = (a, b) => {
        segments.push([fromMercator(a), fromMercator(b)]);
        // Labels go on the northernmost points of the line, like on the original map; rows are
        // scanned from the north, so the first segments found are the candidates.
        if (labels.length < 40) labels.push(fromMercator([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]));
      };
      if (crossings.length === 2) add(crossings[0], crossings[1]);
      else if (crossings.length === 4) {
        add(crossings[0], crossings[1]);
        add(crossings[2], crossings[3]);
      }
    }
  }
  return { segments, labels };
}

/** Figures for the panel and the stats: reachable areas, farthest point and detour factor. */
export function fieldStats(field, { speed, maxMinutes, reachMinutes }) {
  const { cols, rows, km, cell, bounds, origin, cellMeters } = field;
  const [minX, , , maxY] = bounds;
  const [ox, oy] = toMercator([origin.lon, origin.lat]);
  const scale = cellMeters / cell;
  const reachKm = (speed * reachMinutes) / 60;
  const maxKm = (speed * maxMinutes) / 60;
  let reachCells = 0;
  let maxCells = 0;
  let farthest = 0;
  let detourSum = 0;
  let detourCount = 0;
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const value = km[row * cols + col];
      if (Number.isNaN(value) || value > maxKm) continue;
      maxCells += 1;
      if (value <= reachKm) reachCells += 1;
      const dx = minX + (col + 0.5) * cell - ox;
      const dy = maxY - (row + 0.5) * cell - oy;
      const straight = (Math.hypot(dx, dy) * scale) / 1000;
      if (straight > farthest) farthest = straight;
      if (straight > 1.5 && value > straight) {
        detourSum += value / straight;
        detourCount += 1;
      }
    }
  }
  const cellArea = (cellMeters * cellMeters) / 1e6;
  return {
    reachArea: reachCells * cellArea,
    maxArea: maxCells * cellArea,
    farthest,
    detour: detourCount ? detourSum / detourCount : null,
    // Whether the field covers the whole scale, or was computed for a shorter range.
    complete: field.maxKm >= maxKm * 0.98,
  };
}

/** Network distance (km) at a point, bilinearly interpolated; NaN where the field has no value. */
export function sampleKm(field, lon, lat) {
  const { cols, rows, km, cell, bounds } = field;
  const [x, y] = toMercator([lon, lat]);
  const gx = (x - bounds[0]) / cell - 0.5;
  const gy = (bounds[3] - y) / cell - 0.5;
  if (gx < 0 || gy < 0 || gx > cols - 1 || gy > rows - 1) return NaN;
  const c0 = Math.floor(gx);
  const r0 = Math.floor(gy);
  const c1 = Math.min(c0 + 1, cols - 1);
  const r1 = Math.min(r0 + 1, rows - 1);
  const tx = gx - c0;
  const ty = gy - r0;
  let sum = 0;
  let weight = 0;
  for (const [r, c, w] of [
    [r0, c0, (1 - tx) * (1 - ty)],
    [r0, c1, tx * (1 - ty)],
    [r1, c0, (1 - tx) * ty],
    [r1, c1, tx * ty],
  ]) {
    const value = km[r * cols + c];
    if (Number.isNaN(value) || w === 0) continue;
    sum += value * w;
    weight += w;
  }
  return weight > 0.3 ? sum / weight : NaN;
}

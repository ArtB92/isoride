// "Routes" view: every road of the basemap tiles currently loaded is cut into short pieces, and each piece
// carries the network distance (km) from the start, read from the distance field. The map then colours the
// pieces with a data-driven expression, so a new speed or scale only changes the paint, not the data.

import { sampleKm } from "./field.js";

/**
 * @param features GeoJSON features from map.querySourceFeatures (LineString or MultiLineString, lon/lat)
 * @param field distance field from buildField
 * @param stepKm largest distance change allowed along one piece (sets how smooth the gradient is)
 */
export function reachRoads(features, field, stepKm) {
  const out = [];
  const seen = new Set();
  for (const feature of features) {
    const { geometry } = feature;
    const lines = geometry.type === "LineString" ? [geometry.coordinates] : geometry.type === "MultiLineString" ? geometry.coordinates : [];
    for (const line of lines) {
      if (line.length < 2) continue;
      // The same road comes back from every tile it crosses: skip exact repeats.
      const key = `${line[0][0].toFixed(5)},${line[0][1].toFixed(5)},${line.at(-1)[0].toFixed(5)},${line.at(-1)[1].toFixed(5)},${line.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      splitLine(line, field, stepKm, out);
    }
  }
  return { type: "FeatureCollection", features: out };
}

function splitLine(line, field, stepKm, out) {
  let piece = null;
  const close = () => {
    if (piece && piece.points.length > 1) {
      out.push({
        type: "Feature",
        properties: { km: Math.round(((piece.min + piece.max) / 2) * 1000) / 1000 },
        geometry: { type: "LineString", coordinates: piece.points },
      });
    }
    piece = null;
  };
  const add = (point, km) => {
    if (Number.isNaN(km)) {
      close();
      return;
    }
    if (!piece) {
      piece = { points: [point], min: km, max: km };
      return;
    }
    piece.points.push(point);
    piece.min = Math.min(piece.min, km);
    piece.max = Math.max(piece.max, km);
    if (piece.max - piece.min >= stepKm) {
      close();
      piece = { points: [point], min: km, max: km };
    }
  };

  let previous = line[0];
  let previousKm = sampleKm(field, previous[0], previous[1]);
  add(previous, previousKm);
  for (let i = 1; i < line.length; i += 1) {
    const point = line[i];
    const km = sampleKm(field, point[0], point[1]);
    // Long segments are subdivided so the colour keeps changing along them.
    const spread = Number.isNaN(km) || Number.isNaN(previousKm) ? 0 : Math.abs(km - previousKm);
    const parts = Math.min(64, Math.max(1, Math.ceil(spread / (stepKm / 2))));
    for (let k = 1; k < parts; k += 1) {
      const t = k / parts;
      const lon = previous[0] + (point[0] - previous[0]) * t;
      const lat = previous[1] + (point[1] - previous[1]) * t;
      add([lon, lat], sampleKm(field, lon, lat));
    }
    add(point, km);
    previous = point;
    previousKm = km;
  }
  close();
}

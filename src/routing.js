// Cycling reachability from Valhalla (OpenStreetMap routing engine). The public FOSSGIS instance needs no key;
// set VITE_VALHALLA_URL to use your own server (docker image ghcr.io/valhalla/valhalla-scripted).

export const VALHALLA_URL = (import.meta.env.VITE_VALHALLA_URL ?? "https://valhalla1.openstreetmap.de").replace(/\/$/, "");
/** Number of nested isodistance polygons requested; the server allows 4 contours per request. */
export const BANDS = 8;
const CONTOURS_PER_REQUEST = 4;
/** Longest isodistance the public server accepts (max_distance_contour), in km. */
export const MAX_KM = 200;

export class RoutingError extends Error {
  constructor(message, { status = 0, code = 0 } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function call(action, body, signal) {
  // GET with ?json= keeps it a "simple" CORS request (no preflight).
  const url = `${VALHALLA_URL}/${action}?json=${encodeURIComponent(JSON.stringify(body))}`;
  let response;
  try {
    response = await fetch(url, { signal });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new RoutingError("Le serveur d'itinéraires ne répond pas.");
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const code = payload?.error_code ?? 0;
    throw new RoutingError(describeError(code, response.status, payload?.error), { status: response.status, code });
  }
  return payload;
}

function describeError(code, status, raw) {
  // 171: no edge near the location; 442/443: no path; 154/155: too far for the server limits.
  if (code === 171 || code === 170) return "Aucune route cyclable près de ce point.";
  if (code === 442 || code === 443) return "Aucun itinéraire à vélo entre ces deux points.";
  if (code === 154 || code === 155 || code === 157) return "Trop loin pour le serveur d'itinéraires : réduisez la vitesse ou l'échelle.";
  if (status === 429) return "Le serveur d'itinéraires est saturé. Réessayez dans quelques secondes.";
  return raw ? `Erreur du serveur d'itinéraires : ${raw}` : "Erreur du serveur d'itinéraires.";
}

function costingOptions(speed) {
  return {
    bicycle: {
      bicycle_type: "Hybrid",
      cycling_speed: speed,
      // Prefer cycleways and quiet roads, and avoid steep climbs when a reasonable alternative exists.
      use_roads: 0.3,
      use_hills: 0.3,
    },
  };
}

/**
 * Nested polygons of everything reachable within each distance (km) along the cycling network.
 * Returns [{ km, geometry }] sorted from nearest to farthest.
 */
export async function isodistances({ lat, lon }, maxKm, { speed }, signal) {
  const distances = Array.from({ length: BANDS }, (_, i) => Math.round(((maxKm * (i + 1)) / BANDS) * 1000) / 1000);
  const chunks = [];
  for (let i = 0; i < distances.length; i += CONTOURS_PER_REQUEST) chunks.push(distances.slice(i, i + CONTOURS_PER_REQUEST));
  const request = (chunk, metric) =>
    call(
      "isochrone",
      {
        locations: [{ lat, lon }],
        costing: "bicycle",
        costing_options: costingOptions(speed),
        // Isodistance contours: the time then simply follows from the chosen average speed.
        contours: chunk.map((km) => (metric === "distance" ? { distance: km } : { time: (km / speed) * 60 })),
        polygons: true,
        denoise: 0.1,
        generalize: Math.max(20, maxKm * 3),
      },
      signal,
    ).then((collection) =>
      collection.features
        .filter((feature) => feature.geometry && /Polygon/.test(feature.geometry.type))
        .map((feature) => ({
          km: metric === "distance" ? feature.properties.contour : (feature.properties.contour / 60) * speed,
          geometry: feature.geometry,
        })),
    );

  let results;
  try {
    results = await Promise.all(chunks.map((chunk) => request(chunk, "distance")));
  } catch (error) {
    // A server built without isodistance support rejects distance contours: fall back to time contours
    // computed at the chosen speed, which give the same picture with Valhalla's own hill and surface model.
    if (error.name === "AbortError" || error.code === 171 || error.status === 429 || !error.status) throw error;
    results = await Promise.all(chunks.map((chunk) => request(chunk, "time")));
  }
  return results.flat().sort((a, b) => a.km - b.km);
}

/** Cycling route between two points: geometry, length (km) and the main roads it follows. */
export async function route(from, to, { speed }, signal) {
  const result = await call(
    "route",
    {
      locations: [
        { lat: from.lat, lon: from.lon },
        { lat: to.lat, lon: to.lon },
      ],
      costing: "bicycle",
      costing_options: costingOptions(speed),
      directions_options: { language: "fr-FR", units: "kilometers" },
    },
    signal,
  );
  const leg = result.trip.legs[0];
  return {
    km: result.trip.summary.length,
    coordinates: decodePolyline(leg.shape, 6),
    roads: mainRoads(leg.maneuvers ?? []),
  };
}

/** Groups consecutive manoeuvres by road name and keeps the longest stretches, in route order. */
function mainRoads(maneuvers) {
  const stretches = [];
  for (const maneuver of maneuvers) {
    if (!maneuver.length) continue;
    const name = maneuver.street_names?.[0] ?? "Voie sans nom";
    const last = stretches.at(-1);
    if (last && last.name === name) last.km += maneuver.length;
    else stretches.push({ name, km: maneuver.length, index: stretches.length });
  }
  const longest = [...stretches].sort((a, b) => b.km - a.km).slice(0, 4);
  return longest.sort((a, b) => a.index - b.index).map(({ name, km }) => ({ name, km }));
}

export function decodePolyline(encoded, precision = 6) {
  const factor = 10 ** precision;
  const coordinates = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < encoded.length) {
    for (const axis of [0, 1]) {
      let result = 0;
      let shift = 0;
      let byte;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lon += delta;
    }
    coordinates.push([lon / factor, lat / factor]);
  }
  return coordinates;
}

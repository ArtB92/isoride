// Offline stand-in for Valhalla, the Géoplateforme geocoder and the tile server, for local tests:
//   node dev/mock-server.mjs   then   npm run dev:mock
// Shapes follow the real APIs; the geometry is synthetic (wobbly rings around the start).
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 8002);
const kmToLat = (km) => km / 111.32;
const kmToLon = (km, lat) => km / (111.32 * Math.cos((lat * Math.PI) / 180));

function ring(lat, lon, km) {
  const points = [];
  for (let i = 0; i <= 96; i += 1) {
    const a = (i / 96) * Math.PI * 2;
    // Same shape factor for every distance so the rings stay nested, like real isodistances.
    const f = 0.78 + 0.16 * Math.sin(3 * a + 0.4) + 0.07 * Math.cos(7 * a) + 0.05 * Math.sin(11 * a);
    points.push([lon + kmToLon(km * f * Math.cos(a), lat), lat + kmToLat(km * f * Math.sin(a))]);
  }
  points[points.length - 1] = points[0];
  return points;
}

function encode(coordinates, precision = 6) {
  const factor = 10 ** precision;
  let out = "";
  let last = [0, 0];
  const put = (value) => {
    let v = value < 0 ? ~(value << 1) : value << 1;
    while (v >= 0x20) {
      out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    out += String.fromCharCode(v + 63);
  };
  for (const [lon, lat] of coordinates) {
    const p = [Math.round(lat * factor), Math.round(lon * factor)];
    put(p[0] - last[0]);
    put(p[1] - last[1]);
    last = p;
  }
  return out;
}

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const body = url.searchParams.has("json") ? JSON.parse(url.searchParams.get("json")) : null;
  if (url.pathname === "/isochrone") {
    const { lat, lon } = body.locations[0];
    const speed = body.costing_options.bicycle.cycling_speed;
    const features = body.contours.map((c) => {
      const km = c.distance ?? (c.time / 60) * speed;
      return {
        type: "Feature",
        properties: { contour: c.distance ?? c.time, metric: c.distance ? "distance" : "time" },
        geometry: { type: "Polygon", coordinates: [ring(lat, lon, km)] },
      };
    });
    return setTimeout(() => json(res, 200, { type: "FeatureCollection", features: features.reverse() }), 300);
  }
  if (url.pathname === "/route") {
    const [a, b] = body.locations;
    const mid = [(a.lon + b.lon) / 2 + 0.02, (a.lat + b.lat) / 2 + 0.01];
    const coordinates = [[a.lon, a.lat], mid, [b.lon, b.lat]];
    const km = Math.hypot(kmToLatInv(b.lat - a.lat), kmToLatInv((b.lon - a.lon) * Math.cos((a.lat * Math.PI) / 180))) * 1.25;
    return json(res, 200, {
      trip: {
        summary: { length: km },
        legs: [
          {
            shape: encode(coordinates),
            maneuvers: [
              { street_names: ["Rue de Rivoli"], length: km * 0.2 },
              { street_names: ["Piste cyclable du canal"], length: km * 0.45 },
              { street_names: ["Avenue Jean Jaurès"], length: km * 0.25 },
              { length: km * 0.1 },
              { length: 0 },
            ],
          },
        ],
      },
    });
  }
  if (url.pathname === "/geocodage/search") {
    return json(res, 200, {
      features: [
        { geometry: { coordinates: [4.8597, 45.7606] }, properties: { label: "Gare de Lyon-Part-Dieu, Lyon", context: "69, Rhône, Auvergne-Rhône-Alpes" } },
        { geometry: { coordinates: [2.3735, 48.8443] }, properties: { label: "Gare de Lyon, Paris", context: "75, Paris, Île-de-France" } },
      ],
    });
  }
  if (url.pathname === "/geocodage/reverse") {
    return json(res, 200, { features: [{ properties: { name: "Quai de la Seine", city: "Paris", label: "Quai de la Seine 75019 Paris" } }] });
  }
  if (url.pathname === "/tiles.json") {
    return json(res, 200, { tilejson: "3.0.0", tiles: [`http://localhost:${PORT}/tiles/{z}/{x}/{y}.pbf`], minzoom: 0, maxzoom: 14 });
  }
  if (url.pathname.startsWith("/tiles/") || url.pathname.startsWith("/fonts/")) {
    res.writeHead(200, { "access-control-allow-origin": "*" });
    return res.end();
  }
  json(res, 404, { error: "not found" });
}).listen(PORT, () => console.log(`mock services on http://localhost:${PORT}`));

function kmToLatInv(deg) {
  return deg * 111.32;
}

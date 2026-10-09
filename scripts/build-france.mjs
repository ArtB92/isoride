// Extracts mainland France + Corsica from Natural Earth (world-atlas, 1:10m) into public/france.geojson.
// Run once with `npm run build:france`; the output is committed.
import { readFileSync, writeFileSync } from "node:fs";
import { feature } from "topojson-client";

const topo = JSON.parse(readFileSync(new URL("../node_modules/world-atlas/countries-10m.json", import.meta.url)));
const france = feature(topo, topo.objects.countries).features.find((f) => f.id === "250");
// Overseas territories are out of scope for now: keep the polygons inside metropolitan France's box.
const inMetropole = ([lon, lat]) => lon > -6 && lon < 10 && lat > 41 && lat < 52;
const polygons = france.geometry.coordinates.filter((polygon) => inMetropole(polygon[0][0]));
const round = (ring) => ring.map(([lon, lat]) => [Math.round(lon * 1e4) / 1e4, Math.round(lat * 1e4) / 1e4]);
const geometry = { type: "MultiPolygon", coordinates: polygons.map((polygon) => polygon.map(round)) };
writeFileSync(
  new URL("../public/france.geojson", import.meta.url),
  JSON.stringify({ type: "Feature", properties: { name: "France métropolitaine", source: "Natural Earth" }, geometry }),
);
console.log(`france.geojson: ${polygons.length} polygons, ${polygons.flat(2).length} points`);

// Navy basemap on OpenFreeMap vector tiles (OpenMapTiles schema, free, no key).
// Kept deliberately quiet so the travel-time colours carry the map.

export const TILES_URL = import.meta.env.VITE_TILES_URL ?? "https://tiles.openfreemap.org/planet";
const GLYPHS_URL = import.meta.env.VITE_GLYPHS_URL ?? "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";

export const NAVY = {
  background: "#0e1c3a",
  water: "#060f22",
  waterLine: "#0a1830",
  park: "#11234a",
  urban: "#13244a",
  roadMinor: "#21365f",
  roadMajor: "#2c4676",
  roadMotorway: "#38568a",
  rail: "#2a3f68",
  boundary: "#3b5585",
  label: "#8798bd",
  labelStrong: "#c3cee6",
  labelHalo: "#0b1730",
};

const minor = ["minor", "service", "track", "path"];
const major = ["primary", "secondary", "tertiary", "trunk"];

export function navyStyle() {
  return {
    version: 8,
    glyphs: GLYPHS_URL,
    sources: {
      openmaptiles: { type: "vector", url: TILES_URL },
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": NAVY.background } },
      {
        id: "landuse-urban",
        type: "fill",
        source: "openmaptiles",
        "source-layer": "landuse",
        filter: ["in", ["get", "class"], ["literal", ["residential", "suburb", "neighbourhood", "commercial", "industrial"]]],
        paint: { "fill-color": NAVY.urban, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 6, 0.4, 12, 0.8] },
      },
      {
        id: "park",
        type: "fill",
        source: "openmaptiles",
        "source-layer": "park",
        paint: { "fill-color": NAVY.park, "fill-opacity": 0.7 },
      },
      {
        id: "landcover-wood",
        type: "fill",
        source: "openmaptiles",
        "source-layer": "landcover",
        filter: ["==", ["get", "class"], "wood"],
        paint: { "fill-color": NAVY.park, "fill-opacity": 0.5 },
      },
      {
        id: "water",
        type: "fill",
        source: "openmaptiles",
        "source-layer": "water",
        paint: { "fill-color": NAVY.water },
      },
      {
        id: "waterway",
        type: "line",
        source: "openmaptiles",
        "source-layer": "waterway",
        paint: { "line-color": NAVY.water, "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.6, 14, 2.5] },
      },
      {
        id: "road-minor",
        type: "line",
        source: "openmaptiles",
        "source-layer": "transportation",
        minzoom: 11,
        filter: ["in", ["get", "class"], ["literal", minor]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": NAVY.roadMinor, "line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.4, 16, 3] },
      },
      {
        id: "road-major",
        type: "line",
        source: "openmaptiles",
        "source-layer": "transportation",
        minzoom: 6,
        filter: ["in", ["get", "class"], ["literal", major]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": NAVY.roadMajor, "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.4, 16, 6] },
      },
      {
        id: "road-motorway",
        type: "line",
        source: "openmaptiles",
        "source-layer": "transportation",
        minzoom: 5,
        filter: ["==", ["get", "class"], "motorway"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": NAVY.roadMotorway, "line-width": ["interpolate", ["linear"], ["zoom"], 5, 0.5, 16, 7] },
      },
      {
        id: "rail",
        type: "line",
        source: "openmaptiles",
        "source-layer": "transportation",
        minzoom: 9,
        filter: ["==", ["get", "class"], "rail"],
        paint: { "line-color": NAVY.rail, "line-width": 1, "line-dasharray": [3, 2] },
      },
      {
        id: "boundary",
        type: "line",
        source: "openmaptiles",
        "source-layer": "boundary",
        filter: ["all", ["<=", ["get", "admin_level"], 4], ["!=", ["get", "maritime"], 1]],
        paint: {
          "line-color": NAVY.boundary,
          "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.6, 10, 1.4],
          "line-dasharray": [3, 2],
        },
      },
    ],
  };
}

/** Place labels go on top of every travel-time layer, so they are added last. */
export function labelLayers() {
  return [
    {
      id: "place-labels",
      type: "symbol",
      source: "openmaptiles",
      "source-layer": "place",
      filter: ["in", ["get", "class"], ["literal", ["city", "town", "village"]]],
      layout: {
        "text-field": ["coalesce", ["get", "name:fr"], ["get", "name"]],
        "text-font": ["Noto Sans Bold"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 5, ["match", ["get", "class"], "city", 12, 9], 12, ["match", ["get", "class"], "city", 17, "town", 14, 12]],
        "text-transform": "uppercase",
        "text-letter-spacing": 0.04,
        "symbol-sort-key": ["coalesce", ["get", "rank"], 99],
      },
      paint: {
        "text-color": ["match", ["get", "class"], "city", NAVY.labelStrong, NAVY.label],
        "text-halo-color": NAVY.labelHalo,
        "text-halo-width": 1.4,
      },
    },
  ];
}

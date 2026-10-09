// À portée de vélo: how far can you cycle in France from a starting point, at a chosen average speed.
// UI and interactions follow tram.camilleroux.com; the network distances come from Valhalla (see routing.js).

import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import { navyStyle, labelLayers, NAVY } from "./basemap.js";
import { MAX_KM, RoutingError, isodistances, route } from "./routing.js";
import { searchAddress, placeName } from "./geocode.js";
import { PALETTE, buildField, contour, fieldCorners, fieldLngLatBounds, fieldStats, paintHeat } from "./field.js";
import { reachRoads } from "./roads.js";

const DEFAULT_FROM = { lat: 48.85661, lon: 2.35222, label: "Hôtel de Ville, Paris" };
const DEFAULT_SPEED = 18;
const DEFAULT_MAX = 360;
const MIN_SPEED = 8;
const MAX_SPEED = 45;
const REACH_MINUTES = 30;
const FRANCE_VIEW = [
  [-5.2, 41.3],
  [9.6, 51.1],
];
// Bicycles are not allowed on motorways; everything else in the tiles can be part of a ride.
const RIDEABLE = ["trunk", "primary", "secondary", "tertiary", "minor", "service", "track", "path"];
const BLANK_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const $ = (id) => document.getElementById(id);
const number = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });

const state = {
  from: null, // { lat, lon, label }
  to: null, // { lat, lon, label }
  speed: DEFAULT_SPEED,
  maxMinutes: DEFAULT_MAX,
  mode: "heat",
  heatFrom: "from", // the heatmap starts from the departure or from the arrival
  field: null,
  fieldKey: null,
  trip: null, // { km, coordinates, roads }
  france: null,
  fitted: false,
  ceiling: null, // { key, km }: smallest range the server failed on from this start
  ready: false, // overlay sources and layers added
};

// --- Small helpers --------------------------------------------------------------

function formatMinutes(minutes) {
  if (!Number.isFinite(minutes)) return "—";
  if (minutes < 1) return "< 1 min";
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes - hours * 60);
  return rest === 60 ? `${hours + 1} h 00` : `${hours} h ${String(rest).padStart(2, "0")}`;
}

const formatKm = (km) => `${km < 10 ? number.format(km) : integer.format(km)} km`;
const minutesFor = (km) => (km / state.speed) * 60;
const coordsLabel = ({ lat, lon }) => `${number.format(lat)}° N, ${number.format(lon)}° E`;

function toast(message) {
  const element = $("toast");
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    element.hidden = true;
  }, 2600);
}

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inFrance({ lat, lon }) {
  if (!state.france) return true;
  return state.france.geometry.coordinates.some((polygon) => pointInRing([lon, lat], polygon[0]));
}

// --- Map ------------------------------------------------------------------------

const map = new maplibregl.Map({
  container: "map",
  style: navyStyle(),
  bounds: FRANCE_VIEW,
  minZoom: 4,
  maxZoom: 17,
  maxBounds: [
    [-14, 36],
    [20, 56],
  ],
  attributionControl: false,
  dragRotate: false,
  pitchWithRotate: false,
});
map.touchZoomRotate.disableRotation();
map.keyboard.disableRotation();
map.addControl(
  new maplibregl.AttributionControl({
    compact: true,
    customAttribution:
      '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · <a href="https://openfreemap.org">OpenFreeMap</a> · <a href="https://github.com/valhalla/valhalla">Valhalla</a>',
  }),
  "bottom-right",
);

const emptyCollection = { type: "FeatureCollection", features: [] };

function addOverlayLayers() {
  map.addSource("heat", {
    type: "image",
    url: BLANK_IMAGE,
    coordinates: [
      [0, 0.001],
      [0.001, 0.001],
      [0.001, 0],
      [0, 0],
    ],
  });
  map.addLayer({
    id: "heat",
    type: "raster",
    source: "heat",
    paint: { "raster-resampling": "linear", "raster-fade-duration": 0, "raster-opacity": 1 },
  }, "water"); // water and roads stay drawn over the colours, as on the original map

  // Everything outside metropolitan France is dimmed: the map only promises France for now.
  const world = [
    [-180, -85],
    [180, -85],
    [180, 85],
    [-180, 85],
    [-180, -85],
  ];
  const holes = state.france ? state.france.geometry.coordinates.map((polygon) => polygon[0]) : [];
  map.addSource("france-mask", {
    type: "geojson",
    data: { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [world, ...holes] } },
  });
  map.addLayer({ id: "france-mask", type: "fill", source: "france-mask", paint: { "fill-color": "#040a18", "fill-opacity": 0.55 } });
  if (state.france) {
    map.addSource("france", { type: "geojson", data: state.france });
    map.addLayer({
      id: "france-outline",
      type: "line",
      source: "france",
      paint: { "line-color": NAVY.boundary, "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.8, 10, 1.6] },
    });
  }

  map.addSource("reach-roads", { type: "geojson", data: emptyCollection, buffer: 4, tolerance: 0.2 });
  map.addLayer(
    {
      id: "reach-roads",
      type: "line",
      source: "reach-roads",
      layout: { "line-cap": "round", "line-join": "round", visibility: state.mode === "routes" ? "visible" : "none" },
      paint: { "line-width": ["interpolate", ["linear"], ["zoom"], 6, 1, 10, 1.6, 14, 3.4, 17, 6], "line-color": "#fff" },
    },
    "france-mask",
  );

  map.addSource("contours", { type: "geojson", data: emptyCollection });
  map.addLayer({
    id: "contour-halo",
    type: "line",
    source: "contours",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "rgba(255,255,255,0.75)", "line-width": 4.5 },
  });
  map.addLayer({
    id: "contour",
    type: "line",
    source: "contours",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#071022", "line-width": ["case", [">=", ["get", "minutes"], 60], 2, 1.4] },
  });

  map.addSource("trip", { type: "geojson", data: emptyCollection });
  map.addLayer({
    id: "trip-casing",
    type: "line",
    source: "trip",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#071022", "line-width": 7 },
  });
  map.addLayer({
    id: "trip",
    type: "line",
    source: "trip",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#ffffff", "line-width": 3.5 },
  });

  for (const layer of labelLayers()) map.addLayer(layer);
}

/** "Routes" view: every rideable road of the loaded tiles, cut into pieces coloured by distance (see roads.js). */
let roadsTimer = null;

function scheduleRoads(delay = 200) {
  clearTimeout(roadsTimer);
  roadsTimer = setTimeout(refreshRoads, delay);
}

function refreshRoads() {
  if (!state.ready || state.mode !== "routes" || !state.field) return;
  const features = map.querySourceFeatures("openmaptiles", {
    sourceLayer: "transportation",
    filter: ["in", ["get", "class"], ["literal", RIDEABLE]],
  });
  // About 100 colour steps over the whole range: smooth to the eye, few enough pieces to stay fast.
  map.getSource("reach-roads").setData(reachRoads(features, state.field, state.field.maxKm / 100));
}

/** Colour by distance for the current speed and scale; pieces beyond the scale are hidden. */
function roadPaint() {
  const maxKm = neededKm();
  return {
    color: ["interpolate", ["linear"], ["get", "km"], ...PALETTE.flatMap(([t, [r, g, b]]) => [t * maxKm, `rgb(${r}, ${g}, ${b})`])],
    opacity: ["step", ["get", "km"], 1, maxKm, 0],
  };
}

// --- Markers --------------------------------------------------------------------

function markerElement(kind) {
  const element = document.createElement("div");
  element.className = `marker marker-${kind}`;
  const label = document.createElement("span");
  label.className = "marker-label";
  element.append(label);
  return element;
}

const fromMarker = new maplibregl.Marker({ element: markerElement("from"), draggable: true });
const toMarker = new maplibregl.Marker({ element: markerElement("to"), draggable: true });
fromMarker.getElement().querySelector(".marker-label").textContent = "Départ";
fromMarker.on("dragend", () => {
  const { lng, lat } = fromMarker.getLngLat();
  setFrom({ lat, lon: lng });
});
toMarker.on("dragend", () => {
  const { lng, lat } = toMarker.getLngLat();
  setTo({ lat, lon: lng });
});

let contourLabels = [];

// --- Computing and drawing --------------------------------------------------------

const neededKm = () => (state.speed * state.maxMinutes) / 60;
// What is asked of the routing server, which stops at MAX_KM.
const fetchKm = () => Math.min(neededKm(), MAX_KM);
const heatSource = () => (state.heatFrom === "to" && state.to ? state.to : state.from);
let computeController = null;
let computeTimer = null;

function scheduleCompute(delay = 0) {
  clearTimeout(computeTimer);
  computeTimer = setTimeout(compute, delay);
}

// Shorter ranges tried, in km, when the server cannot compute the requested one.
const FALLBACK_KM = [150, 100, 70, 45, 30, 20, 12];

async function compute() {
  const source = heatSource();
  if (!source) return;
  const key = `${source.lat.toFixed(5)},${source.lon.toFixed(5)}`;
  const need = fetchKm();
  // Smallest range already known to fail from this start: no point asking for it again.
  const ceiling = state.ceiling?.key === key ? state.ceiling.km : Infinity;
  const ranges = [need, ...FALLBACK_KM.filter((km) => km < need)].filter((km) => km < ceiling);
  const field = state.field;
  if (field && state.fieldKey === key) {
    // A field computed further than needed still works (it is cropped by the colour scale), as long as
    // it is not so much bigger that the grid becomes coarse. One cut short by the server stays as is
    // until a range it could still extend to is asked for.
    if (field.maxKm >= need * 0.98 && field.maxKm <= need * 1.8) return;
    if (field.maxKm < need && (!ranges.length || ranges[0] <= field.maxKm * 1.02)) return;
  }
  if (!ranges.length) return;

  computeController?.abort();
  const controller = new AbortController();
  computeController = controller;
  $("loading").hidden = false;
  try {
    let bands = null;
    for (const km of ranges) {
      try {
        bands = await isodistances(source, km, { speed: state.speed }, controller.signal);
        break;
      } catch (error) {
        if (!(error instanceof RoutingError) || !error.tooFar || km === ranges.at(-1)) throw error;
        state.ceiling = { key, km };
        $("loading").lastChild.textContent = `Trop loin pour le serveur, essai à ${formatKm(ranges[ranges.indexOf(km) + 1])}…`;
      }
    }
    if (!bands?.length) throw new RoutingError("Aucune route cyclable près de ce point.");
    state.field = buildField(source, bands);
    state.fieldKey = key;
    showError(null);
    if (state.field.maxKm < need * 0.98) toast(`Le serveur d'itinéraires gratuit s'arrête à ${formatKm(state.field.maxKm)} de route depuis ce point.`);
    scheduleRoads(0);
    if (!state.fitted) {
      state.fitted = true;
      fitToField(false);
    }
  } catch (error) {
    if (error.name === "AbortError") return;
    showError(error.message);
  } finally {
    if (computeController === controller) {
      computeController = null;
      $("loading").hidden = true;
      $("loading").lastChild.textContent = "Calcul des trajets…";
    }
  }
  redraw();
}

function showError(message) {
  $("tripError").hidden = !message;
  $("tripError").textContent = message ?? "";
}

/** Isochrone lines drawn for the current scale: every 15, 30 or 60 minutes depending on its length. */
function isochrones() {
  const step = state.maxMinutes <= 60 ? 15 : state.maxMinutes <= 180 ? 30 : 60;
  const lines = [];
  for (let minutes = step; minutes <= state.maxMinutes; minutes += step) lines.push(minutes);
  return lines;
}

/** Everything that depends on speed or scale but needs no new routing. */
function redraw() {
  updateLegend();
  updatePanel();
  const { field } = state;
  if (!field || !state.ready) return;

  map.getSource("heat").updateImage({
    url: paintHeat(field, { speed: state.speed, maxMinutes: state.maxMinutes }),
    coordinates: fieldCorners(field),
  });

  const paint = roadPaint();
  map.setPaintProperty("reach-roads", "line-color", paint.color);
  map.setPaintProperty("reach-roads", "line-opacity", paint.opacity);

  const features = [];
  for (const label of contourLabels) label.remove();
  contourLabels = [];
  // Labels keep clear of the markers and of each other.
  const taken = [state.from, state.to].filter(Boolean).flatMap((place) => {
    const point = map.project([place.lon, place.lat]);
    // The marker and the name tag drawn above it.
    return [point, { x: point.x, y: point.y - 32 }];
  });
  for (const minutes of isochrones()) {
    const km = (state.speed * minutes) / 60;
    if (km > field.maxKm * 1.001) continue;
    const { segments, labels } = contour(field, km);
    if (!segments.length) continue;
    features.push({ type: "Feature", properties: { minutes }, geometry: { type: "MultiLineString", coordinates: segments } });
    const spot = labels.find((lngLat) => {
      const point = map.project(lngLat);
      return taken.every((other) => Math.abs(point.x - other.x) > 70 || Math.abs(point.y - other.y) > 34);
    });
    if (spot) {
      taken.push(map.project(spot));
      const element = document.createElement("div");
      element.className = "contour-label";
      element.textContent = minutes < 60 ? `${minutes} min` : formatMinutes(minutes).replace(" 00", "");
      contourLabels.push(new maplibregl.Marker({ element, anchor: "center" }).setLngLat(spot).addTo(map));
    }
  }
  map.getSource("contours").setData({ type: "FeatureCollection", features });
}

function setMode(mode) {
  state.mode = mode === "routes" ? "routes" : "heat";
  for (const button of document.querySelectorAll(".map-mode button")) {
    button.setAttribute("aria-pressed", String(button.dataset.mode === state.mode));
  }
  for (const input of document.querySelectorAll('input[name="mode"]')) input.checked = input.value === state.mode;
  if (state.ready) {
    map.setLayoutProperty("heat", "visibility", state.mode === "heat" ? "visible" : "none");
    map.setLayoutProperty("reach-roads", "visibility", state.mode === "routes" ? "visible" : "none");
    scheduleRoads(0);
  }
  syncUrl();
}

function fitToField(animate = true) {
  if (!state.field) return;
  const wide = map.getContainer().clientWidth > 720;
  map.fitBounds(fieldLngLatBounds(state.field), {
    padding: { top: 40, bottom: 40, left: wide ? 320 : 30, right: wide ? 70 : 30 },
    animate,
    maxZoom: 14,
  });
}

// --- Departure, arrival and the panel ----------------------------------------------

async function nameOf(place) {
  const name = await placeName(place);
  if (name) place.label = name;
  else place.label ??= coordsLabel(place);
  updatePanel();
}

function setFrom(point, label = null, { quiet = false } = {}) {
  if (!inFrance(point)) {
    toast("La carte couvre la France métropolitaine et la Corse pour l'instant.");
    if (state.from) fromMarker.setLngLat([state.from.lon, state.from.lat]);
    return false;
  }
  state.from = { lat: point.lat, lon: point.lon, label };
  fromMarker.setLngLat([point.lon, point.lat]).addTo(map);
  if (!label) {
    state.from.label = "Recherche du lieu…";
    nameOf(state.from);
  }
  if (state.heatFrom === "from") scheduleCompute();
  if (state.to) fetchTrip();
  updatePanel();
  if (!quiet) syncUrl();
  return true;
}

function setTo(point, label = null, { quiet = false } = {}) {
  if (!inFrance(point)) {
    toast("La carte couvre la France métropolitaine et la Corse pour l'instant.");
    if (state.to) toMarker.setLngLat([state.to.lon, state.to.lat]);
    return false;
  }
  state.to = { lat: point.lat, lon: point.lon, label };
  toMarker.setLngLat([point.lon, point.lat]).addTo(map);
  if (!label) {
    state.to.label = "Recherche du lieu…";
    nameOf(state.to);
  }
  if (state.heatFrom === "to") scheduleCompute();
  fetchTrip();
  if (!quiet) syncUrl();
  return true;
}

function removeTo() {
  state.to = null;
  state.trip = null;
  toMarker.remove();
  map.getSource("trip")?.setData(emptyCollection);
  setHeatFrom("from");
  updatePanel();
  syncUrl();
}

function setHeatFrom(source) {
  state.heatFrom = source === "to" && state.to ? "to" : "from";
  for (const button of $("heatFrom").querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.source === state.heatFrom));
  }
  scheduleCompute();
  syncUrl();
}

let tripController = null;

async function fetchTrip() {
  tripController?.abort();
  if (!state.from || !state.to) return;
  const controller = new AbortController();
  tripController = controller;
  state.trip = null;
  updatePanel();
  try {
    state.trip = await route(state.from, state.to, { speed: state.speed }, controller.signal);
    showError(null);
    map.getSource("trip")?.setData({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: state.trip.coordinates } });
  } catch (error) {
    if (error.name === "AbortError") return;
    map.getSource("trip")?.setData(emptyCollection);
    showError(error.message);
  }
  updatePanel();
}

function updatePanel() {
  $("tripFrom").textContent = state.from?.label ?? "—";
  const result = $("tripResult");
  const toLabel = toMarker.getElement().querySelector(".marker-label");
  if (!state.to) {
    result.hidden = true;
    $("tripHint").hidden = false;
  } else {
    result.hidden = false;
    $("tripHint").hidden = true;
    $("tripTo").textContent = state.to.label ?? "";
    const trip = state.trip;
    const duration = trip ? formatMinutes(minutesFor(trip.km)) : "…";
    $("tripDuration").textContent = duration;
    $("tripDistance").textContent = trip ? `${formatKm(trip.km)} à ${state.speed} km/h de moyenne` : "Calcul de l'itinéraire…";
    toLabel.textContent = state.heatFrom === "to" ? `Arrivée · ${duration}` : duration;
    $("tripSteps").replaceChildren(
      ...(trip?.roads ?? []).map((road) => {
        const item = document.createElement("li");
        const badge = document.createElement("span");
        badge.className = "badge";
        if (/piste|voie verte|cyclable|véloroute|eurovelo/i.test(road.name)) badge.classList.add("cycleway");
        badge.textContent = formatKm(road.km);
        const text = document.createElement("span");
        text.textContent = road.name;
        const minutes = document.createElement("span");
        minutes.className = "minutes";
        minutes.textContent = formatMinutes(minutesFor(road.km));
        item.append(badge, text, minutes);
        return item;
      }),
    );
  }
  updateReach();
}

function updateReach() {
  const { field } = state;
  if (!field) {
    $("reach").textContent = "";
    return;
  }
  const reachMinutes = Math.min(REACH_MINUTES, state.maxMinutes);
  const stats = fieldStats(field, { speed: state.speed, maxMinutes: state.maxMinutes, reachMinutes });
  const where = state.heatFrom === "to" && state.to ? "de cette arrivée" : "de ce départ";
  const computing = !$("loading").hidden;
  $("reach").textContent = `Environ ${integer.format(stats.reachArea)} km² sont à moins de ${reachMinutes} minutes ${where}, à ${state.speed} km/h${
    !stats.complete && computing ? " (calcul en cours pour la nouvelle échelle)." : "."
  }`;
  if (!stats.complete && !computing) {
    const minutes = formatMinutes(minutesFor(field.maxKm));
    $("reach").textContent += ` La carte s'arrête à ${formatKm(field.maxKm)} de route (${minutes} à cette vitesse) : le serveur d'itinéraires gratuit ne calcule pas plus loin.`;
  }
  const set = (key, value, label) => {
    document.querySelector(`[data-stat="${key}"]`).textContent = value;
    if (label) document.querySelector(`[data-stat-label="${key}"]`).textContent = label;
  };
  set("area30", `${integer.format(stats.reachArea)} km²`, `accessibles en moins de ${reachMinutes} min`);
  set("areaMax", `${integer.format(stats.maxArea)} km²`, `accessibles en moins de ${formatMinutes(state.maxMinutes)}, l'échelle choisie`);
  set("farthest", formatKm(stats.farthest), `à vol d'oiseau : le point le plus éloigné atteint en ${formatMinutes(state.maxMinutes)}`);
  set("detour", stats.detour ? `+${integer.format((stats.detour - 1) * 100)} %` : "—", "de distance en plus en moyenne par la route, par rapport à la ligne droite");
}

function updateLegend() {
  const stops = PALETTE.map(([t, [r, g, b]]) => `rgb(${r}, ${g}, ${b}) ${Math.round(t * 100)}%`);
  $("legendBar").style.background = `linear-gradient(90deg, ${stops.join(", ")})`;
  $("legendMid").textContent = formatMinutes(state.maxMinutes / 2);
  $("legendMax").textContent = formatMinutes(state.maxMinutes);
  $("legendMidKm").textContent = formatKm(neededKm() / 2);
  $("legendMaxKm").textContent = formatKm(neededKm());
  $("maxValue").textContent = formatMinutes(state.maxMinutes);
  $("speedValue").textContent = `${state.speed} km/h`;
}

// --- URL ------------------------------------------------------------------------------

const formatPair = ({ lat, lon }) => `${lat.toFixed(5)},${lon.toFixed(5)}`;

function parsePair(value) {
  const match = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(value || "");
  return match ? { lat: Number(match[1]), lon: Number(match[2]) } : null;
}

function syncUrl() {
  const params = new URLSearchParams(location.search);
  for (const key of ["from", "to", "carte", "vitesse", "max", "vue"]) params.delete(key);
  if (state.from) params.set("from", formatPair(state.from));
  if (state.to) params.set("to", formatPair(state.to));
  if (state.to && state.heatFrom === "to") params.set("carte", "arrivee");
  if (state.speed !== DEFAULT_SPEED) params.set("vitesse", String(state.speed));
  if (state.maxMinutes !== DEFAULT_MAX) params.set("max", String(state.maxMinutes));
  if (state.mode !== "heat") params.set("vue", state.mode);
  const query = params.toString().replaceAll("%2C", ",");
  history.replaceState(null, "", query ? `?${query}` : location.pathname);
}

function restoreFromUrl() {
  const params = new URLSearchParams(location.search);
  const speed = Number(params.get("vitesse"));
  if (speed >= MIN_SPEED && speed <= MAX_SPEED) state.speed = Math.round(speed);
  const max = Number(params.get("max"));
  if (max >= 15 && max <= 360) state.maxMinutes = Math.round(max / 15) * 15;
  $("speedRange").value = String(state.speed);
  $("maxRange").value = String(state.maxMinutes);
  updateSpeedFill();
  setMode(params.get("vue"));

  const from = parsePair(params.get("from"));
  if (!from || !setFrom(from, null, { quiet: true })) setFrom(DEFAULT_FROM, DEFAULT_FROM.label, { quiet: true });
  const to = parsePair(params.get("to"));
  if (to && setTo(to, null, { quiet: true }) && params.get("carte") === "arrivee") setHeatFrom("to");
  map.jumpTo({ center: [state.from.lon, state.from.lat], zoom: 9 });
}

// --- Address search ------------------------------------------------------------------

let searchController = null;
let searchTimer = null;

function showResults(results) {
  const list = $("searchResults");
  list.replaceChildren(
    ...results.map((result) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = result.label;
      if (result.context) {
        const context = document.createElement("small");
        context.textContent = result.context;
        button.append(context);
      }
      button.addEventListener("click", () => chooseResult(result));
      item.append(button);
      return item;
    }),
  );
  list.hidden = !results.length;
}

function chooseResult(result) {
  $("searchResults").hidden = true;
  $("searchInput").value = result.label;
  if (setFrom({ lat: result.lat, lon: result.lon }, result.label)) {
    state.fitted = false;
    map.flyTo({ center: [result.lon, result.lat], zoom: Math.max(map.getZoom(), 9) });
    syncUrl();
  }
}

async function runSearch(query, { pickFirst = false } = {}) {
  searchController?.abort();
  if (query.trim().length < 3) {
    showResults([]);
    return;
  }
  const controller = new AbortController();
  searchController = controller;
  try {
    const results = await searchAddress(query, controller.signal);
    if (pickFirst && results.length) chooseResult(results[0]);
    else if (pickFirst) toast("Aucune adresse trouvée en France.");
    else showResults(results);
  } catch (error) {
    if (error.name !== "AbortError") toast(error.message);
  }
}

$("searchInput").addEventListener("input", (event) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(event.target.value), 250);
});
$("searchForm").addEventListener("submit", (event) => {
  event.preventDefault();
  clearTimeout(searchTimer);
  runSearch($("searchInput").value, { pickFirst: true });
});
document.addEventListener("click", (event) => {
  if (!$("searchForm").contains(event.target)) $("searchResults").hidden = true;
});

// --- Controls --------------------------------------------------------------------------

/** The big speed slider fills up to its thumb with the accent colour. */
function updateSpeedFill() {
  const t = (state.speed - MIN_SPEED) / (MAX_SPEED - MIN_SPEED);
  $("speedRange").style.setProperty("--fill", `${Math.round(t * 1000) / 10}%`);
}

$("speedRange").addEventListener("input", (event) => {
  state.speed = Number(event.target.value);
  updateSpeedFill();
  redraw();
  scheduleCompute(450);
  syncUrl();
});
$("maxRange").addEventListener("input", (event) => {
  state.maxMinutes = Number(event.target.value);
  redraw();
  scheduleCompute(450);
  syncUrl();
});
$("modeToggles").addEventListener("change", (event) => setMode(event.target.value));
for (const button of document.querySelectorAll(".map-mode button")) {
  button.addEventListener("click", () => setMode(button.dataset.mode));
}
for (const button of $("heatFrom").querySelectorAll("button")) {
  button.addEventListener("click", () => setHeatFrom(button.dataset.source));
}
$("removeTo").addEventListener("click", removeTo);

$("swap").addEventListener("click", () => {
  if (!state.to) {
    toast("Posez d'abord une arrivée en cliquant sur la carte.");
    return;
  }
  const [from, to] = [state.to, state.from];
  setFrom(from, from.label, { quiet: true });
  setTo(to, to.label);
});

$("locate").addEventListener("click", () => {
  if (!navigator.geolocation) {
    toast("La géolocalisation n'est pas disponible dans ce navigateur.");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      if (setFrom({ lat: coords.latitude, lon: coords.longitude })) {
        state.fitted = false;
        map.flyTo({ center: [coords.longitude, coords.latitude], zoom: 10 });
      }
    },
    () => toast("Position introuvable. Autorisez la localisation ou cherchez une adresse."),
    { enableHighAccuracy: false, timeout: 10000 },
  );
});

$("share").addEventListener("click", async () => {
  syncUrl();
  try {
    if (navigator.share && matchMedia("(pointer: coarse)").matches) {
      await navigator.share({ title: document.title, url: location.href });
      return;
    }
    await navigator.clipboard.writeText(location.href);
    toast("Lien copié");
  } catch (error) {
    if (error.name !== "AbortError") toast("Copiez l'adresse de la page pour partager cette carte.");
  }
});

$("zoomIn").addEventListener("click", () => map.zoomIn());
$("zoomOut").addEventListener("click", () => map.zoomOut());
$("recenter").addEventListener("click", () => fitToField());
$("fullscreen").addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else $("mapStage").requestFullscreen?.();
});
document.addEventListener("fullscreenchange", () => map.resize());

map.on("click", (event) => setTo({ lat: event.lngLat.lat, lon: event.lngLat.lng }));
// New basemap tiles bring new roads to colour.
map.on("moveend", () => scheduleRoads());
map.on("sourcedata", (event) => {
  if (event.sourceId === "openmaptiles" && event.tile) scheduleRoads(300);
});

// --- Start ------------------------------------------------------------------------------

async function init() {
  updateLegend();
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}france.geojson`);
    state.france = await response.json();
  } catch {
    state.france = null;
  }
  // "style.load" rather than "load": the overlays must not wait for basemap tiles, which may be slow.
  const start = () => {
    addOverlayLayers();
    state.ready = true;
    restoreFromUrl();
  };
  if (map.style?._loaded) start();
  else map.once("style.load", start);
}

init();

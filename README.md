# À portée de vélo (isoride)

Interactive map of how far you can cycle in France. Pick a starting point and an average speed: the map colours every
place by the time it takes to ride there along roads and cycleways, either as a heatmap or by colouring the reachable
roads only. Click anywhere to get the route, its length and its duration at your speed.

The UI and interactions follow [À portée de tram](https://tram.camilleroux.com/) by Camille Roux
([source](https://github.com/camilleroux/montpellier-temps-transport)), recoloured with a navy night theme.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173, uses the public services below
npm run build      # static site in dist/, deployable anywhere
```

Offline, with fake routing, geocoding and empty basemap tiles:

```bash
npm run mock       # in one terminal: stand-in services on :8002
npm run dev:mock   # in another
```

Pushing to `main` deploys to GitHub Pages through `.github/workflows/pages.yml` once Pages is set to
"GitHub Actions" in the repository settings.

## Data and services

All free, no API key:

| What | Service | Why |
| --- | --- | --- |
| Cycling reachability and routes | [Valhalla](https://github.com/valhalla/valhalla) on the public [FOSSGIS](https://fossgis.de/) server, OpenStreetMap data | Bicycle profile that knows cycleways, bike bans and surfaces; isodistance contours; CORS enabled |
| Basemap | [OpenFreeMap](https://openfreemap.org/) vector tiles (OpenMapTiles schema) | No key, no request limits; the style is our own navy one (`src/basemap.js`) |
| Address search | [Géoplateforme IGN](https://geoservices.ign.fr/documentation/services/services-geoplateforme/geocodage) (Base Adresse Nationale) | Official French address database, successor of api-adresse.data.gouv.fr |
| France outline | Natural Earth via `world-atlas` (`npm run build:france`) | Dims the map outside metropolitan France and Corsica |

Each one can be swapped with an environment variable: `VITE_VALHALLA_URL`, `VITE_TILES_URL`, `VITE_GLYPHS_URL`,
`VITE_GEOCODER_URL`. The FOSSGIS server is shared and best-effort; for real traffic, run your own Valhalla with France
loaded (for example `ghcr.io/valhalla/valhalla-scripted` with the Geofabrik France extract) and point
`VITE_VALHALLA_URL` at it.

## How it works

1. For the starting point, Valhalla returns 8 nested isodistance polygons (two requests of 4 contours) up to
   `speed × scale` kilometres along the cycling network.
2. `src/field.js` rasterises them on a Web Mercator grid and, inside each band, interpolates the distance from how far
   each cell is from the inner and outer boundaries (exact Euclidean distance transforms). That turns stepped contours
   into a smooth distance field.
3. Time is distance divided by the average speed, so moving the speed or scale slider repaints instantly; a new
   request only goes out when the reach grows past what was computed, or shrinks enough to need a finer grid.
4. The heatmap is painted from the field and drawn as an image layer; isochrone lines are traced from the same field
   with marching squares.
5. "Routes seules" colours the basemap's road layer inside each band polygon (MapLibre `within` filter) instead of
   drawing the heatmap.

Limits: the speed is an average over the whole ride (slopes influence the chosen route but not its duration), and in
"Routes seules" a road crossing a band boundary takes the colour of the outer band.

## Credits

Map data © OpenStreetMap contributors (ODbL). Routing by Valhalla. Original idea and design: À portée de tram.

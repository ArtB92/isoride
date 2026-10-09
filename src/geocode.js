// Address search and reverse geocoding with the IGN Géoplateforme (Base Adresse Nationale), free and keyless.

const GEOCODER_URL = (import.meta.env.VITE_GEOCODER_URL ?? "https://data.geopf.fr/geocodage").replace(/\/$/, "");

export async function searchAddress(query, signal) {
  const url = `${GEOCODER_URL}/search?q=${encodeURIComponent(query)}&limit=6&autocomplete=1`;
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error("Recherche d'adresse indisponible.");
  const { features = [] } = await response.json();
  return features.map(({ geometry, properties }) => ({
    lon: geometry.coordinates[0],
    lat: geometry.coordinates[1],
    label: properties.label,
    context: properties.context,
  }));
}

/** Short place name for a point ("Rue de Rivoli, Paris"), or null when the service has nothing nearby. */
export async function placeName({ lat, lon }, signal) {
  try {
    const url = `${GEOCODER_URL}/reverse?lon=${lon}&lat=${lat}&limit=1`;
    const response = await fetch(url, { signal });
    if (!response.ok) return null;
    const [feature] = (await response.json()).features ?? [];
    if (!feature) return null;
    const { name, city, label } = feature.properties;
    return name && city && name !== city ? `${name}, ${city}` : label ?? null;
  } catch {
    return null;
  }
}

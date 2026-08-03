/* coords.js
 * Real coordinate system support for the Smart Survey Notebook.
 * Default: NAD83 New York State Plane, Long Island Zone (EPSG:2263), US Survey Feet.
 * Fallback: a local flat-earth tangent plane (meters) anchored to the project origin,
 * used only if the student switches the "Coordinate System" selector to Local.
 */

const Coords = (() => {
  // Standard proj4 definition for EPSG:2263 (NAD83 / New York Long Island, US ft)
  proj4.defs(
    "EPSG:2263",
    "+proj=lcc +lat_1=41.03333333333333 +lat_2=40.66666666666666 +lat_0=40.16666666666667 " +
    "+lon_0=-74 +x_0=300000.0001016001 +y_0=0 +ellps=GRS80 +datum=NAD83 " +
    "+to_meter=0.3048006096012192 +no_defs"
  );

  const toStatePlane = proj4("EPSG:4326", "EPSG:2263");

  let origin = null; // { lat, lng } used for LOCAL mode
  let mode = "EPSG:2263";

  function setMode(m) {
    mode = m;
  }

  function setOrigin(lat, lng) {
    origin = { lat, lng };
  }

  function getOrigin() {
    return origin;
  }

  // Local flat-earth approximation: meters north/east of origin.
  function localForward(lat, lng) {
    if (!origin) origin = { lat, lng };
    const R = 6378137; // meters
    const dLat = ((lat - origin.lat) * Math.PI) / 180;
    const dLng = ((lng - origin.lng) * Math.PI) / 180;
    const northing = dLat * R;
    const easting = dLng * R * Math.cos((origin.lat * Math.PI) / 180);
    return { northing, easting };
  }

  function localInverse(northing, easting) {
    if (!origin) origin = { lat: 0, lng: 0 };
    const R = 6378137;
    const dLat = northing / R;
    const dLng = easting / (R * Math.cos((origin.lat * Math.PI) / 180));
    const lat = origin.lat + (dLat * 180) / Math.PI;
    const lng = origin.lng + (dLng * 180) / Math.PI;
    return { lat, lng };
  }

  /** lat/lng (WGS84) -> { northing, easting } in current coordinate system units */
  function forward(lat, lng) {
    if (mode === "LOCAL") return localForward(lat, lng);
    const [easting, northing] = toStatePlane.forward([lng, lat]);
    return { northing, easting };
  }

  /** { northing, easting } -> { lat, lng } (WGS84) */
  function inverse(northing, easting) {
    if (mode === "LOCAL") return localInverse(northing, easting);
    const [lng, lat] = toStatePlane.inverse([easting, northing]);
    return { lat, lng };
  }

  function unitLabel() {
    return mode === "LOCAL" ? "m" : "ft";
  }

  function systemLabel() {
    return mode === "LOCAL"
      ? "Local Tangent Plane (meters from project origin)"
      : "NAD83 New York State Plane, Long Island Zone (EPSG:2263), US Survey Feet";
  }

  return { setMode, setOrigin, getOrigin, forward, inverse, unitLabel, systemLabel };
})();

/* download-tiles.js
 * One-time script: downloads the Fort Greene Park tile set (street basemap,
 * labels, aerial imagery) from Esri's free public ArcGIS Online tile
 * services into tiles/, so the app can run with zero live map-tile
 * dependency. Not part of the app itself - run with
 * `node scripts/download-tiles.js` whenever the bundled area/zoom range
 * needs to change.
 *
 * NYC's own DOITT tile service (maps.nyc.gov/xyz/1.0.0/...) and CARTO's
 * free basemap CDN were tried first - both now serve a placeholder image
 * (HTTP 200, but the picture itself just says "service has moved" / "API
 * key required") instead of real tiles or an actual error, so a status-code
 * check alone doesn't catch it. Esri's tiles were verified by actually
 * looking at the downloaded images, not just the HTTP status.
 *
 * Esri's tile path is {z}/{y}/{x} - row before column - the opposite order
 * from the {z}/{x}/{y} convention every other provider this app has used
 * follows. Easy to get backwards; double-checked against a known street
 * (Willoughby Ave) before trusting it.
 */
const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = path.join(__dirname, "..", "tiles");

// Real Fort Greene Park bounding box (via Nominatim) plus ~190m padding so
// panning slightly outside the park isn't immediately blank.
const SOUTH = 40.6897682 - 0.0017;
const NORTH = 40.6932772 + 0.0017;
const WEST = -73.9776115 - 0.0022;
const EAST = -73.9733570 + 0.0022;
const MIN_ZOOM = 15;
const MAX_ZOOM = 19;

const LAYERS = [
  { name: "street", service: "World_Street_Map", ext: "jpg" },
  { name: "imagery", service: "World_Imagery", ext: "jpg" },
  { name: "labels", service: "Reference/World_Boundaries_and_Places", ext: "png" },
];

function lonToTile(lon, z) {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, z));
}
function latToTile(lat, z) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z));
}

function fetchTile(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`${res.statusCode} for ${url}`));
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      })
      .on("error", reject);
  });
}

async function main() {
  let ok = 0, failed = 0, skipped = 0;
  for (const layer of LAYERS) {
    for (let z = MIN_ZOOM; z <= MAX_ZOOM; z++) {
      const x0 = lonToTile(WEST, z), x1 = lonToTile(EAST, z);
      const y0 = latToTile(NORTH, z), y1 = latToTile(SOUTH, z);
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const dir = path.join(ROOT, layer.name, String(z), String(x));
          const file = path.join(dir, `${y}.${layer.ext}`);
          if (fs.existsSync(file)) {
            skipped++;
            continue;
          }
          // Esri: {z}/{y}/{x} - row before column.
          const url = `https://server.arcgisonline.com/ArcGIS/rest/services/${layer.service}/MapServer/tile/${z}/${y}/${x}`;
          try {
            const buf = await fetchTile(url);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(file, buf);
            ok++;
          } catch (e) {
            failed++;
            console.error("FAILED", url, e.message);
          }
        }
      }
      console.log(`${layer.name} z${z} done (ok=${ok} failed=${failed} skipped=${skipped})`);
    }
  }
  console.log(`\nTotal: ok=${ok} failed=${failed} skipped=${skipped}`);
}

main();

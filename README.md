# Smart Survey Notebook

A browser-based digital field notebook and engineering workflow for a high school Certified Surveying Technician (CST) course. Students click points on a live map, build the field notebook automatically, connect points into paths / traverses / boundaries / differential leveling runs, work out their own traverse and leveling adjustments by hand (the app is a worksheet, not a calculator), and export a professional survey deliverable as a PDF.

Everything runs entirely in the browser — no server, no build step, no API keys. Project data (points, connections, photos) is auto-saved to the browser's `localStorage`, and can be exported/imported as a `.json` backup file to move between computers.

## Running it

Just open `index.html` in a modern browser (Chrome or Edge recommended). Because the app loads map tiles over the internet, you'll need a network connection. No installation, no `npm install`, no local server required — double-click the file.

If you'd rather serve it (optional, e.g. to share on a school network), any static file server works, for example:

```
npx serve .
```

## Feature tour

- **Interactive map** (Leaflet + OpenStreetMap): click **Add Point** then click the map to drop a survey point. Fill in feature type, **Survey Type**, elevation, description, notes, and an optional photo in the popup editor.
- **Survey Type per point**: tag each point with which survey campaign it belongs to — General Point, Differential Leveling (Points/open or Loop/closed), or Traverse (Open or Closed) — right when you collect it.
- **Connect Points**: pick a line type (Survey Path / Traverse / Boundary / Differential Leveling), click points on the map in order, choose **Survey Type: Open or Closed**, then **Finish Line** to name and save the connection. Choosing Closed automatically re-adds the starting point at the end to close the loop.
- **Digital Field Notebook**: every point becomes an editable row (Point ID, Northing, Easting, Elevation, Feature Type, Survey Type, Description, Date, Photo, Notes). Edit any cell in place — the map and other views update immediately.
- **Traverse Table**: pick the **Angle Type** your course uses (interior, angle-to-the-right, deflection left/right, or direct azimuth) so the column headers match your convention. Enter field distance/angle, correction, adjusted angle, adjusted bearing, and adjusted azimuth for each leg by hand, then a second **Latitude, Departure & Coordinate Adjustment** table for computing latitude/departure, balancing them, and carrying adjusted coordinates forward station-by-station. A **closure check** section (angular, then linear/precision) is where you report your own ΣAngles, misclosure, ΣLat/ΣDep, and precision ratio (1:X) — the app never sums these for you. The app fills in only the **Actual** distance/bearing/azimuth/coordinate columns, computed straight from the map's real coordinates, so you can check your work against ground truth.
- **Leveling Table**: enter your own BS/FS/stadia readings (stadia distance = interval × stadia constant K, typically K=100), mark which points are turning points, then work out HI, Elevation, Distance, and (for closed runs) the Adjusted Elevation by hand. A separate **arithmetic check** (ΣBS, ΣFS, Elev(last) − Elev(first)) is a distinct, more fundamental self-check you do before ever comparing anything to the map. The app fills in only **Actual Elevation** (the point's known/given elevation), so you can check closure against it yourself.
- **Plan View**: a CAD-style plan sheet (not a map screenshot) plotted directly in grid coordinates, with a coordinate grid, north arrow, scale bar, legend, and title block.
- **Export Survey Report (PDF)**: a 4-page deliverable — Plan View, Data Table, Traverse Table, Leveling Table.
- **Email Report**: downloads the PDF and opens your default email client with a pre-filled subject/body, ready for you to attach the PDF and send (browsers can't attach files to an email automatically, so that last step is manual).

## Coordinate system

Points are captured as GPS latitude/longitude, then converted with [proj4js](https://github.com/proj4js/proj4js) into real **NY State Plane, Long Island Zone (EPSG:2263, US Survey Feet)** Northing/Easting — the actual coordinate system New York City surveys use. Switch the "Coordinate System" dropdown to **Local Tangent Plane** to instead use a simple meters-from-origin grid, useful for sites outside New York.

## Design note: the app doesn't do the surveying math

Field readings, angular corrections, adjusted angles/bearings, HI, elevation, and closure are all typed in by the student from their own hand calculations — that arithmetic is the skill the course is teaching, so the app never computes it for you. The only values the app calculates are the **Actual** distance/bearing/elevation columns, derived straight from each point's real map coordinates (and, for elevation, the known value already entered on that point) — a ground-truth reference to check your work against, not an answer key filled in for you.

## File structure

```
index.html          App shell, toolbar, modals
css/style.css        All styling
js/coords.js          State Plane / local coordinate conversion (proj4js)
js/storage.js         localStorage persistence + JSON backup/restore
js/state.js           Core data model (points, connections) + pub/sub
js/photo.js           Photo upload + downscaling to base64
js/mapview.js         Leaflet map, markers, connect mode, grid, legend
js/table.js           Editable field notebook table
js/traverse.js        Traverse worksheet (field entry + actual-from-map reference)
js/leveling.js        Differential leveling worksheet (field entry + actual-from-map reference)
js/planview.js        Canvas-drawn CAD-style plan view (screen + PDF)
js/pdfexport.js        4-page PDF assembly (jsPDF + jsPDF-AutoTable)
js/app.js              Wires everything together (UI/event handling)
```

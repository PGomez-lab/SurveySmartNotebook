/* mapview.js
 * Interactive Leaflet map: renders survey points as markers, draws connections
 * (paths/traverses/boundaries), and provides a toggleable State-Plane coordinate
 * grid, legend, north arrow and scale bar. Emits 'mapclick' / 'markerclick' events;
 * app.js decides what those mean based on the active tool mode (add / connect / idle).
 */

const MapView = (() => {
  let map;
  let markerLayer, lineLayer, gridLayer;
  let legendControl, legendVisible = false;
  let selectedIds = [];
  // While connecting points, a just-opened popup can visually cover the next
  // marker the student needs to click (popups anchor above the marker, and
  // Leaflet auto-pans the map to fit one) - both silently eat the next click.
  // Suppress popups entirely during connect mode so clicking stays reliable.
  let suppressPopups = false;
  const listeners = {};

  function on(evt, fn) {
    (listeners[evt] = listeners[evt] || []).push(fn);
  }
  function emit(evt, payload) {
    (listeners[evt] || []).forEach((fn) => fn(payload));
  }

  function init(project) {
    map = L.map("map", { zoomControl: true, maxZoom: 21 }).setView(
      [project.meta.originLat, project.meta.originLng],
      18
    );

    // NYC's own open GIS basemap (DoITT, maps.nyc.gov) - the same public
    // tile service NYC Planning's own ZoLa runs on. Free, no API key
    // (unlike Google Maps, which always needs a billing-enabled one), and
    // actually meant for a whole classroom sharing one school IP, unlike
    // OSM's own tile server (blocks/403s that) or a third-party CDN (can
    // start asking for a key once usage grows). Cached tiles only go to
    // z19 natively; maxNativeZoom lets Leaflet keep zooming past that by
    // upscaling the z19 tile instead of requesting a z20/21 tile that
    // doesn't exist.
    const tileOpts = { subdomains: "1234", minZoom: 8, maxZoom: 21, maxNativeZoom: 19 };
    const nycAttribution = '&copy; <a href="https://www1.nyc.gov/site/doitt/initiatives/gis.page">City of New York</a>';
    const nycBasemap = L.tileLayer("https://maps{s}.nyc.gov/xyz/1.0.0/carto/basemap/{z}/{x}/{y}.jpg", Object.assign({ attribution: nycAttribution }, tileOpts));
    const nycAerial = L.tileLayer("https://maps{s}.nyc.gov/xyz/1.0.0/photo/2018/{z}/{x}/{y}.png8", Object.assign({ attribution: nycAttribution + " (2018 aerial)" }, tileOpts));
    const nycLabels = L.tileLayer("https://maps{s}.nyc.gov/xyz/1.0.0/carto/label/{z}/{x}/{y}.png8", tileOpts);

    nycBasemap.addTo(map);
    nycLabels.addTo(map);
    // Same idea as ZoLa's own layer switcher: Basemap/Aerial Photo are
    // mutually exclusive (Leaflet's base-layer radio behavior), Labels is an
    // independent overlay since the aerial photo has no text of its own.
    L.control.layers(
      { "Basemap": nycBasemap, "Aerial Photo (2018)": nycAerial },
      { "Labels": nycLabels }
    ).addTo(map);

    L.control.scale({ metric: false, imperial: true, position: "bottomleft" }).addTo(map);

    markerLayer = L.layerGroup().addTo(map);
    lineLayer = L.layerGroup().addTo(map);
    gridLayer = L.layerGroup(); // not added by default; toggled on

    addNorthArrow();
    addLegendControl();

    map.on("click", (e) => emit("mapclick", e.latlng));
    map.on("moveend zoomend", () => {
      if (map.hasLayer(gridLayer)) drawGrid();
    });

    return map;
  }

  function addNorthArrow() {
    const ctrl = L.control({ position: "topright" });
    ctrl.onAdd = () => {
      const div = L.DomUtil.create("div", "north-arrow");
      div.innerHTML = "&#8593;<br/>N";
      return div;
    };
    ctrl.addTo(map);
  }

  function featureLegendRows() {
    return Object.entries(State.FEATURE_STYLES)
      .map(
        ([name, s]) =>
          `<div class="lg-item"><span class="lg-swatch" style="background:${s.color}"></span>${name}</div>`
      )
      .join("");
  }

  function connectionLegendRows() {
    return Object.entries(State.CONNECTION_STYLES)
      .map(([type, s]) => {
        const row = `<div class="lg-item"><span class="lg-line" style="border-color:${s.color}"></span>${s.label}</div>`;
        // Leveling and Traverse both distinguish their chain (Benchmark/
        // Turning Point, or a station) from a side shot - see
        // computeAnchorSegments / computeSideShotSegments.
        if (type !== "level" && type !== "traverse") return row;
        return row + `<div class="lg-item"><span class="lg-line" style="border-color:${s.color};opacity:0.45;"></span>${s.label} (side shot)</div>`;
      })
      .join("");
  }

  // Built but not shown by default - hidden until the student clicks
  // Toggle Legend, so it doesn't cover the map on first load.
  function addLegendControl() {
    legendControl = L.control({ position: "bottomright" });
    legendControl.onAdd = () => {
      const div = L.DomUtil.create("div", "map-legend");
      const tripodRow = `<div class="lg-item"><span class="lg-swatch" style="background:#2c333b;border-radius:3px;"></span>Instrument Setup</div>`;
      div.innerHTML = `<h4>Legend</h4>${featureLegendRows()}${tripodRow}<hr style="margin:5px 0;border-color:#eee"/>${connectionLegendRows()}`;
      return div;
    };
  }

  function isLegendVisible() {
    return legendVisible;
  }

  function toggleLegend() {
    legendVisible = !legendVisible;
    if (legendVisible) legendControl.addTo(map);
    else map.removeControl(legendControl);
  }

  function toggleGrid() {
    if (map.hasLayer(gridLayer)) {
      map.removeLayer(gridLayer);
    } else {
      gridLayer.addTo(map);
      drawGrid();
    }
    return map.hasLayer(gridLayer);
  }

  function niceInterval(span) {
    const candidates = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000];
    for (const c of candidates) {
      if (span / c <= 10) return c;
    }
    return candidates[candidates.length - 1];
  }

  function drawGrid() {
    gridLayer.clearLayers();
    const b = map.getBounds();
    const corners = [
      Coords.forward(b.getSouth(), b.getWest()),
      Coords.forward(b.getSouth(), b.getEast()),
      Coords.forward(b.getNorth(), b.getWest()),
      Coords.forward(b.getNorth(), b.getEast()),
    ];
    const nVals = corners.map((c) => c.northing);
    const eVals = corners.map((c) => c.easting);
    const nMin = Math.min(...nVals), nMax = Math.max(...nVals);
    const eMin = Math.min(...eVals), eMax = Math.max(...eVals);
    const interval = niceInterval(Math.max(nMax - nMin, eMax - eMin));
    const unit = Coords.unitLabel();

    const startN = Math.ceil(nMin / interval) * interval;
    for (let n = startN; n <= nMax; n += interval) {
      const p1 = Coords.inverse(n, eMin);
      const p2 = Coords.inverse(n, eMax);
      L.polyline([[p1.lat, p1.lng], [p2.lat, p2.lng]], {
        color: "#7a8a95",
        weight: 1,
        opacity: 0.55,
        dashArray: "3,4",
        interactive: false,
      }).addTo(gridLayer);
      L.marker([p1.lat, p1.lng], {
        icon: L.divIcon({ className: "", html: `<div class="point-label" style="font-size:10px;">N ${Math.round(n).toLocaleString()}${unit}</div>`, iconSize: [1, 1] }),
        interactive: false,
      }).addTo(gridLayer);
    }

    const startE = Math.ceil(eMin / interval) * interval;
    for (let e = startE; e <= eMax; e += interval) {
      const p1 = Coords.inverse(nMin, e);
      const p2 = Coords.inverse(nMax, e);
      L.polyline([[p1.lat, p1.lng], [p2.lat, p2.lng]], {
        color: "#7a8a95",
        weight: 1,
        opacity: 0.55,
        dashArray: "3,4",
        interactive: false,
      }).addTo(gridLayer);
      L.marker([p1.lat, p1.lng], {
        icon: L.divIcon({ className: "", html: `<div class="point-label" style="font-size:10px;">E ${Math.round(e).toLocaleString()}${unit}</div>`, iconSize: [1, 1] }),
        interactive: false,
      }).addTo(gridLayer);
    }
  }

  function markerIcon(point, isSelected) {
    const style = State.FEATURE_STYLES[point.featureType] || State.FEATURE_STYLES.Other;
    const ring = isSelected ? "0 0 0 3px #ffcf40" : "none";
    return L.divIcon({
      className: "",
      html: `<div class="point-icon" style="width:26px;height:26px;background:${style.color};box-shadow:${ring};">${style.code}</div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13],
      popupAnchor: [0, -13],
    });
  }

  function popupHtml(point) {
    const elev = point.elevation !== null && point.elevation !== undefined && point.elevation !== "" ? `${point.elevation} ft` : "<em>missing</em>";
    return `
      <div class="pop-title">${point.id} &mdash; ${point.featureType}</div>
      <div class="pop-row"><strong>Elevation:</strong> ${elev}</div>
      <div class="pop-row"><strong>Description:</strong> ${point.description || "<em>none</em>"}</div>
      <div class="pop-row"><strong>N/E:</strong> ${point.northing.toFixed(2)}, ${point.easting.toFixed(2)}</div>
      <button data-edit-id="${point.id}">Edit Rod</button>
    `;
  }

  function tripodIcon(isSelected) {
    const ring = isSelected ? "0 0 0 3px #ffcf40" : "none";
    return L.divIcon({
      className: "",
      html: `<div class="tripod-icon" style="box-shadow:${ring};">&#9698;</div>`,
      iconSize: [24, 24],
      iconAnchor: [12, 20],
      popupAnchor: [0, -18],
    });
  }

  function tripodPopupHtml(tripod) {
    return `
      <div class="pop-title">${tripod.id} &mdash; Instrument Setup</div>
      <div class="pop-row"><strong>N/E:</strong> ${tripod.northing.toFixed(2)}, ${tripod.easting.toFixed(2)}</div>
      <button data-delete-tripod-id="${tripod.id}">Delete Instrument</button>
    `;
  }

  // Clockwise degrees from true north (the grid's Northing axis) to point b
  // as seen from point a - the same convention as Traverse's own azimuth
  // math, kept as a small self-contained copy here rather than reaching into
  // that module, since it's just two lines.
  function azimuthBetween(a, b) {
    const deg = (Math.atan2(b.easting - a.easting, b.northing - a.northing) * 180) / Math.PI;
    return ((deg % 360) + 360) % 360;
  }

  // A compass rose anchored at a traverse point, needle rotated to that
  // point's own outgoing line's true azimuth - the face itself never
  // rotates, so N stays pointing up (true north on the map) and the angle
  // between the needle and N visually matches the angle between the dashed
  // line and true north. Offset up-and-right of the point's own marker
  // (iconAnchor past the icon's own bounds) so it reads as a badge next to
  // the point instead of sitting directly on top of it.
  function compassIcon(azimuthDeg) {
    return L.divIcon({
      className: "",
      html: `<div class="compass-face"><span class="compass-n">N</span><div class="compass-axis-v"></div><div class="compass-axis-h"></div><div class="compass-needle" style="transform:rotate(${azimuthDeg}deg);"></div></div>`,
      iconSize: [26, 26],
      iconAnchor: [-7, 33],
    });
  }

  // A sighting line, whichever module computed it (Leveling's per-point FS/BS
  // or Traverse's per-side-shot reading): an invisible, wider line underneath
  // for a generous, reliable click target (a thin dashed line has gaps a
  // click can land on and miss), plus the actual visible line drawn lighter
  // for a spur (a plain leveling point, or any traverse side shot) than for
  // the chain the survey actually advances along.
  function drawSightingSegments(segments, style, tooltips) {
    segments.forEach((seg) => {
      const latlngs = [[seg.from.lat, seg.from.lng], [seg.to.lat, seg.to.lng]];
      // bubblingMouseEvents defaults to true for L.Path (unlike markers,
      // where it's false) - without this, clicking this line while in Add
      // Point/Add Tripod mode would ALSO bubble up to the map's own click
      // handler and place a new point/tripod right on top of whatever this
      // line's click just opened.
      L.polyline(latlngs, { opacity: 0, weight: 16, bubblingMouseEvents: false })
        .bindTooltip(seg.isSpur ? tooltips.spur : tooltips.chain, { sticky: true })
        .on("click", () => emit("sightingclick", seg.pointId))
        .addTo(lineLayer);
      L.polyline(latlngs, {
        color: style.color,
        weight: seg.isSpur ? 2 : 3,
        opacity: seg.isSpur ? 0.45 : 1,
        dashArray: style.dashArray,
        interactive: false,
      }).addTo(lineLayer);
    });
  }

  function render(project) {
    markerLayer.clearLayers();
    lineLayer.clearLayers();

    project.connections.forEach((conn) => {
      const style = State.CONNECTION_STYLES[conn.type] || State.CONNECTION_STYLES.path;

      if (conn.type === "level") {
        drawSightingSegments(Leveling.computeAnchorSegments(conn), style, {
          chain: "Click to record this sighting's reading",
          spur: "Side shot - click to record its Foresight reading",
        });
        return;
      }

      if (conn.type === "traverse") {
        // A traverse station sights through its own assigned instrument -
        // see computeStationSightingSegments.
        const stationSegments = Traverse.computeStationSightingSegments(conn);
        drawSightingSegments(stationSegments, style, {
          chain: "Click to record this rod's line to the next one",
          spur: "",
        });
        // A small compass at each station, needle pointing along that
        // station's own outgoing line - lets a student see the angle
        // between the dashed line and true north at a glance.
        stationSegments.forEach((seg) => {
          L.marker([seg.from.lat, seg.from.lng], { icon: compassIcon(azimuthBetween(seg.from, seg.to)), interactive: false })
            .addTo(markerLayer);
        });
        // A side shot is a detail reading off a station, never a station
        // itself - the chain above never runs through it, so it gets its
        // own, lighter sighting line.
        drawSightingSegments(Traverse.computeSideShotSegments(), style, {
          chain: "Click to record this reading",
          spur: "Side shot - click to record its angle/distance reading",
        });
        return;
      }

      const latlngs = conn.pointIds
        .map((id) => State.getPoint(id))
        .filter(Boolean)
        .map((p) => [p.lat, p.lng]);
      // Boundaries always close into a loop.
      const shouldClose = conn.type === "boundary";
      if (shouldClose && latlngs.length > 2) latlngs.push(latlngs[0]);
      if (latlngs.length >= 2) {
        L.polyline(latlngs, {
          color: style.color,
          weight: conn.type === "boundary" ? 3 : 2.5,
          dashArray: style.dashArray,
        })
          .bindTooltip(conn.name, { sticky: true })
          .addTo(lineLayer);
      }
    });

    project.points.forEach((point) => {
      const marker = L.marker([point.lat, point.lng], {
        icon: markerIcon(point, selectedIds.includes(point.id)),
      });
      marker.bindTooltip(point.id, { permanent: false, direction: "top" });
      if (!suppressPopups) {
        // Only bind the popup outside connect mode. Binding it unconditionally
        // and closing it after the fact doesn't work: opening a popup triggers
        // Leaflet's autoPan, which keeps animating the map for ~250ms even
        // after the popup is closed, silently shifting every marker's screen
        // position out from under the next click in a multi-point sequence.
        marker.bindPopup(popupHtml(point));
        marker.on("popupopen", (e) => {
          const btn = e.popup.getElement().querySelector("[data-edit-id]");
          if (btn) btn.addEventListener("click", () => emit("editrequest", point.id));
        });
      }
      marker.on("click", () => emit("markerclick", point.id));
      marker.addTo(markerLayer);
    });

    (project.tripods || []).forEach((tripod) => {
      const marker = L.marker([tripod.lat, tripod.lng], {
        icon: tripodIcon(selectedIds.includes(tripod.id)),
      });
      marker.bindTooltip(tripod.id, { permanent: false, direction: "top" });
      if (!suppressPopups) {
        marker.bindPopup(tripodPopupHtml(tripod));
        marker.on("popupopen", (e) => {
          const btn = e.popup.getElement().querySelector("[data-delete-tripod-id]");
          if (btn) btn.addEventListener("click", () => emit("deletetripodrequest", tripod.id));
        });
      }
      marker.on("click", () => emit("tripodclick", tripod.id));
      marker.addTo(markerLayer);
    });
  }

  function setSelectedIds(ids) {
    selectedIds = ids;
  }

  function setSuppressPopups(v) {
    suppressPopups = v;
    if (v) map.closePopup();
  }

  function flyToPoint(id) {
    const p = State.getPoint(id);
    if (p) map.flyTo([p.lat, p.lng], Math.max(map.getZoom(), 19));
  }

  function fitToPoints(project) {
    // Tripods included too - a setup placed off to the side of the points it
    // sights (a common, realistic layout) would otherwise fall outside the
    // fitted view entirely.
    const coords = project.points
      .map((p) => [p.lat, p.lng])
      .concat((project.tripods || []).map((t) => [t.lat, t.lng]));
    if (!coords.length) return;
    const bounds = L.latLngBounds(coords);
    map.fitBounds(bounds.pad(0.2));
  }

  function getMap() {
    return map;
  }

  return { init, render, on, toggleGrid, toggleLegend, isLegendVisible, setSelectedIds, setSuppressPopups, flyToPoint, fitToPoints, getMap };
})();

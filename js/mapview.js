/* mapview.js
 * Interactive Leaflet map: renders survey points as markers, draws connections
 * (paths/traverses/boundaries), and provides a toggleable State-Plane coordinate
 * grid, legend, north arrow and scale bar. Emits 'mapclick' / 'markerclick' events;
 * app.js decides what those mean based on the active tool mode (add / connect / idle).
 */

const MapView = (() => {
  let map;
  let markerLayer, lineLayer, gridLayer;
  let legendControl, legendVisible = true;
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
    map = L.map("map", { zoomControl: true }).setView(
      [project.meta.originLat, project.meta.originLng],
      18
    );

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 21,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);

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
      .map(
        ([, s]) => `<div class="lg-item"><span class="lg-line" style="border-color:${s.color}"></span>${s.label}</div>`
      )
      .join("");
  }

  function addLegendControl() {
    legendControl = L.control({ position: "bottomright" });
    legendControl.onAdd = () => {
      const div = L.DomUtil.create("div", "map-legend");
      div.innerHTML = `<h4>Legend</h4>${featureLegendRows()}<hr style="margin:5px 0;border-color:#eee"/>${connectionLegendRows()}`;
      return div;
    };
    legendControl.addTo(map);
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
      <button data-edit-id="${point.id}">Edit Point</button>
    `;
  }

  function render(project) {
    markerLayer.clearLayers();
    lineLayer.clearLayers();

    project.connections.forEach((conn) => {
      const style = State.CONNECTION_STYLES[conn.type] || State.CONNECTION_STYLES.path;
      const latlngs = conn.pointIds
        .map((id) => State.getPoint(id))
        .filter(Boolean)
        .map((p) => [p.lat, p.lng]);
      // Boundaries always close into a loop; auto-managed traverse/leveling
      // runs close too when their Survey Type is "closed" (they no longer
      // repeat the first station's ID in pointIds to represent that).
      const shouldClose = conn.type === "boundary" || ((conn.type === "traverse" || conn.type === "level") && conn.surveyType === "closed");
      if (shouldClose && latlngs.length > 2) latlngs.push(latlngs[0]);
      if (latlngs.length < 2) return;
      L.polyline(latlngs, {
        color: style.color,
        weight: 3,
        dashArray: style.dashArray,
      })
        .bindTooltip(conn.name, { sticky: true })
        .addTo(lineLayer);
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
    if (!project.points.length) return;
    const bounds = L.latLngBounds(project.points.map((p) => [p.lat, p.lng]));
    map.fitBounds(bounds.pad(0.2));
  }

  function getMap() {
    return map;
  }

  return { init, render, on, toggleGrid, toggleLegend, setSelectedIds, setSuppressPopups, flyToPoint, fitToPoints, getMap };
})();

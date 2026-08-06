/* planview.js
 * Draws the "Top View" on a <canvas>: real OpenStreetMap tile imagery (so
 * students see the actual park/street/site, not just an abstract grid) as
 * the background, with the coordinate grid, survey points, connections,
 * legend, north arrow, scale bar, and title block drawn on top. Points and
 * tiles are positioned through the SAME Web Mercator (lat/lng) transform the
 * tiles are natively in, so everything lines up pixel-for-pixel; the State
 * Plane coordinate grid is drawn by converting round Northing/Easting values
 * to lat/lng (Coords.inverse) and through that same transform.
 *
 * OSM's standard tile server sends Access-Control-Allow-Origin: *, so tiles
 * can be drawn onto the canvas (with crossOrigin="anonymous") without
 * tainting it - toDataURL() still works for the PDF export.
 *
 * render(canvas, project) is async (tile fetching) and never rejects - a
 * tile that fails to load (offline, blocked, timeout) is just skipped,
 * leaving that patch of the background blank rather than breaking the page.
 */

const PlanView = (() => {
  const TILE_SIZE = 256;
  const TILE_TIMEOUT_MS = 8000;
  const MAX_TILES = 80;

  function niceNumber(span, targetDivisions) {
    const candidates = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000];
    for (const c of candidates) {
      if (span / c <= targetDivisions) return c;
    }
    return candidates[candidates.length - 1];
  }

  // ---------- Web Mercator tile math ----------
  function lonToWorldX(lon, zoom) {
    return ((lon + 180) / 360) * TILE_SIZE * Math.pow(2, zoom);
  }
  function latToWorldY(lat, zoom) {
    const latRad = (lat * Math.PI) / 180;
    return ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * TILE_SIZE * Math.pow(2, zoom);
  }

  function pickZoom(latMin, latMax, lonMin, lonMax, targetW, targetH) {
    for (let z = 21; z >= 3; z--) {
      const w = lonToWorldX(lonMax, z) - lonToWorldX(lonMin, z);
      const h = latToWorldY(latMin, z) - latToWorldY(latMax, z);
      if (w <= targetW && h <= targetH) return z;
    }
    return 3;
  }

  // Every render() (on-screen Top View tab, and again for each PDF export)
  // re-derives the same fixed-extent view, so the same tiles get requested
  // over and over as the student switches tabs or edits unrelated fields -
  // cache successful loads for the life of the page so repeat renders reuse
  // the already-decoded image instead of re-fetching from OpenStreetMap.
  // Failures are NOT cached, so a transient network hiccup can still recover
  // on the next render rather than being stuck blank for the rest of the session.
  const tileCache = new Map();

  function loadTileImage(z, x, y) {
    const maxTile = Math.pow(2, z);
    if (x < 0 || y < 0 || x >= maxTile || y >= maxTile) return Promise.resolve(null);
    const key = `${z}/${x}/${y}`;
    if (tileCache.has(key)) return Promise.resolve(tileCache.get(key));
    return new Promise((resolve) => {
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        if (result) tileCache.set(key, result);
        resolve(result);
      };
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => finish(img);
      img.onerror = () => finish(null);
      img.src = `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
      setTimeout(() => finish(null), TILE_TIMEOUT_MS);
    });
  }

  function shape(ctx, type, x, y, r, color) {
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    switch (type) {
      case "circle": // Storm Drain
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        break;
      case "square": // Sidewalk
        ctx.rect(x - r, y - r, r * 2, r * 2);
        ctx.fill();
        break;
      case "triangleUp": // Tree
        ctx.moveTo(x, y - r * 1.2);
        ctx.lineTo(x + r, y + r * 0.8);
        ctx.lineTo(x - r, y + r * 0.8);
        ctx.closePath();
        ctx.fill();
        break;
      case "diamond": // Light Pole
        ctx.moveTo(x, y - r * 1.2);
        ctx.lineTo(x + r * 1.2, y);
        ctx.lineTo(x, y + r * 1.2);
        ctx.lineTo(x - r * 1.2, y);
        ctx.closePath();
        ctx.fill();
        break;
      case "squareOutline": // Building Corner
        ctx.lineWidth = 2.5;
        ctx.rect(x - r, y - r, r * 2, r * 2);
        ctx.stroke();
        break;
      case "triangleDown": // Utility Feature
        ctx.moveTo(x, y + r * 1.2);
        ctx.lineTo(x + r, y - r * 0.8);
        ctx.lineTo(x - r, y - r * 0.8);
        ctx.closePath();
        ctx.fill();
        break;
      case "hexagon": { // Benchmark
        const rr = r * 1.15;
        for (let k = 0; k < 6; k++) {
          const ang = (Math.PI / 3) * k - Math.PI / 2;
          const px = x + rr * Math.cos(ang), py = y + rr * Math.sin(ang);
          k === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = "#fff";
        ctx.stroke();
        break;
      }
      case "triangleOutline": // Turning Point
        ctx.lineWidth = 2;
        ctx.moveTo(x, y - r * 1.2);
        ctx.lineTo(x + r, y + r * 0.8);
        ctx.lineTo(x - r, y + r * 0.8);
        ctx.closePath();
        ctx.stroke();
        break;
      default: // Other
        ctx.lineWidth = 2;
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.stroke();
    }
  }

  const SHAPE_BY_FEATURE = {
    "Storm Drain": "circle",
    "Sidewalk": "square",
    "Tree": "triangleUp",
    "Light Pole": "diamond",
    "Building Corner": "squareOutline",
    "Utility Feature": "triangleDown",
    "Benchmark": "hexagon",
    "Turning Point": "triangleOutline",
    "Other": "ringOutline",
  };

  // White halo behind text so it stays legible over busy map imagery.
  function haloText(ctx, text, x, y) {
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
  }

  async function render(canvas, project, opts = {}) {
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#dfe7ea";
    ctx.fillRect(0, 0, W, H);

    // Header
    ctx.fillStyle = "#1c2530";
    ctx.font = "bold 20px Segoe UI, Arial";
    ctx.textAlign = "center";
    ctx.fillText("TOP VIEW", W / 2, 30);

    const titleBlockH = 78;
    const headerH = 44;
    const padLeft = 60, padRight = 210, padTop = headerH, padBottom = titleBlockH + 14;
    const drawWidth = W - padLeft - padRight;
    const drawHeight = H - padTop - padBottom;

    ctx.strokeStyle = "#c7cfd6";
    ctx.lineWidth = 1;
    ctx.strokeRect(padLeft, padTop, drawWidth, drawHeight);

    const points = project.points;
    const tripods = project.tripods || [];
    // Fall back to the project's origin (e.g. Fort Greene Park) so the map
    // still shows real geography even before any point has been added.
    // Tripods count toward the extent too - one placed off to the side of
    // the points it sights (a common, realistic layout) would otherwise be
    // cropped out of the map entirely.
    const hasPoints = points.length > 0 || tripods.length > 0;
    const latVals = hasPoints ? points.map((p) => p.lat).concat(tripods.map((t) => t.lat)) : [project.meta.originLat];
    const lonVals = hasPoints ? points.map((p) => p.lng).concat(tripods.map((t) => t.lng)) : [project.meta.originLng];
    let latMin = Math.min(...latVals), latMax = Math.max(...latVals);
    let lonMin = Math.min(...lonVals), lonMax = Math.max(...lonVals);
    // Pad in degrees; ~0.0015 deg is roughly 500ft, a sensible minimum extent
    // so a single point (or none yet) still shows a real, recognizable area.
    const latPad = Math.max((latMax - latMin) * 0.2, 0.0015);
    const lonPad = Math.max((lonMax - lonMin) * 0.2, 0.0015);
    latMin -= latPad; latMax += latPad; lonMin -= lonPad; lonMax += lonPad;

    const zoom = pickZoom(latMin, latMax, lonMin, lonMax, drawWidth, drawHeight);
    const worldX0 = lonToWorldX(lonMin, zoom), worldX1 = lonToWorldX(lonMax, zoom);
    const worldY0 = latToWorldY(latMax, zoom), worldY1 = latToWorldY(latMin, zoom);
    const contentW = worldX1 - worldX0, contentH = worldY1 - worldY0;
    const offsetX = padLeft + (drawWidth - contentW) / 2 - worldX0;
    const offsetY = padTop + (drawHeight - contentH) / 2 - worldY0;

    const canvasX = (lon) => offsetX + lonToWorldX(lon, zoom);
    const canvasY = (lat) => offsetY + latToWorldY(lat, zoom);

    // ---------- Fetch and draw the real map tiles ----------
    const tileMinX = Math.floor((worldX0) / TILE_SIZE) - 1;
    const tileMaxX = Math.floor((worldX1) / TILE_SIZE) + 1;
    const tileMinY = Math.floor((worldY0) / TILE_SIZE) - 1;
    const tileMaxY = Math.floor((worldY1) / TILE_SIZE) + 1;
    const tileJobs = [];
    for (let tx = tileMinX; tx <= tileMaxX; tx++) {
      for (let ty = tileMinY; ty <= tileMaxY; ty++) {
        tileJobs.push({ tx, ty });
      }
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(padLeft, padTop, drawWidth, drawHeight);
    ctx.clip();

    if (tileJobs.length <= MAX_TILES) {
      const images = await Promise.all(tileJobs.map((j) => loadTileImage(zoom, j.tx, j.ty)));
      images.forEach((img, i) => {
        if (!img) return;
        const { tx, ty } = tileJobs[i];
        ctx.drawImage(img, offsetX + tx * TILE_SIZE, offsetY + ty * TILE_SIZE, TILE_SIZE, TILE_SIZE);
      });
    }

    if (!hasPoints) {
      ctx.restore();
      ctx.fillStyle = "#1c2530";
      ctx.font = "bold 16px Segoe UI, Arial";
      ctx.textAlign = "center";
      haloText(ctx, "No survey points collected yet.", W / 2, padTop + drawHeight / 2);
      drawTitleBlock(ctx, project, W, H, titleBlockH);
      return;
    }

    // ---------- Coordinate grid (State Plane Northing/Easting, via lat/lng) ----------
    const nVals = points.map((p) => p.northing), eVals = points.map((p) => p.easting);
    const nMin = Math.min(...nVals), nMax = Math.max(...nVals);
    const eMin = Math.min(...eVals), eMax = Math.max(...eVals);
    const interval = niceNumber(Math.max(nMax - nMin, eMax - eMin, 1), 8);
    const unit = Coords.unitLabel();

    ctx.strokeStyle = "rgba(255, 90, 0, 0.7)";
    ctx.lineWidth = 1.25;
    ctx.font = "10px Segoe UI, Arial";
    ctx.fillStyle = "#1c2530";
    ctx.textAlign = "left";
    const gridNMin = nMin - (nMax - nMin) * 0.2, gridNMax = nMax + (nMax - nMin) * 0.2;
    const gridEMin = eMin - (eMax - eMin) * 0.2, gridEMax = eMax + (eMax - eMin) * 0.2;
    for (let n = Math.ceil(gridNMin / interval) * interval; n <= gridNMax; n += interval) {
      const p1 = Coords.inverse(n, gridEMin), p2 = Coords.inverse(n, gridEMax);
      ctx.beginPath();
      ctx.moveTo(canvasX(p1.lng), canvasY(p1.lat));
      ctx.lineTo(canvasX(p2.lng), canvasY(p2.lat));
      ctx.stroke();
      haloText(ctx, `N ${Math.round(n).toLocaleString()}`, canvasX(p1.lng) + 4, canvasY(p1.lat) - 3);
    }
    for (let e = Math.ceil(gridEMin / interval) * interval; e <= gridEMax; e += interval) {
      const p1 = Coords.inverse(gridNMin, e), p2 = Coords.inverse(gridNMax, e);
      ctx.beginPath();
      ctx.moveTo(canvasX(p1.lng), canvasY(p1.lat));
      ctx.lineTo(canvasX(p2.lng), canvasY(p2.lat));
      ctx.stroke();
      haloText(ctx, `E ${Math.round(e).toLocaleString()}`, canvasX(p2.lng) + 4, canvasY(p2.lat) - 3);
    }

    // A sighting line, whichever module computed it (Leveling's per-point
    // FS/BS or Traverse's per-side-shot reading) - drawn lighter for a spur
    // (a plain leveling point, or any traverse side shot) than for the chain
    // the survey actually advances along, matching the interactive map.
    function drawSightingSegments(segments, dashPattern) {
      segments.forEach((seg) => {
        ctx.lineWidth = seg.isSpur ? 1.5 : 2.5;
        ctx.globalAlpha = seg.isSpur ? 0.45 : 1;
        ctx.setLineDash(dashPattern);
        ctx.beginPath();
        ctx.moveTo(canvasX(seg.from.lng), canvasY(seg.from.lat));
        ctx.lineTo(canvasX(seg.to.lng), canvasY(seg.to.lat));
        ctx.stroke();
      });
      ctx.globalAlpha = 1;
    }

    // Clockwise degrees from true north to point b as seen from point a -
    // same convention as Traverse's own azimuth math, kept as a small
    // self-contained copy here rather than reaching into that module.
    function azimuthBetween(a, b) {
      const deg = (Math.atan2(b.easting - a.easting, b.northing - a.northing) * 180) / Math.PI;
      return ((deg % 360) + 360) % 360;
    }

    // A small compass rose next to a traverse point - the face never
    // rotates (N always points up, true north on the map), and the needle
    // is rotated to that point's own outgoing line's true azimuth, matching
    // the same badge mapview.js draws for the interactive map.
    function drawCompass(x, y, azimuthDeg) {
      const cx = x + 18, cy = y - 18, r = 10;
      ctx.save();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.fillStyle = "rgba(255,255,255,0.88)";
      ctx.strokeStyle = "#2c333b";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#c1272d";
      ctx.font = "bold 7px Segoe UI, Arial";
      ctx.textAlign = "center";
      ctx.fillText("N", cx, cy - r + 7);
      // Fixed N-S / E-W reference axes, always upright - so the needle's
      // angle away from true north/east reads visually against a cross.
      ctx.strokeStyle = "rgba(44,51,59,0.4)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, cy - r + 2);
      ctx.lineTo(cx, cy + r - 2);
      ctx.moveTo(cx - r + 2, cy);
      ctx.lineTo(cx + r - 2, cy);
      ctx.stroke();
      const rad = (azimuthDeg * Math.PI) / 180;
      const needleLen = r - 2;
      ctx.strokeStyle = "#1f5f8b";
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.sin(rad) * needleLen, cy - Math.cos(rad) * needleLen);
      ctx.stroke();
      ctx.restore();
    }

    // ---------- Connections ----------
    project.connections.forEach((conn) => {
      const style = State.CONNECTION_STYLES[conn.type] || State.CONNECTION_STYLES.path;
      const dashPattern = style.dashArray ? style.dashArray.split(",").map(Number) : [];
      ctx.strokeStyle = style.color;

      if (conn.type === "level") {
        // A leveling run doesn't walk point-to-point in sequence - see
        // Leveling.computeAnchorSegments for why (tripod stays put for a
        // plain Foresight, only relocates at a turning point).
        drawSightingSegments(Leveling.computeAnchorSegments(conn), dashPattern);
        ctx.setLineDash([]);
        return;
      }

      if (conn.type === "traverse") {
        // A traverse station sights straight point-to-point, no tripod -
        // see computeStationSightingSegments.
        const stationSegments = Traverse.computeStationSightingSegments(conn);
        drawSightingSegments(stationSegments, dashPattern);
        // A small compass at each station, needle pointing along that
        // station's own outgoing line.
        stationSegments.forEach((seg) => {
          drawCompass(canvasX(seg.from.lng), canvasY(seg.from.lat), azimuthBetween(seg.from, seg.to));
        });
        // A side shot is a detail reading off a station, never a station
        // itself - the chain above never runs through it, so it gets its
        // own, lighter sighting line (always a spur).
        drawSightingSegments(Traverse.computeSideShotSegments(), dashPattern);
        ctx.setLineDash([]);
        return;
      }

      const pts = conn.pointIds.map((id) => State.getPoint(id)).filter(Boolean);
      if (pts.length >= 2) {
        const shouldClose = conn.type === "boundary";
        ctx.lineWidth = conn.type === "boundary" ? 3 : 2.5;
        ctx.setLineDash(dashPattern);
        ctx.beginPath();
        pts.forEach((p, i) => (i === 0 ? ctx.moveTo(canvasX(p.lng), canvasY(p.lat)) : ctx.lineTo(canvasX(p.lng), canvasY(p.lat))));
        if (shouldClose && pts.length > 2) ctx.closePath();
        ctx.stroke();
        ctx.setLineDash([]);
      }
    });

    // ---------- Points ----------
    points.forEach((p) => {
      const style = State.FEATURE_STYLES[p.featureType] || State.FEATURE_STYLES.Other;
      const shapeType = SHAPE_BY_FEATURE[p.featureType] || "ringOutline";
      const x = canvasX(p.lng), y = canvasY(p.lat);
      shape(ctx, shapeType, x, y, 6, style.color);
      ctx.fillStyle = "#1c2530";
      ctx.font = "bold 11px Segoe UI, Arial";
      ctx.textAlign = "left";
      haloText(ctx, p.id, x + 9, y - 8);
    });

    // ---------- Tripods ----------
    (project.tripods || []).forEach((t) => {
      const x = canvasX(t.lng), y = canvasY(t.lat);
      shape(ctx, "square", x, y, 6, "#2c333b");
      ctx.fillStyle = "#1c2530";
      ctx.font = "bold 11px Segoe UI, Arial";
      ctx.textAlign = "left";
      haloText(ctx, t.id, x + 9, y - 8);
    });

    ctx.restore(); // end clip

    // North arrow (top-right of drawing area) - Web Mercator tiles are always
    // north-up, so a straight vertical arrow is correct.
    const naX = padLeft + drawWidth - 32, naY = padTop + 42;
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.beginPath();
    ctx.arc(naX, naY + 12, 30, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#1c2530"; ctx.fillStyle = "#1c2530"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(naX, naY + 26); ctx.lineTo(naX, naY - 10); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(naX, naY - 20); ctx.lineTo(naX - 8, naY - 6); ctx.lineTo(naX + 8, naY - 6); ctx.closePath(); ctx.fill();
    ctx.font = "bold 13px Segoe UI, Arial"; ctx.textAlign = "center";
    ctx.fillText("N", naX, naY + 42);

    // Scale bar (bottom-left of drawing area) - derive ft-per-pixel from the
    // Web Mercator zoom/latitude rather than the old State Plane scale var.
    const metersPerPixel = (156543.03392804097 * Math.cos((latMin * Math.PI) / 180)) / Math.pow(2, zoom);
    const feetPerPixel = metersPerPixel * 3.28084;
    const barUnitsFt = niceNumber((drawWidth / 4) * feetPerPixel, 4);
    const barPx = barUnitsFt / feetPerPixel;
    const sbX = padLeft + 14, sbY = padTop + drawHeight - 16;
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillRect(sbX - 6, sbY - 22, barPx + 12, 30);
    ctx.strokeStyle = "#1c2530"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(sbX, sbY); ctx.lineTo(sbX + barPx, sbY); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sbX, sbY - 5); ctx.lineTo(sbX, sbY + 5); ctx.moveTo(sbX + barPx, sbY - 5); ctx.lineTo(sbX + barPx, sbY + 5); ctx.stroke();
    ctx.fillStyle = "#1c2530";
    ctx.font = "11px Segoe UI, Arial"; ctx.textAlign = "center";
    ctx.fillText(`${barUnitsFt} ${unit === "ft" ? "ft" : "ft (approx.)"}`, sbX + barPx / 2, sbY - 9);

    if (!opts.hideLegend) drawLegend(ctx, W, padTop);
    drawTitleBlock(ctx, project, W, H, titleBlockH);
  }

  function drawLegend(ctx, W, padTop) {
    const x = W - 195, y = padTop + 6;
    const featureEntries = Object.entries(State.FEATURE_STYLES);
    const connEntries = Object.entries(State.CONNECTION_STYLES);
    const rowH = 15;
    // +3 extra rows: Tripod Setup, plus a side-shot line under both Leveling
    // and Traverse (see the connEntries loop below).
    const h = 24 + featureEntries.length * rowH + connEntries.length * rowH + rowH * 3 + 14;
    ctx.fillStyle = "rgba(255,255,255,0.94)";
    ctx.strokeStyle = "#c7cfd6";
    ctx.lineWidth = 1;
    ctx.fillRect(x, y, 185, h);
    ctx.strokeRect(x, y, 185, h);

    ctx.fillStyle = "#1c2530";
    ctx.font = "bold 12px Segoe UI, Arial";
    ctx.textAlign = "left";
    ctx.fillText("Legend", x + 10, y + 18);

    let cy = y + 34;
    ctx.font = "11px Segoe UI, Arial";
    featureEntries.forEach(([name, style]) => {
      shape(ctx, SHAPE_BY_FEATURE[name], x + 16, cy - 4, 5, style.color);
      ctx.fillStyle = "#1c2530";
      ctx.fillText(name, x + 30, cy);
      cy += rowH;
    });
    cy += 4;
    connEntries.forEach(([type, style]) => {
      ctx.strokeStyle = style.color;
      ctx.lineWidth = 2.5;
      ctx.setLineDash(style.dashArray ? style.dashArray.split(",").map(Number) : []);
      ctx.beginPath(); ctx.moveTo(x + 10, cy - 4); ctx.lineTo(x + 26, cy - 4); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#1c2530";
      if (type === "level" || type === "traverse") {
        ctx.fillText(style.label, x + 30, cy);
        cy += rowH;
        // Leveling and Traverse both distinguish their chain (Benchmark/
        // Turning Point, or a station) from a side shot - see
        // computeAnchorSegments / computeSideShotSegments.
        ctx.strokeStyle = style.color;
        ctx.globalAlpha = 0.45;
        ctx.setLineDash(style.dashArray ? style.dashArray.split(",").map(Number) : []);
        ctx.beginPath(); ctx.moveTo(x + 10, cy - 4); ctx.lineTo(x + 26, cy - 4); ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.setLineDash([]);
        ctx.fillStyle = "#1c2530";
        ctx.fillText(`${style.label} (side shot)`, x + 30, cy);
        cy += rowH;
        return;
      }
      ctx.fillText(style.label, x + 30, cy);
      cy += rowH;
    });
    shape(ctx, "square", x + 16, cy - 4, 5, "#2c333b");
    ctx.fillStyle = "#1c2530";
    ctx.fillText("Tripod Setup", x + 30, cy);
  }

  function drawTitleBlock(ctx, project, W, H, titleBlockH) {
    const top = H - titleBlockH;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, top, W, titleBlockH);
    ctx.strokeStyle = "#1c2530";
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(20, top); ctx.lineTo(W - 20, top); ctx.stroke();

    ctx.textAlign = "left";
    ctx.fillStyle = "#1c2530";
    ctx.font = "bold 15px Segoe UI, Arial";
    ctx.fillText(`Project: ${project.meta.title || "Untitled Survey"}`, 24, top + 24);
    ctx.font = "12px Segoe UI, Arial";
    ctx.fillStyle = "#4b5a68";
    ctx.fillText(`Coordinate System: ${Coords.systemLabel()}`, 24, top + 44);
    ctx.fillText(`Points: ${project.points.length}    Connections: ${project.connections.length}`, 24, top + 62);

    ctx.textAlign = "right";
    ctx.fillStyle = "#1c2530";
    ctx.font = "bold 13px Segoe UI, Arial";
    ctx.fillText(`Team: ${project.meta.teamName || "____________________"}`, W - 24, top + 24);
    ctx.font = "12px Segoe UI, Arial";
    ctx.fillStyle = "#4b5a68";
    ctx.fillText(`Date: ${project.meta.date || "____________"}`, W - 24, top + 44);
  }

  return { render };
})();

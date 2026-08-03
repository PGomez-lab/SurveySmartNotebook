/* traverse.js
 * Traverse worksheet: automatically built from every point whose Survey Type
 * is "Traverse - Open/Closed", in the order they were added - no separate
 * Connect Points step needed. This module does NOT do the surveying math for
 * the student. It only computes the ACTUAL distance/bearing/azimuth/latitude/
 * departure/coordinates between stations straight from the map's real
 * Northing/Easting (the "ground truth" the spec calls "provided by the map").
 * Field readings, angular correction, adjusted angles/bearings/azimuths,
 * latitude/departure, their balancing, and adjusted coordinates are all typed
 * in by the student by hand, from their own calculations - the app is a
 * structured worksheet/field book, not a calculator.
 *
 * Field Angle/Field Bearing/Field Azimuth - a theodolite/total station
 * displays horizontal angle, vertical angle, and slope distance, and once
 * oriented to a known backsight can display bearing/azimuth directly - can
 * be jotted down right on the point itself the moment it's added.
 * computeLegs() seeds each station's row from the point's own quick-entry
 * values, then lets anything typed directly into the table below override
 * it, same as a later, separate observation would in a paper book.
 *
 * BS/FS/HI/Field Distance (elevation carried through the traverse the same
 * way a level run does) have no point-level quick-entry - unlike a leveling
 * run's benchmark/turning points, a traverse station is one instrument setup
 * sighting both directions, so there's nothing station-specific to jot down
 * before the whole sequence exists. Along with Correction/Adjusted Angle/
 * Bearing/Azimuth (which depend on the whole traverse's angular closure,
 * not knowable until every station has been surveyed), they're only ever
 * entered in the Traverse Table below, after the fact.
 *
 * Two tables, matching a real traverse computation:
 *   1. Station Data - BS/FS/HI/Elevation (carrying elevation through the
 *      traverse the same way a level run does) plus Distance/Angle/Bearing/
 *      Azimuth for each station's outgoing leg.
 *   2. Latitude, Departure & Coordinate Adjustment - Latitude -> correction
 *      -> adjusted (calculated) latitude, with the Actual latitude (from the
 *      map) alongside for comparison; same for Departure. This is the step
 *      that actually produces a precision-of-closure ratio, the real
 *      deliverable of a traverse computation.
 */

const Traverse = (() => {
  const ANGLE_TYPES = {
    interior: "Interior Angle",
    angleRight: "Angle to the Right",
    deflectionLeft: "Deflection Angle (Left)",
    deflectionRight: "Deflection Angle (Right)",
    azimuth: "Azimuth (measured directly)",
  };
  const ANGLE_TYPE_SHORT = {
    interior: "Int. &ang;",
    angleRight: "&ang; Right",
    deflectionLeft: "Defl. &ang; (L)",
    deflectionRight: "Defl. &ang; (R)",
    azimuth: "Azimuth",
  };

  function toDms(decimalDegrees) {
    const sign = decimalDegrees < 0 ? "-" : "";
    // Round to the nearest whole arcsecond first, then split with integer
    // arithmetic only - rounding minutes/seconds separately (as floats) can
    // leave a stray "60" in the seconds or minutes place instead of carrying.
    let totalSeconds = Math.round(Math.abs(decimalDegrees) * 3600);
    const deg = Math.floor(totalSeconds / 3600);
    totalSeconds -= deg * 3600;
    const min = Math.floor(totalSeconds / 60);
    const sec = totalSeconds - min * 60;
    return `${sign}${deg}°${String(min).padStart(2, "0")}'${String(sec).padStart(2, "0")}"`;
  }

  function normalize360(deg) {
    return ((deg % 360) + 360) % 360;
  }

  function azimuthToBearingString(azimuth) {
    const az = normalize360(azimuth);
    let ns, angle, ew;
    if (az <= 90) { ns = "N"; angle = az; ew = "E"; }
    else if (az <= 180) { ns = "S"; angle = 180 - az; ew = "E"; }
    else if (az <= 270) { ns = "S"; angle = az - 180; ew = "W"; }
    else { ns = "N"; angle = 360 - az; ew = "W"; }
    return `${ns} ${toDms(angle)} ${ew}`;
  }

  function azimuthBetween(a, b) {
    return normalize360((Math.atan2(b.easting - a.easting, b.northing - a.northing) * 180) / Math.PI);
  }

  function legDistance(a, b) {
    const dN = b.northing - a.northing;
    const dE = b.easting - a.easting;
    return Math.sqrt(dN * dN + dE * dE);
  }

  function neighborsFor(stations, i, closed) {
    const n = stations.length;
    const prevIdx = i - 1, nextIdx = i + 1;
    const prev = closed ? stations[(prevIdx + n) % n] : prevIdx >= 0 ? stations[prevIdx] : null;
    const next = closed ? stations[nextIdx % n] : nextIdx < n ? stations[nextIdx] : null;
    return { prev, next };
  }

  /** One row per STATION (not per leg) - the last station of an open traverse
   * still needs a row for its BS/FS/HI/Elevation even though it has no
   * outgoing leg to report distance/angle/bearing for. */
  function computeLegs(conn) {
    const closed = conn.surveyType === "closed";
    const stations = conn.pointIds.slice();
    const pts = stations.map((id) => State.getPoint(id));
    const n = pts.length;
    const legCount = closed ? n : n - 1;
    const fieldData = conn.fieldData || {};
    const unit = Coords.unitLabel();

    const rows = pts.map((from, i) => {
      if (!from) return null;
      const hasOutgoing = i < legCount;
      const to = hasOutgoing ? pts[closed ? (i + 1) % n : i + 1] : null;
      const { prev, next } = neighborsFor(stations, i, closed);
      // Seed Field Angle/Bearing/Azimuth from the point's own quick-entry
      // readings (recorded when the point was added/edited on the map),
      // then let anything already entered here in the table override it.
      // BS/FS/HI/Field Distance and Corrected/Adjusted values are NOT
      // seeded from the point - the former have no point-level quick-entry
      // (Traverse's HI/BS/FS/Distance are entered here, once the whole
      // station sequence is known), and the latter depend on the whole
      // traverse's angular closure - so both only ever come from this table.
      const fd = Object.assign(
        { fieldAngle: from.fieldAngle, fieldBearing: from.fieldBearing, fieldAzimuth: from.fieldAzimuth },
        fieldData[from.id] || {}
      );

      let actualDistance = null, actualAzimuth = null, actualBearing = "--", actualLatitude = null, actualDeparture = null;
      if (hasOutgoing && to) {
        actualAzimuth = azimuthBetween(from, to);
        actualDistance = legDistance(from, to);
        actualBearing = azimuthToBearingString(actualAzimuth);
        actualLatitude = to.northing - from.northing;
        actualDeparture = to.easting - from.easting;
      }

      return {
        pointId: from.id,
        fromId: from.id,
        toId: to ? to.id : null,
        hasOutgoing,
        hasAngle: !!(prev && next),
        actualDistance,
        actualAzimuth,
        actualBearing,
        actualLatitude,
        actualDeparture,
        actualElev: from.elevation === null || from.elevation === undefined ? null : from.elevation,
        unit,
        fd,
      };
    });

    const stationRows = pts.map((pt) => pt && {
      id: pt.id,
      actualNorthing: pt.northing,
      actualEasting: pt.easting,
      fd: fieldData[pt.id] || {},
    });

    return { name: conn.name, id: conn.id, closed, n, legCount, rows, stationRows, unit };
  }

  // ---------- Rendering ----------
  function fmt(n, digits = 2) {
    return n === null || n === undefined || Number.isNaN(n) ? "--" : n.toFixed(digits);
  }

  function mirrorDistanceText(fieldDistance, unit) {
    return fieldDistance !== undefined && fieldDistance !== null && fieldDistance !== ""
      ? fmt(parseFloat(fieldDistance)) + " " + unit
      : "--";
  }

  // DMS-formatted values (bearings, azimuths, angles) routinely contain a
  // literal " (arcseconds) - unescaped, that closes the value="..." attribute
  // early and silently truncates whatever the student typed on the next
  // render, so every value interpolated into an attribute must go through this.
  function escapeAttr(v) {
    return String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function fieldInput(connId, pointId, field, value, placeholder, type = "number", wide = false) {
    const attrs = type === "number" ? 'step="0.01"' : "";
    const v = value === null || value === undefined ? "" : value;
    const cls = wide ? ' class="wide-input"' : "";
    // placeholder is always a static, developer-authored string (some already
    // contain literal HTML entities like &plusmn;), never user input - only
    // the value needs escaping.
    return `<input type="${type}" ${attrs}${cls} data-conn="${connId}" data-point="${pointId}" data-field="${field}" value="${escapeAttr(v)}" placeholder="${placeholder}" />`;
  }

  function checkInput(connId, field, value, placeholder = "") {
    const v = value === null || value === undefined ? "" : value;
    return `<input type="text" class="check-input" data-conn-check="${connId}" data-field="${field}" value="${escapeAttr(v)}" placeholder="${placeholder}" />`;
  }

  function renderStationTable(conn, data) {
    const angleType = conn.angleType || "interior";
    const angleLabel = ANGLE_TYPE_SHORT[angleType];
    const checks = conn.checks || {};

    const referenceHtml = (() => {
      if (!conn.pointIds.length) return "";
      if (!data.closed) return `<p class="hint-text">Open traverse &mdash; no angular closure check applies. Compare your Adjusted values to the Actual (map) columns yourself.</p>`;
      if (data.n < 3) return `<p class="hint-text">Need at least 3 stations for a closed-loop angle check.</p>`;
      const theoretical = (data.n - 2) * 180;
      return `<p class="hint-text">Closed traverse, ${data.n} stations. Reference: interior angles of a closed polygon sum to (n&minus;2)&times;180&deg; = <strong>${theoretical}&deg;</strong>. This reference assumes interior angles - convert first if you're using a different angle type.</p>`;
    })();

    const rowsHtml = data.rows
      .filter(Boolean)
      .map(
        (r) => `
        <tr>
          <td>${r.hasOutgoing ? `${r.fromId} &rarr; ${r.toId}` : `${r.fromId} <span class="hint-text">(end)</span>`}</td>
          <td>${fieldInput(conn.id, r.pointId, "bs", r.fd.bs, "BS")}</td>
          <td>${fieldInput(conn.id, r.pointId, "fs", r.fd.fs, "FS")}</td>
          <td>${fieldInput(conn.id, r.pointId, "hi", r.fd.hi, "HI")}</td>
          <td>${fieldInput(conn.id, r.pointId, "elevation", r.fd.elevation, "elev")}</td>
          <td>${fmt(r.actualElev)}</td>
          <td>${r.hasOutgoing ? fieldInput(conn.id, r.pointId, "fieldDistance", r.fd.fieldDistance, "ft") : "&mdash;"}</td>
          <td>${r.hasOutgoing ? `${fmt(r.actualDistance)} ${r.unit}` : "&mdash;"}</td>
          <td>${r.hasAngle ? fieldInput(conn.id, r.pointId, "fieldAngle", r.fd.fieldAngle, "D°M'S\"", "text") : "&mdash;"}</td>
          <td>${r.hasAngle ? fieldInput(conn.id, r.pointId, "correction", r.fd.correction, "&plusmn;", "text") : "&mdash;"}</td>
          <td>${r.hasAngle ? fieldInput(conn.id, r.pointId, "adjustedAngle", r.fd.adjustedAngle, "D°M'S\"", "text") : "&mdash;"}</td>
          <td>${r.hasOutgoing ? fieldInput(conn.id, r.pointId, "fieldBearing", r.fd.fieldBearing, "N 00°00'00\" E", "text") : "&mdash;"}</td>
          <td>${r.hasOutgoing ? fieldInput(conn.id, r.pointId, "fieldAzimuth", r.fd.fieldAzimuth, "0-360°", "text") : "&mdash;"}</td>
          <td>${r.hasOutgoing ? fieldInput(conn.id, r.pointId, "adjustedBearing", r.fd.adjustedBearing, "N 00°00'00\" E", "text") : "&mdash;"}</td>
          <td>${r.hasOutgoing ? fieldInput(conn.id, r.pointId, "adjustedAzimuth", r.fd.adjustedAzimuth, "0-360°", "text") : "&mdash;"}</td>
          <td>${r.hasOutgoing ? r.actualBearing : "&mdash;"}</td>
          <td>${r.hasOutgoing ? toDms(r.actualAzimuth) : "&mdash;"}</td>
        </tr>
      `
      )
      .join("");

    return `
      <h4>Station Data &mdash; Elevation, Distance, Angle &amp; Bearing</h4>
      ${referenceHtml}
      <table class="adjust-table">
        <thead>
          <tr>
            <th rowspan="2">Station</th>
            <th colspan="5">Elevation (carried through the traverse)</th>
            <th colspan="2">Distance</th>
            <th colspan="3">Angle (your work)</th>
            <th colspan="4">Bearing / Azimuth</th>
            <th colspan="2">Actual (map)</th>
          </tr>
          <tr>
            <th>BS</th><th>FS</th><th>HI</th><th>Elev.</th><th>Actual Elev.</th>
            <th>Field</th><th>Actual</th>
            <th>Field ${angleLabel}</th><th>Corr.</th><th>Adj. ${angleLabel}</th>
            <th>Field Bearing</th><th>Field Azimuth</th>
            <th>Adj. Bearing</th><th>Adj. Azimuth</th>
            <th>Bearing</th><th>Azimuth</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <div class="closure-check">
        <strong>Your Angular Closure Check</strong>
        &Sigma; Field Angles: ${checkInput(conn.id, "sumAngles", checks.sumAngles, "deg")}&deg; &nbsp;
        Angular Misclosure: ${checkInput(conn.id, "angularMisclosure", checks.angularMisclosure, "&plusmn;")}&deg; &nbsp;
        Correction / Station: ${checkInput(conn.id, "correctionPerStation", checks.correctionPerStation, "&plusmn;")}&deg;
      </div>
      <div class="closure-check">
        <strong>Your Elevation Check</strong>
        &Sigma; BS: ${checkInput(conn.id, "sumBs", checks.sumBs, "ft")} ft &nbsp;
        &Sigma; FS: ${checkInput(conn.id, "sumFs", checks.sumFs, "ft")} ft &nbsp;
        Elev(last) &minus; Elev(first): ${checkInput(conn.id, "elevDiff", checks.elevDiff, "ft")} ft
        <p class="hint-text">Same idea as a differential-leveling arithmetic check: &Sigma;BS &minus; &Sigma;FS should equal Elev(last) &minus; Elev(first).</p>
      </div>
    `;
  }

  function renderLatDepTable(conn, data) {
    const checks = conn.checks || {};
    const legRows = data.rows.filter((r) => r && r.hasOutgoing);
    const actualPerimeter = legRows.reduce((a, r) => a + r.actualDistance, 0);

    const rowsHtml = legRows
      .map(
        (r) => `
        <tr>
          <td>${r.fromId} &rarr; ${r.toId}</td>
          <td data-mirror-dist="${conn.id}:${r.pointId}">${mirrorDistanceText(r.fd.fieldDistance, r.unit)}</td>
          <td data-mirror-bearing="${conn.id}:${r.pointId}">${r.fd.adjustedBearing || "--"}</td>
          <td>${fieldInput(conn.id, r.pointId, "latitude", r.fd.latitude, "&plusmn;ft")}</td>
          <td>${fieldInput(conn.id, r.pointId, "corrLat", r.fd.corrLat, "&plusmn;ft")}</td>
          <td>${fieldInput(conn.id, r.pointId, "adjLat", r.fd.adjLat, "&plusmn;ft")}</td>
          <td>${fmt(r.actualLatitude)} ${r.unit}</td>
          <td>${fieldInput(conn.id, r.pointId, "departure", r.fd.departure, "&plusmn;ft")}</td>
          <td>${fieldInput(conn.id, r.pointId, "corrDep", r.fd.corrDep, "&plusmn;ft")}</td>
          <td>${fieldInput(conn.id, r.pointId, "adjDep", r.fd.adjDep, "&plusmn;ft")}</td>
          <td>${fmt(r.actualDeparture)} ${r.unit}</td>
        </tr>
      `
      )
      .join("");

    const coordRows = data.stationRows
      .filter(Boolean)
      .map(
        (s) => `
        <tr>
          <td>${s.id}</td>
          <td>${fieldInput(conn.id, s.id, "adjNorthing", s.fd.adjNorthing, "N", "number", true)}</td>
          <td>${fieldInput(conn.id, s.id, "adjEasting", s.fd.adjEasting, "E", "number", true)}</td>
          <td>${fmt(s.actualNorthing)} ${data.unit}</td>
          <td>${fmt(s.actualEasting)} ${data.unit}</td>
        </tr>
      `
      )
      .join("");

    return `
      <h4>Latitude, Departure &amp; Coordinate Adjustment</h4>
      <p class="hint-text">Latitude = Length &times; cos(bearing); Departure = Length &times; sin(bearing). For each course: your Latitude, your Correction, then your Adjusted (calculated) Latitude - with the Actual Latitude (from the map's real coordinates) alongside to check against. Same for Departure. ${data.closed ? "Balance the closed figure (e.g. compass rule) and c" : "C"}arry adjusted coordinates forward from a known starting station.</p>
      <table class="adjust-table">
        <thead>
          <tr>
            <th rowspan="2">Course</th><th rowspan="2">Length</th><th rowspan="2">Bearing</th>
            <th colspan="4">Latitude</th>
            <th colspan="4">Departure</th>
          </tr>
          <tr>
            <th>Lat.</th><th>Corr.</th><th>Adj. (calc.)</th><th>Actual</th>
            <th>Dep.</th><th>Corr.</th><th>Adj. (calc.)</th><th>Actual</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <table class="adjust-table">
        <thead>
          <tr><th>Station</th><th>Adj. Northing</th><th>Adj. Easting</th><th>Actual Northing (map)</th><th>Actual Easting (map)</th></tr>
        </thead>
        <tbody>${coordRows}</tbody>
      </table>
      <div class="closure-check">
        <strong>Your Linear Closure Check</strong>
        &Sigma; Lat: ${checkInput(conn.id, "sumLat", checks.sumLat, "ft")} ft &nbsp;
        &Sigma; Dep: ${checkInput(conn.id, "sumDep", checks.sumDep, "ft")} ft &nbsp;
        Linear Misclosure: ${checkInput(conn.id, "misclosure", checks.misclosure, "ft")} ft &nbsp;
        Perimeter: ${checkInput(conn.id, "perimeter", checks.perimeter, "ft")} ft &nbsp;
        Precision: 1 : ${checkInput(conn.id, "precision", checks.precision, "e.g. 8500")}
        <p class="hint-text">Reference: Actual (map) perimeter = ${fmt(actualPerimeter)} ${data.unit}.</p>
      </div>
    `;
  }

  function renderConnectionBlock(conn) {
    const data = computeLegs(conn);
    return `
      <div class="survey-block" data-conn-id="${conn.id}">
        <div class="survey-block-header">
          <h3>${conn.name} <span class="hint-text">(${data.n} station${data.n === 1 ? "" : "s"}, ${data.closed ? "closed" : "open"})</span></h3>
          <div class="survey-block-actions">
            <label class="inline-label">Angle Type
              <select data-conn-meta="${conn.id}" data-field="angleType">
                ${Object.entries(ANGLE_TYPES).map(([v, l]) => `<option value="${v}" ${(conn.angleType || "interior") === v ? "selected" : ""}>${l}</option>`).join("")}
              </select>
            </label>
            <span class="hint-text">Open/Closed is set by the project's <strong>Type of Survey</strong> in the header.</span>
          </div>
        </div>
        ${renderStationTable(conn, data)}
        ${renderLatDepTable(conn, data)}
      </div>
    `;
  }

  function renderPanel(project) {
    const container = document.getElementById("traverseContainer");
    const conns = project.connections.filter((c) => c.type === "traverse");
    if (!conns.length) {
      container.innerHTML = `<p class="empty-hint">No traverse yet. Set the project's <strong>Type of Survey</strong> (header) to Traverse - Open or Closed, then add at least 2 points - this table builds itself automatically as you add them.</p>`;
      return;
    }
    const intro = `<p class="hint-text convention-note">Enter your own field readings and hand-worked correction/adjusted/latitude-departure values. Pick the <strong>Angle Type</strong> your course uses so the column headers match. The app only fills in the Actual (map) columns and known station coordinates, so you can check your work against ground truth - it never computes the adjustment for you.</p>`;
    container.innerHTML = intro + conns.map(renderConnectionBlock).join("");
  }

  function init() {
    const container = document.getElementById("traverseContainer");
    container.addEventListener("change", (e) => {
      const input = e.target.closest("input[data-conn][data-point]");
      if (input) {
        const raw = input.value;
        const value = input.type === "text" ? (raw === "" ? null : raw) : (raw === "" ? null : parseFloat(raw));
        const connId = input.dataset.conn, pointId = input.dataset.point, field = input.dataset.field;
        State.updateFieldData(connId, pointId, { [field]: value });
        // fieldDistance/adjustedBearing are mirrored read-only in the Lat/Dep
        // table below; updateFieldData is silent (no full re-render, so Tab
        // keeps moving to the next field instead of losing focus), so sync
        // those two mirror cells by hand instead of rebuilding everything.
        if (field === "fieldDistance") {
          const mirror = container.querySelector(`[data-mirror-dist="${connId}:${pointId}"]`);
          if (mirror) mirror.textContent = mirrorDistanceText(value, Coords.unitLabel());
        } else if (field === "adjustedBearing") {
          const mirror = container.querySelector(`[data-mirror-bearing="${connId}:${pointId}"]`);
          if (mirror) mirror.textContent = value || "--";
        }
        return;
      }
      const checkEl = e.target.closest("input[data-conn-check]");
      if (checkEl) {
        State.updateConnectionChecks(checkEl.dataset.connCheck, { [checkEl.dataset.field]: checkEl.value === "" ? null : checkEl.value });
        return;
      }
      const metaSel = e.target.closest("select[data-conn-meta]");
      if (metaSel) {
        State.updateConnectionMeta(metaSel.dataset.connMeta, { [metaSel.dataset.field]: metaSel.value });
      }
    });
  }

  return {
    computeLegs,
    legDistance,
    azimuthBetween,
    azimuthToBearingString,
    toDms,
    ANGLE_TYPES,
    init,
    renderPanel,
  };
})();

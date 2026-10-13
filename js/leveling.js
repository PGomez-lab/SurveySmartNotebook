/* leveling.js
 * Differential leveling worksheet: automatically built from every point whose
 * Survey Type is "Differential Leveling - Points/Loop", in the order they
 * were added - no separate Connect Points step needed.
 *
 * With one rod and one instrument, a turning point gets sighted from TWO
 * different instrument setups: the incoming foresight (from the setup that's
 * finishing) and, once the instrument moves ahead and the rod stays put, the
 * outgoing backsight (starting the next setup). Those are two independent
 * sightings at different distances from the point, so each gets its own full
 * set of fields - Foresight Shot and Backsight Shot are separate column
 * groups (Foresight first, since it's the one taken first in the field),
 * each recording distance two ways (stadia hairs and a taped measurement) -
 * rather than one shared BS/FS/distance per row.
 *
 * A closed run doesn't need a separate "closing point" added back at the
 * benchmark's location (same idea as a closed Traverse never repeating its
 * first station's ID) - the loop just closes back onto the benchmark
 * itself. That makes the benchmark (the first station) the only point whose
 * shots depend on open vs. closed: in an OPEN run it only ever has an
 * outgoing Backsight (nothing precedes it, and nothing closes back onto
 * it); in a CLOSED run it ALSO gets a closing Foresight once the loop comes
 * back around. Likewise, the last station before that closure needs its own
 * new setup to sight the benchmark again - a turning point in every way but
 * name - while an open run's last station is a true dead end (Foresight
 * only, the run just ends there). Every other station gets a Foresight if
 * it's just a shot, or both if it's a turning point (a role set on the point
 * itself, in its point-form modal).
 *
 * This module does NOT compute HI, Elevation, or closure for the student.
 * Those are the calculations the course is teaching, so every one of those
 * cells is a plain input the student fills in by hand from their own
 * BS/FS/stadia readings. The table itself only shows the raw field readings -
 * PT, BS, HI, FS, Elevation, and each shot's stadia top/bottom and taped
 * distance - the Actual Elevation lookup used for the closure reference below
 * the table is computed here but not rendered as its own column.
 */

const Leveling = (() => {
  function fmt(n, digits = 2) {
    return n === null || n === undefined || Number.isNaN(n) ? "--" : n.toFixed(digits);
  }

  // Free-text check/field values can contain a literal " - unescaped, that
  // closes the value="..." attribute early and silently truncates whatever
  // the student typed on the next render.
  function escapeAttr(v) {
    return String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function fieldInput(connId, pointId, field, value, placeholder, type = "number") {
    const attrs = type === "number" ? 'step="0.01"' : "";
    const v = value === null || value === undefined ? "" : value;
    return `<input type="${type}" ${attrs} data-conn="${connId}" data-point="${pointId}" data-field="${field}" value="${escapeAttr(v)}" placeholder="${placeholder}" />`;
  }

  // Number, not text (unlike Traverse's own closure checks, which include
  // free-text ratios like "1:8500") - every leveling arithmetic-check value
  // is a plain ft measurement, held to the same 2-decimal precision as the
  // table's other fields.
  function checkInput(connId, field, value, placeholder = "") {
    const v = value === null || value === undefined ? "" : value;
    return `<input type="number" step="0.01" class="check-input" data-conn-check="${connId}" data-field="${field}" value="${escapeAttr(v)}" placeholder="${placeholder}" />`;
  }

  function computeRows(conn) {
    const stations = conn.pointIds.slice();
    const pts = stations.map((id) => State.getPoint(id));
    const fieldData = conn.fieldData || {};
    const n = pts.length;
    const closed = conn.surveyType === "closed";

    const rows = pts.map((pt, i) => {
      if (!pt) return null;
      // Seed the raw readings from the point's own quick-entry (recorded
      // when the point was added/edited on the map), then let anything
      // already entered here override it. bsDistStadia/fsDistStadia are the
      // exception - the distance calculated by hand from the stadia
      // readings is worked out later, like the Traverse Table's Adjusted
      // values, so it's never seeded, only ever entered here in the table.
      const fd = Object.assign(
        {
          bs: pt.bs, hi: pt.hi, fs: pt.fs,
          bsStadiaTop: pt.bsStadiaTop, bsStadiaBottom: pt.bsStadiaBottom, bsDistTaped: pt.bsDistTaped, bsDistPacing: pt.bsDistPacing,
          fsStadiaTop: pt.fsStadiaTop, fsStadiaBottom: pt.fsStadiaBottom, fsDistTaped: pt.fsDistTaped, fsDistPacing: pt.fsDistPacing,
        },
        fieldData[pt.id] || {}
      );
      const isFirst = i === 0;
      const isLast = i === n - 1;
      // isTurningPoint is a survey ROLE, set on the point itself (in its
      // point-form modal) - see state.js.
      const isTurningPoint = !isFirst && !isLast && !!pt.isTurningPoint;
      // In a closed run the loop comes back around onto the benchmark
      // itself - no separate "closing point" needed (same idea as a closed
      // Traverse never repeating its first station's ID). That makes the
      // last station before closure a turning point in every but name (a
      // new setup still has to sight the benchmark again), and gives the
      // benchmark a closing Foresight on top of its opening Backsight. Only
      // a truly open run's benchmark has no Foresight at all.
      const isClosingSetup = closed && isLast;
      return {
        pointId: pt.id,
        isFirst,
        isLast,
        isTurningPoint,
        isClosingSetup,
        hasBsShot: isFirst || isTurningPoint || isClosingSetup,
        hasFsShot: !isFirst || closed,
        actualElev: pt.elevation === null || pt.elevation === undefined ? null : pt.elevation,
        fd,
      };
    });

    return { rows, closed, n, unit: "ft" };
  }

  // The physical sighting lines a leveling run's rod+tripod actually make:
  // with one rod and one instrument, the tripod stays put for every plain
  // Foresight shot (only the rod moves) and only relocates to a new setup at
  // a turning point (or, for a closed run, to close the loop back onto the
  // benchmark). Each reading prefers the ACTUAL tripod location the student
  // recorded (point.fsTripodId/bsTripodId) - once placed, sighting lines
  // route through it instead of straight rod-to-rod. Without a tripod
  // placed for a given setup yet, falls back to the previous point's own
  // location as an approximation, so this still works before any tripod
  // exists. Returns { from, to, pointId, isSpur } segments (from/to are
  // {lat,lng} - never just conn.pointIds chained in sequence) - pointId is
  // whichever point's rod is being sighted, for click-to-edit. isSpur marks
  // a plain point's Foresight (Benchmark/Turning Point/closing shots are the
  // "chain" the survey actually advances along; a plain point is just a
  // side reading - its own Foresight, distance, and stadia - that the path
  // never continues from) so a map can draw it lighter than the chain.
  // Shared by MapView and PlanView so both stay consistent with what the
  // Leveling Table itself considers a turning point.
  function computeAnchorSegments(conn) {
    const data = computeRows(conn);
    const ids = conn.pointIds;
    const segments = [];
    let activeAnchor = null; // {lat,lng} - last known tripod, or a point standing in for one
    for (let i = 0; i < ids.length; i++) {
      const row = data.rows[i];
      if (!row) continue;
      const pt = State.getPoint(ids[i]);
      if (!pt) continue;

      if (row.hasFsShot && !row.isFirst) {
        const fsTripod = pt.fsTripodId ? State.getTripod(pt.fsTripodId) : null;
        const from = fsTripod || activeAnchor;
        if (from) segments.push({ from, to: pt, pointId: pt.id, isSpur: !row.hasBsShot });
      }
      if (row.hasBsShot) {
        const bsTripod = pt.bsTripodId ? State.getTripod(pt.bsTripodId) : null;
        if (bsTripod) segments.push({ from: bsTripod, to: pt, pointId: pt.id, isSpur: false });
        activeAnchor = bsTripod || pt;
      }
    }
    if (data.closed && activeAnchor) {
      const bm = State.getPoint(ids[0]);
      if (bm) segments.push({ from: activeAnchor, to: bm, pointId: bm.id, isSpur: false });
    }
    return segments;
  }

  function rowHtml(conn, r) {
    if (!r) return "";
    // Foresight before Backsight, matching the order they actually happen
    // in the field: FS closes out the setup that's finishing (or, for a
    // closed run's benchmark, closes the whole loop) before a new Backsight
    // ever gets taken here.
    const fsCell = r.hasFsShot ? fieldInput(conn.id, r.pointId, "fs", r.fd.fs, "FS") : "&mdash;";
    const bsCell = r.hasBsShot ? fieldInput(conn.id, r.pointId, "bs", r.fd.bs, "BS") : "&mdash;";
    const hiCell = r.hasBsShot ? fieldInput(conn.id, r.pointId, "hi", r.fd.hi, "HI") : "&mdash;";
    const fsDist = r.hasFsShot
      ? [
          fieldInput(conn.id, r.pointId, "fsStadiaTop", r.fd.fsStadiaTop, "top"),
          fieldInput(conn.id, r.pointId, "fsStadiaBottom", r.fd.fsStadiaBottom, "bot"),
          fieldInput(conn.id, r.pointId, "fsDistTaped", r.fd.fsDistTaped, "dist"),
          fieldInput(conn.id, r.pointId, "fsDistPacing", r.fd.fsDistPacing, "dist"),
        ]
      : ["&mdash;", "&mdash;", "&mdash;", "&mdash;"];
    const bsDist = r.hasBsShot
      ? [
          fieldInput(conn.id, r.pointId, "bsStadiaTop", r.fd.bsStadiaTop, "top"),
          fieldInput(conn.id, r.pointId, "bsStadiaBottom", r.fd.bsStadiaBottom, "bot"),
          fieldInput(conn.id, r.pointId, "bsDistTaped", r.fd.bsDistTaped, "dist"),
          fieldInput(conn.id, r.pointId, "bsDistPacing", r.fd.bsDistPacing, "dist"),
        ]
      : ["&mdash;", "&mdash;", "&mdash;", "&mdash;"];
    const startLabel = r.isFirst ? (r.hasFsShot ? " <span class=\"hint-text\">(start / close)</span>" : " <span class=\"hint-text\">(start)</span>") : "";
    const closeLabel = r.isLast && !r.isFirst ? ` <span class="hint-text">(${r.isClosingSetup ? "final setup" : "close"})</span>` : "";
    return `
      <tr class="${r.isTurningPoint || r.isClosingSetup ? "tp-row" : ""}">
        <td>${r.pointId}${startLabel}${closeLabel}</td>
        <td>${bsCell}</td>
        <td>${hiCell}</td>
        <td>${fsCell}</td>
        <td>${fieldInput(conn.id, r.pointId, "elevation", r.fd.elevation, "elev")}</td>
        <td>${fsDist[0]}</td><td>${fsDist[1]}</td><td>${fsDist[2]}</td><td>${fsDist[3]}</td>
        <td>${bsDist[0]}</td><td>${bsDist[1]}</td><td>${bsDist[2]}</td><td>${bsDist[3]}</td>
      </tr>
    `;
  }

  function renderConnectionBlock(conn) {
    const data = computeRows(conn);
    // A closed run closes back onto the benchmark itself (the first row),
    // not a separate closing point - that's what its Actual Elev. reference
    // is checked against.
    const benchmarkRow = data.rows[0];
    const checks = conn.checks || {};
    const referenceHtml = (() => {
      if (!data.closed) return `<p class="hint-text">Open level run &mdash; no closure reference. Compare your final computed Elevation to the rod's own known elevation yourself.</p>`;
      if (!benchmarkRow || benchmarkRow.actualElev === null) return `<p class="hint-text">The benchmark needs a known elevation entered (on the rod itself) before you can check closure against it.</p>`;
      return `<p class="hint-text">Closed level run. Reference: the benchmark's known elevation is <strong>${fmt(benchmarkRow.actualElev)} ft</strong> - the loop closes back onto it, so fill in the benchmark's own Foresight (its row above) once you've walked the whole loop. Work out your own misclosure and distance-proportional correction, then compare your final Elevation to this value.</p>`;
    })();

    return `
      <div class="survey-block" data-conn-id="${conn.id}">
        <div class="survey-block-header">
          <h3>${conn.name} <span class="hint-text">(${data.closed ? "closed" : "open"} level run, ${data.n} setup${data.n === 1 ? "" : "s"})</span></h3>
          <span class="hint-text">Open/Closed is set by the project's <strong>Type of Survey</strong> in the header.</span>
        </div>
        <table class="adjust-table">
          <thead>
            <tr>
              <th rowspan="2">ROD</th>
              <th rowspan="2">BS</th>
              <th rowspan="2">HI</th>
              <th rowspan="2">FS</th>
              <th rowspan="2">ELEV.</th>
              <th colspan="4">Foresight Shot (sighting this rod)</th>
              <th colspan="4">Backsight Shot (starting a new setup here)</th>
            </tr>
            <tr>
              <th>Top Stadia</th><th>Bottom Stadia</th><th>DIST. (Taped)</th><th>DIST. (Pacing)</th>
              <th>Top Stadia</th><th>Bottom Stadia</th><th>DIST. (Taped)</th><th>DIST. (Pacing)</th>
            </tr>
          </thead>
          <tbody>${data.rows.map((r) => rowHtml(conn, r)).join("")}</tbody>
          <tfoot>
            <tr class="check-row">
              <td><strong>Your Arithmetic Check</strong></td>
              <td><span class="check-label">&Sigma; BS (ft)</span>${checkInput(conn.id, "sumBs", checks.sumBs, "ft")}</td>
              <td>&mdash;</td>
              <td><span class="check-label">&Sigma; FS (ft)</span>${checkInput(conn.id, "sumFs", checks.sumFs, "ft")}</td>
              <td><span class="check-label">Elev(last) &minus; Elev(first) (ft)</span>${checkInput(conn.id, "elevDiff", checks.elevDiff, "ft")}</td>
              <td colspan="8" class="hint-text check-note">&Sigma;BS &minus; &Sigma;FS should equal Elev(last) &minus; Elev(first). Do this check on your own numbers before comparing anything to a known elevation.</td>
            </tr>
          </tfoot>
        </table>
        ${referenceHtml}
      </div>
    `;
  }

  function renderPanel(project) {
    const container = document.getElementById("levelingContainer");
    const conns = project.connections.filter((c) => c.type === "level");
    if (!conns.length) {
      container.innerHTML = `<p class="empty-hint">No leveling run yet. Set the project's <strong>Type of Survey</strong> (header) to Differential Leveling - Rods or Loop, then add at least 2 rods - this table builds itself automatically as you add them.</p>`;
      return;
    }
    const intro = `<p class="hint-text convention-note">Enter your own BS/HI/FS/Elevation, stadia, taped, and pacing readings (rounded to the nearest hundredth). With one rod and one instrument, a turning rod is sighted from two different setups - the incoming Foresight Shot and, once the instrument moves and the rod stays put, the outgoing Backsight Shot for the next setup - so each gets its own Top/Bottom Stadia, Taped Distance, and Pacing Distance. A rod's Turning Rod role is set in its own rod-form. For a closed run, the loop closes back onto the benchmark itself - no separate closing rod needed - so once you've walked the whole loop, come back and fill in the benchmark's own Foresight Shot. Do your arithmetic check (&Sigma;BS &minus; &Sigma;FS) in the table's last row before comparing your Elevation column to the closure reference.</p>`;
    container.innerHTML = intro + conns.map(renderConnectionBlock).join("");
  }

  // Rounded to 2 decimals on commit - every field in this table (and the
  // arithmetic check below it) is a real ft measurement, held to the
  // nearest hundredth.
  function round2(v) {
    return v === null || v === undefined || Number.isNaN(v) ? null : Math.round(v * 100) / 100;
  }

  function init() {
    const container = document.getElementById("levelingContainer");
    container.addEventListener("change", (e) => {
      const input = e.target.closest("input[data-conn][data-point]");
      if (input) {
        const value = round2(input.value === "" ? null : parseFloat(input.value));
        input.value = value === null ? "" : value;
        State.updateFieldData(input.dataset.conn, input.dataset.point, { [input.dataset.field]: value });
        return;
      }
      const checkEl = e.target.closest("input[data-conn-check]");
      if (checkEl) {
        const value = round2(checkEl.value === "" ? null : parseFloat(checkEl.value));
        checkEl.value = value === null ? "" : value;
        State.updateConnectionChecks(checkEl.dataset.connCheck, { [checkEl.dataset.field]: value });
        return;
      }
      const metaSel = e.target.closest("select[data-conn-meta]");
      if (metaSel) {
        State.updateConnectionMeta(metaSel.dataset.connMeta, { [metaSel.dataset.field]: metaSel.value });
      }
    });
  }

  return { computeRows, computeAnchorSegments, init, renderPanel };
})();

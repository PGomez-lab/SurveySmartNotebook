/* csvexport.js
 * Downloads the survey data as a single CSV file, alongside the PDF report:
 *   1. Field Notebook - every rod's core data (same columns as the notebook
 *      table/PDF Survey Data table).
 *   2. Traverse - the Rod Data worksheet (if a traverse run exists) plus its
 *      closure checks.
 *   3. Differential Leveling - the Foresight/Backsight shot worksheet (if a
 *      leveling run exists) plus its arithmetic check.
 * The Top View map has no tabular equivalent, so it's the one PDF page this
 * doesn't carry over. Sections are stacked vertically in one sheet (plain
 * CSV has no concept of multiple tabs), separated by a blank row.
 */

const CsvExport = (() => {
  function csvEscape(v) {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function rowsToCsv(rows) {
    return rows.map((r) => r.map(csvEscape).join(",")).join("\r\n");
  }

  // 2-decimal precision, matching the app's own display/entry convention.
  function fmt(n) {
    return n === null || n === undefined || n === "" || Number.isNaN(Number(n)) ? "" : Number(n).toFixed(2);
  }
  function raw(v) {
    return v === null || v === undefined ? "" : v;
  }

  function buildNotebookSection(project) {
    const rows = [["Field Notebook"]];
    rows.push(["Rod", "Northing", "Easting", "Elevation (ft)", "Feature Type", "Survey Type", "Description", "Date Collected", "Notes"]);
    project.points.forEach((p) => {
      rows.push([
        p.id,
        fmt(p.northing),
        fmt(p.easting),
        fmt(p.elevation),
        p.featureType,
        State.SURVEY_CATEGORIES[p.surveyCategory || "none"] || "General Rod",
        p.description || "",
        p.dateCollected || "",
        p.notes || "",
      ]);
    });
    if (!project.points.length) rows.push(["No rods collected"]);
    return rows;
  }

  function buildTraverseSection(project) {
    const conns = project.connections.filter((c) => c.type === "traverse");
    if (!conns.length) return null;
    const conn = conns[0];
    const data = Traverse.computeLegs(conn);
    const checks = conn.checks || {};
    const rows = [[`Traverse - ${conn.name} (${data.closed ? "closed" : "open"})`]];
    rows.push([
      "Rod", "Field Angle", "Correction", "Adjusted Angle",
      "Bearing", "Azimuth", "Distance",
      "Adjusted Bearing", "Adjusted Azimuth",
      "Actual Bearing", "Actual Azimuth", "Actual Distance",
    ]);
    data.rows.filter(Boolean).forEach((r) => {
      rows.push([
        r.hasOutgoing ? `${r.fromId} -> ${r.toId}` : `${r.fromId} (end)`,
        r.hasAngle ? raw(r.fd.fieldAngle) : "",
        r.hasAngle ? raw(r.fd.correction) : "",
        r.hasAngle ? raw(r.fd.adjustedAngle) : "",
        r.hasOutgoing ? raw(r.fd.fieldBearing) : "",
        r.hasOutgoing ? raw(r.fd.fieldAzimuth) : "",
        r.hasOutgoing && r.fd.fieldDistance ? fmt(r.fd.fieldDistance) : "",
        r.hasOutgoing ? raw(r.fd.adjustedBearing) : "",
        r.hasOutgoing ? raw(r.fd.adjustedAzimuth) : "",
        r.hasOutgoing ? r.actualBearing : "",
        r.hasOutgoing ? Traverse.toDms(r.actualAzimuth) : "",
        r.hasOutgoing ? fmt(r.actualDistance) : "",
      ]);
    });
    rows.push([]);
    rows.push(["Angular closure check", "Sum Field Angles (deg)", raw(checks.sumAngles), "Angular Misclosure (deg)", raw(checks.angularMisclosure), "Correction/Rod (deg)", raw(checks.correctionPerStation)]);
    rows.push(["Linear closure check", "Sum Lat (ft)", raw(checks.sumLat), "Sum Dep (ft)", raw(checks.sumDep), "Misclosure (ft)", raw(checks.misclosure), "Perimeter (ft)", raw(checks.perimeter), "Precision 1:", raw(checks.precision)]);
    return rows;
  }

  function buildLevelingSection(project) {
    const conns = project.connections.filter((c) => c.type === "level");
    if (!conns.length) return null;
    const conn = conns[0];
    const data = Leveling.computeRows(conn);
    const checks = conn.checks || {};
    const rows = [[`Differential Leveling - ${conn.name} (${data.closed ? "closed" : "open"})`]];
    rows.push([
      "Rod", "BS", "HI", "FS", "Elevation",
      "FS Stadia Top", "FS Stadia Bottom", "FS Dist. (Taped)", "FS Dist. (Pacing)",
      "BS Stadia Top", "BS Stadia Bottom", "BS Dist. (Taped)", "BS Dist. (Pacing)",
    ]);
    data.rows.filter(Boolean).forEach((r) => {
      rows.push([
        r.pointId,
        fmt(r.fd.bs), fmt(r.fd.hi), fmt(r.fd.fs), fmt(r.fd.elevation),
        fmt(r.fd.fsStadiaTop), fmt(r.fd.fsStadiaBottom), fmt(r.fd.fsDistTaped), fmt(r.fd.fsDistPacing),
        fmt(r.fd.bsStadiaTop), fmt(r.fd.bsStadiaBottom), fmt(r.fd.bsDistTaped), fmt(r.fd.bsDistPacing),
      ]);
    });
    rows.push([]);
    rows.push(["Arithmetic check", "Sum BS (ft)", fmt(checks.sumBs), "Sum FS (ft)", fmt(checks.sumFs), "Elev(last)-Elev(first) (ft)", fmt(checks.elevDiff)]);
    return rows;
  }

  function generate(project) {
    let rows = [];
    rows.push([project.meta.title || "Untitled Survey"]);
    rows.push(["Team", project.meta.teamName || "", "Date", project.meta.date || "", "Coordinate System", Coords.systemLabel()]);
    rows.push([]);
    rows = rows.concat(buildNotebookSection(project));

    const traverseRows = buildTraverseSection(project);
    if (traverseRows) {
      rows.push([]);
      rows = rows.concat(traverseRows);
    }
    const levelRows = buildLevelingSection(project);
    if (levelRows) {
      rows.push([]);
      rows = rows.concat(levelRows);
    }

    const csv = rowsToCsv(rows);
    const safeName = (project.meta.title || "survey-project").replace(/[^a-z0-9\-_]+/gi, "_");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${safeName}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return { generate };
})();

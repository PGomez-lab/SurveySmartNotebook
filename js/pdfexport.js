/* pdfexport.js
 * Assembles the survey deliverable as a single landscape page, stacked
 * top to bottom:
 *   - Top View (map) across the top.
 *   - Survey Data Table (condensed field notebook) beneath the map.
 *   - Findings - the Traverse or Differential Leveling worksheet (whichever
 *     the project's Type of Survey is scoped to; for an unscoped "General /
 *     Mixed" project, whichever type actually has data, traverse taking
 *     priority if both do) - at the bottom.
 * Everything is condensed (small fonts, trimmed to the essential columns)
 * specifically to fit one page - this is a compact summary, not a substitute
 * for reading the full worksheet inside the app itself.
 * Built with jsPDF + jsPDF-AutoTable, landscape US Letter.
 */

const PdfExport = (() => {
  const PAGE_W = 792, PAGE_H = 612, MARGIN = 18;

  function fmt(n, digits = 2) {
    return n === null || n === undefined || n === "" || Number.isNaN(Number(n)) ? "--" : Number(n).toFixed(digits);
  }
  // For free-text student entries (DMS angles, bearings) - show verbatim, never parse as a number.
  function raw(v) {
    return v === null || v === undefined || v === "" ? "--" : String(v);
  }

  function header(doc, project) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.setTextColor(28, 37, 48);
    doc.text(project.meta.title || "Untitled Survey", MARGIN, MARGIN + 4);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(90, 100, 110);
    doc.text(
      `Team: ${project.meta.teamName || "--"}   |   Date: ${project.meta.date || "--"}   |   ${Coords.systemLabel()}`,
      MARGIN,
      MARGIN + 16
    );
    doc.setDrawColor(200, 206, 212);
    doc.line(MARGIN, MARGIN + 22, PAGE_W - MARGIN, MARGIN + 22);
    return MARGIN + 30;
  }

  function footer(doc, project) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(140, 148, 156);
    doc.text("Smart Survey Notebook", MARGIN, PAGE_H - 8);
    doc.text(`Points: ${project.points.length}   Connections: ${project.connections.length}`, PAGE_W - MARGIN, PAGE_H - 8, { align: "right" });
  }

  // Same scoping rule the app UI uses (see surveyScope() in app.js) - a
  // project committed to one survey type only reports the section relevant
  // to it; "General / Mixed" falls back to whichever type has data.
  function surveyScope(surveyType) {
    if (surveyType === "levelingPoints" || surveyType === "levelingLoop") return "leveling";
    if (surveyType === "traverseOpen" || surveyType === "traverseClosed") return "traverse";
    return "all";
  }

  // Renders the Top View at whatever pixel shape the caller asks for -
  // PlanView.render() adapts its own zoom/extent math to the canvas's own
  // width/height, so a wide, short canvas (matching the full-width banner
  // here) fills that space instead of being letterboxed.
  async function planViewImage(project, w, h) {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    await PlanView.render(canvas, project);
    return canvas.toDataURL("image/png");
  }

  const ANGLE_TYPE_LABEL = {
    interior: "Interior Angle",
    angleRight: "Angle to the Right",
    deflectionLeft: "Deflection Angle (Left)",
    deflectionRight: "Deflection Angle (Right)",
    azimuth: "Azimuth (measured directly)",
  };

  // jsPDF-AutoTable paginates by default (adding a new page) once a table
  // runs past the bottom margin - fine for the old multi-page report, fatal
  // to a hard one-page requirement. Rather than fight that behavior, each
  // table's row count is capped up front to whatever provably fits in its
  // budgeted height, with a note if anything had to be left off.
  function rowHeightFor(fontSize, cellPadding) {
    return fontSize * 1.15 + cellPadding * 2 + 1.5;
  }
  function maxRowsFor(availableHeight, fontSize, cellPadding) {
    const rowH = rowHeightFor(fontSize, cellPadding);
    // +1e-6 guards against floating-point rounding (e.g. 51.9/12.975 landing
    // a hair under 4.0) needlessly truncating a row that actually fits.
    return Math.max(0, Math.floor(availableHeight / rowH + 1e-6) - 1); // -1 reserves the header row
  }

  function truncationNote(doc, x, y, hiddenCount, w) {
    if (hiddenCount <= 0) return;
    doc.setFont("helvetica", "italic");
    doc.setFontSize(6);
    doc.setTextColor(140, 148, 156);
    doc.text(`+ ${hiddenCount} more not shown (see the full worksheet in the app)`, x, y);
  }

  // Candidates for the shared table font, largest first. A sparse project
  // (a handful of points/setups) should read like a full-page report, not a
  // tiny table stranded above dead white space - so tables scale UP to fill
  // whatever room they're given, and only fall back to small/dense text
  // (with the usual maxRowsFor truncation) once the data genuinely needs it.
  // Capped at 8pt: the Findings tables run 16-17 columns wide, and several
  // header labels ("Actual Elev.", "Actual Bearing") are long enough to wrap
  // to a second line past that size before every column has room to keep
  // them on one - which silently eats the row-height estimate below. The
  // Survey Data table (5 columns, short headers) would tolerate more, but
  // matching fonts across both tables reads better than mismatched sizes,
  // and reclaimed space isn't wasted - it just goes to a bigger map instead.
  const FILL_FONT_CANDIDATES = [
    { fontSize: 8, cellPadding: 2.2 },
    { fontSize: 7.5, cellPadding: 2 },
    { fontSize: 7, cellPadding: 1.8 },
    { fontSize: 6.5, cellPadding: 1.5 },
    { fontSize: 6, cellPadding: 1.3 },
    { fontSize: 5.5, cellPadding: 1.1 },
    { fontSize: 5, cellPadding: 1 },
  ];

  // Picks the largest shared font/padding at which every table in `tables`
  // (each `{ rows, extra }`, `extra` covering that table's own title/
  // subtitle/closure text) fits inside availableHeight. Falls back to the
  // smallest candidate - at which point each table's own maxRowsFor still
  // truncates gracefully, exactly as before this existed.
  function pickStyleToFill(availableHeight, tables) {
    for (const cand of FILL_FONT_CANDIDATES) {
      const rowH = rowHeightFor(cand.fontSize, cand.cellPadding);
      const totalH = tables.reduce((sum, t) => sum + (t.rows + 1) * rowH + t.extra, 0);
      if (totalH <= availableHeight + 1e-6) return cand;
    }
    return FILL_FONT_CANDIDATES[FILL_FONT_CANDIDATES.length - 1];
  }

  // Condensed Survey Data Table - the essential point log. Full detail
  // (Northing/Easting/Notes/Photo/etc.) is still in the app itself; this is
  // a summary, not a replacement.
  function drawDataTable(doc, project, x, y, w, maxY, style) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(28, 37, 48);
    doc.text("Survey Data", x, y);

    const startY = y + 4;
    const maxRows = maxRowsFor(maxY - startY - 8, style.fontSize, style.cellPadding);
    const allRows = project.points;
    const rowsToShow = allRows.slice(0, maxRows);

    const head = ["Point", "Elev.", "Feature", "Survey Type", "Description"];
    const body = rowsToShow.map((p) => [
      p.id,
      p.elevation === null || p.elevation === undefined || p.elevation === "" ? "--" : `${p.elevation}`,
      p.featureType,
      State.SURVEY_CATEGORIES[p.surveyCategory || "none"] || "General Point",
      p.description || "",
    ]);
    const emptyRow = ["--", "--", "--", "--", "No points collected"];

    doc.autoTable({
      head: [head],
      body: body.length ? body : [emptyRow],
      startY,
      margin: { left: x },
      tableWidth: w,
      styles: { fontSize: style.fontSize, cellPadding: style.cellPadding, overflow: "ellipsize" },
      headStyles: { fillColor: [31, 95, 139], textColor: 255 },
      alternateRowStyles: { fillColor: [244, 246, 248] },
      columnStyles: {
        0: { cellWidth: w * 0.08 },
        1: { cellWidth: w * 0.08 },
        2: { cellWidth: w * 0.14 },
        3: { cellWidth: w * 0.24 },
        4: { cellWidth: w * 0.46 },
      },
    });
    let ny = doc.lastAutoTable.finalY;
    if (allRows.length > rowsToShow.length) {
      truncationNote(doc, x, ny + 8, allRows.length - rowsToShow.length, w);
      ny += 10;
    }
    return ny;
  }

  // Traverse findings - the full Station Data worksheet (Field/Adjusted
  // angle, bearing, azimuth, distance, elevation), plus the closure check.
  // Full page width comfortably fits every column, unlike the half-width
  // column this used to be squeezed into.
  function drawTraverseFindings(doc, project, x, y, w, maxY, style) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(28, 37, 48);
    doc.text("Findings - Traverse", x, y);
    y += 4;

    const conns = project.connections.filter((c) => c.type === "traverse");
    if (!conns.length) {
      doc.setFont("helvetica", "italic");
      doc.setFontSize(7.5);
      doc.setTextColor(120, 128, 136);
      doc.text("No traverse connections defined.", x, y + 8);
      return;
    }

    const conn = conns[0];
    const t = Traverse.computeLegs(conn);
    const checks = conn.checks || {};
    const angleType = ANGLE_TYPE_LABEL[conn.angleType || "interior"] || ANGLE_TYPE_LABEL.interior;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(6.5);
    doc.setTextColor(90, 100, 110);
    doc.text(`${t.name} - ${t.closed ? "closed" : "open"}, ${t.n} stations, ${angleType}`, x, y + 6);

    const tableStartY = y + 10;
    const closureH = 18; // reserve two lines (angular + linear closure summaries)
    // This table's headers (17 columns, some long - "Actual Bearing", "Field
    // Azimuth", etc.) can wrap to a second line at a larger shared font
    // before a narrower column has room to keep them on one - reserve a
    // whole extra row's height so that (rare) wrap can never silently push a
    // body row onto a page that then gets deleted by the safety net below.
    const rowH = rowHeightFor(style.fontSize, style.cellPadding);
    const maxRows = maxRowsFor(maxY - tableStartY - closureH - rowH, style.fontSize, style.cellPadding);
    const allRows = t.rows.filter(Boolean);
    const rowsToShow = allRows.slice(0, maxRows);

    doc.autoTable({
      head: [["Station", "BS", "FS", "HI", "Elev.", "Actual Elev.", "Field Dist.", "Actual Dist.", "Field Ang.", "Corr.", "Adj. Ang.", "Field Bearing", "Field Azimuth", "Adj. Bearing", "Adj. Azimuth", "Actual Bearing", "Actual Azimuth"]],
      body: rowsToShow.map((r) => [
        r.hasOutgoing ? `${r.fromId} -> ${r.toId}` : `${r.fromId} (end)`,
        fmt(r.fd.bs, 3),
        fmt(r.fd.fs, 3),
        fmt(r.fd.hi),
        fmt(r.fd.elevation),
        fmt(r.actualElev),
        r.hasOutgoing && r.fd.fieldDistance ? fmt(r.fd.fieldDistance) : "--",
        r.hasOutgoing ? fmt(r.actualDistance) : "--",
        r.hasAngle ? raw(r.fd.fieldAngle) : "--",
        r.hasAngle ? raw(r.fd.correction) : "--",
        r.hasAngle ? raw(r.fd.adjustedAngle) : "--",
        r.hasOutgoing ? raw(r.fd.fieldBearing) : "--",
        r.hasOutgoing ? raw(r.fd.fieldAzimuth) : "--",
        r.hasOutgoing ? raw(r.fd.adjustedBearing) : "--",
        r.hasOutgoing ? raw(r.fd.adjustedAzimuth) : "--",
        r.hasOutgoing ? r.actualBearing : "--",
        r.hasOutgoing ? Traverse.toDms(r.actualAzimuth) : "--",
      ]),
      startY: tableStartY,
      margin: { left: x },
      tableWidth: w,
      styles: { fontSize: style.fontSize, cellPadding: style.cellPadding, overflow: "ellipsize" },
      headStyles: { fillColor: [193, 39, 45], textColor: 255 },
    });
    let ny = doc.lastAutoTable.finalY + 6;
    if (allRows.length > rowsToShow.length) {
      truncationNote(doc, x, ny, allRows.length - rowsToShow.length, w);
      ny += 8;
    }
    if (ny > maxY - 16) return ny;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(6.5);
    doc.setTextColor(90, 100, 110);
    doc.text(
      `Angular closure - Sum Field Angles: ${raw(checks.sumAngles)} deg | Angular Misclosure: ${raw(checks.angularMisclosure)} deg | Correction/Station: ${raw(checks.correctionPerStation)} deg`,
      x, ny
    );
    ny += 9;
    doc.text(
      `Linear closure - Sum Lat: ${raw(checks.sumLat)} ft | Sum Dep: ${raw(checks.sumDep)} ft | Misclosure: ${raw(checks.misclosure)} ft | Precision: 1:${raw(checks.precision)}`,
      x, ny
    );
    return ny + 9;
  }

  // Leveling findings - the full Foresight/Backsight shot worksheet (each
  // shot's reading, distance by stadia and by tape), plus the arithmetic
  // check. Full page width comfortably fits every column.
  function drawLevelingFindings(doc, project, x, y, w, maxY, style) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(28, 37, 48);
    doc.text("Findings - Differential Leveling", x, y);
    y += 4;

    const conns = project.connections.filter((c) => c.type === "level");
    if (!conns.length) {
      doc.setFont("helvetica", "italic");
      doc.setFontSize(7.5);
      doc.setTextColor(120, 128, 136);
      doc.text("No leveling runs defined.", x, y + 8);
      return;
    }

    const conn = conns[0];
    const t = Leveling.computeRows(conn);
    const checks = conn.checks || {};

    doc.setFont("helvetica", "normal");
    doc.setFontSize(6.5);
    doc.setTextColor(90, 100, 110);
    doc.text(`${conn.name} - ${t.closed ? "closed" : "open"}, ${t.n} setup${t.n === 1 ? "" : "s"}`, x, y + 6);

    const tableStartY = y + 10;
    const closureH = 10; // reserve one line for the arithmetic-check summary
    // This table's headers (16 columns, some long - "Actual Elev.", "FS
    // Taped", etc.) can wrap to a second line at a larger shared font before
    // a narrower column has room to keep them on one - reserve a whole extra
    // row's height so that (rare) wrap can never silently push a body row
    // onto a page that then gets deleted by the one-page safety net below.
    const rowH = rowHeightFor(style.fontSize, style.cellPadding);
    const maxRows = maxRowsFor(maxY - tableStartY - closureH - rowH, style.fontSize, style.cellPadding);
    const allRows = t.rows.filter(Boolean);
    const rowsToShow = allRows.slice(0, maxRows);

    doc.autoTable({
      head: [
        ["PT", "TP?", "FS", "BS", "HI", "Elev.", "Actual Elev.", "Adj. Elev.",
          "FS Taped", "FS Calc.", "FS Top", "FS Bot.",
          "BS Taped", "BS Calc.", "BS Top", "BS Bot."],
      ],
      body: rowsToShow.map((r) => [
        r.pointId + (r.isFirst ? (r.hasFsShot ? " (s/c)" : " (s)") : r.isClosingSetup ? " (final)" : r.isLast ? " (c)" : ""),
        r.isTurningPoint ? "Y" : "",
        fmt(r.fd.fs, 3),
        fmt(r.fd.bs, 3),
        fmt(r.fd.hi),
        fmt(r.fd.elevation),
        fmt(r.actualElev),
        fmt(r.fd.adjustedElev),
        fmt(r.fd.fsDistTaped, 1),
        fmt(r.fd.fsDistStadia, 1),
        fmt(r.fd.fsStadiaTop, 3),
        fmt(r.fd.fsStadiaBottom, 3),
        fmt(r.fd.bsDistTaped, 1),
        fmt(r.fd.bsDistStadia, 1),
        fmt(r.fd.bsStadiaTop, 3),
        fmt(r.fd.bsStadiaBottom, 3),
      ]),
      startY: tableStartY,
      margin: { left: x },
      tableWidth: w,
      styles: { fontSize: style.fontSize, cellPadding: style.cellPadding, overflow: "ellipsize" },
      headStyles: { fillColor: [138, 63, 160], textColor: 255 },
    });
    let ny = doc.lastAutoTable.finalY + 6;
    if (allRows.length > rowsToShow.length) {
      truncationNote(doc, x, ny, allRows.length - rowsToShow.length, w);
      ny += 8;
    }
    if (ny > maxY - 8) return ny;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(6.5);
    doc.setTextColor(90, 100, 110);
    const lines = doc.splitTextToSize(
      `Arithmetic check - Sum BS: ${raw(checks.sumBs)} ft   Sum FS: ${raw(checks.sumFs)} ft   Elev(last)-Elev(first): ${raw(checks.elevDiff)} ft`,
      w
    );
    doc.text(lines, x, ny);
    return ny + lines.length * 8;
  }

  async function generate(project) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "letter" });

    const scope = surveyScope(project.meta.surveyType);
    const hasTraverseData = project.connections.some((c) => c.type === "traverse");
    const hasLevelingData = project.connections.some((c) => c.type === "level");
    // Traverse and Leveling worksheets serve different survey types and both
    // needing to fit is the exception, not the rule - when a "General/Mixed"
    // project genuinely has both, traverse (the richer computation) wins the
    // single findings slot on this page.
    const showTraverse = scope === "traverse" || (scope === "all" && hasTraverseData);
    const showLeveling = !showTraverse && (scope === "leveling" || (scope === "all" && hasLevelingData));

    const contentTop = header(doc, project);
    const contentBottom = PAGE_H - 20;
    const contentW = PAGE_W - MARGIN * 2;
    const contentH = contentBottom - contentTop;
    const gap = 10;

    // Figure out how many rows Survey Data and Findings need, so the map's
    // height can be whatever's left over instead of a fixed ratio - a sparse
    // project (a handful of points) reads as a big, detailed map with
    // comfortably-sized tables below it, filling the page, rather than a
    // small fixed-ratio map stranded above a mostly-blank bottom half.
    const hasFindings = showTraverse || showLeveling;
    let findingsRowCount = 0;
    let findingsClosureH = 0;
    if (showTraverse) {
      const conns = project.connections.filter((c) => c.type === "traverse");
      findingsRowCount = conns.length ? Traverse.computeLegs(conns[0]).rows.filter(Boolean).length : 0;
      findingsClosureH = 18;
    } else if (showLeveling) {
      const conns = project.connections.filter((c) => c.type === "level");
      findingsRowCount = conns.length ? Leveling.computeRows(conns[0]).rows.filter(Boolean).length : 0;
      findingsClosureH = 10;
    }
    const dataRows = project.points.length;
    const dataExtra = 12; // title + bottom margin around the Survey Data table
    const findingsExtra = 10 + findingsClosureH + 8; // title/subtitle + closure text + bottom margin
    const gapsBelowMap = hasFindings ? gap * 2 : gap; // map->data, and (if present) data->findings

    // The map gets whatever's left after the tables take a comfortably-large
    // (but capped, so text never looks silly) font's worth of natural
    // height - clamped so it can't shrink away on a data-heavy report or
    // swallow the whole page on a sparse one.
    const minMapH = contentH * 0.28;
    const maxMapH = contentH * 0.62;
    const fontPickCeiling = contentH - minMapH - gapsBelowMap;
    const style = pickStyleToFill(fontPickCeiling, [
      { rows: dataRows, extra: dataExtra },
      ...(hasFindings ? [{ rows: findingsRowCount, extra: findingsExtra }] : []),
    ]);
    const rowH = rowHeightFor(style.fontSize, style.cellPadding);
    const naturalDataH = (dataRows + 1) * rowH + dataExtra;
    const naturalFindingsH = hasFindings ? (findingsRowCount + 1) * rowH + findingsExtra : 0;
    const belowMapNeeded = gapsBelowMap + naturalDataH + naturalFindingsH;
    const mapH = Math.round(Math.min(maxMapH, Math.max(minMapH, contentH - belowMapNeeded)));

    // Map across the top, at this banner's own (wide, short) aspect ratio so
    // it fills the space rather than being letterboxed.
    const scale = 2.2;
    const dataUrl = await planViewImage(project, Math.round(contentW * scale), Math.round(mapH * scale));
    doc.addImage(dataUrl, "PNG", MARGIN, contentTop, contentW, mapH);
    doc.setDrawColor(200, 206, 212);
    doc.rect(MARGIN, contentTop, contentW, mapH);

    // Survey Data, sized to what it actually needs (so a short table doesn't
    // leave a dead gap above Findings) but capped so a project with lots of
    // points still can't crowd Findings out entirely.
    const pairAvailable = contentH - mapH - gapsBelowMap;
    const dataTableTop = contentTop + mapH + gap;
    const dataTableCap = hasFindings ? Math.max(pairAvailable * 0.5, rowH * 3) : pairAvailable;
    const dataTableBudgetBottom = dataTableTop + Math.min(naturalDataH, dataTableCap);
    const dataTableBottom = drawDataTable(doc, project, MARGIN, dataTableTop, contentW, dataTableBudgetBottom, style);

    const findingsTop = Math.max(dataTableBottom, dataTableBudgetBottom) + gap;
    if (showTraverse) {
      drawTraverseFindings(doc, project, MARGIN, findingsTop, contentW, contentBottom, style);
    } else if (showLeveling) {
      drawLevelingFindings(doc, project, MARGIN, findingsTop, contentW, contentBottom, style);
    }

    footer(doc, project);

    // Belt-and-suspenders: if any row-budget estimate above still ran long
    // (autoTable's own row-height rounding, long text wrapping, etc.) and
    // jsPDF silently started a second page, drop it rather than ship a
    // report longer than the one page this layout promises.
    while (doc.internal.getNumberOfPages() > 1) {
      doc.deletePage(doc.internal.getNumberOfPages());
    }

    const safeName = (project.meta.title || "survey-report").replace(/[^a-z0-9\-_]+/gi, "_");
    doc.save(`${safeName}.pdf`);
  }

  return { generate };
})();

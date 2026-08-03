/* app.js
 * Wires the modules together: toolbar modes (add point / connect points),
 * modals (point editor, connection naming), tab switching, and project
 * meta fields. All actual data lives in State; this file only handles UI.
 */

(() => {
  let mode = "idle"; // 'idle' | 'add' | 'connect'
  let connectSelection = [];
  let editingPointId = null;
  let pendingPhotoDataUrl = null;
  // Set while the point modal is open for a brand-new point (map was clicked
  // in Add Point mode) - the point isn't written to State until Save, so
  // clicking Cancel leaves no half-created point behind and Save is a single
  // undoable action instead of "add" + "edit" stacking as two undo steps.
  let pendingNewLatLng = null;
  // Whether the point modal is currently open for what will be (or already
  // is) a leveling run's starting benchmark - decided once when the modal
  // opens (see isBenchmarkPoint) and read by refreshLevelingFieldVisibility.
  let modalIsBenchmark = false;

  const el = (id) => document.getElementById(id);

  function showToast(msg) {
    const toast = el("toast");
    toast.textContent = msg;
    toast.classList.remove("hidden");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.add("hidden"), 2400);
  }

  // ---------- Rendering ----------
  function activeTabName() {
    return document.querySelector(".tab-btn.active").dataset.tab;
  }

  function fullRender(project) {
    MapView.render(project);
    Table.render(project);
    el("btnUndo").disabled = !State.canUndo();
    const tab = activeTabName();
    if (tab === "traverse") Traverse.renderPanel(project);
    if (tab === "leveling") Leveling.renderPanel(project);
    if (tab === "planview") PlanView.render(el("planViewCanvas"), project);
  }

  function populateMetaInputs(project) {
    el("projectTitle").value = project.meta.title || "";
    el("teamName").value = project.meta.teamName || "";
    el("teamMembers").value = project.meta.teamMembers || "";
    el("projectDate").value = project.meta.date || "";
    el("coordSystem").value = project.meta.coordSystem || "EPSG:2263";
    el("projectSurveyType").value = project.meta.surveyType || "none";
  }

  // Like populateMetaInputs, but only touches inputs that aren't the one the
  // user is actively typing in and whose value actually changed - safe to run
  // on every state change (e.g. the startup modal or a JSON import changing
  // meta) without stomping on someone mid-keystroke in the header.
  function syncMetaInputsIfIdle(project) {
    const active = document.activeElement;
    [
      ["projectTitle", project.meta.title],
      ["teamName", project.meta.teamName],
      ["teamMembers", project.meta.teamMembers],
      ["projectDate", project.meta.date],
      ["coordSystem", project.meta.coordSystem || "EPSG:2263"],
      ["projectSurveyType", project.meta.surveyType || "none"],
    ].forEach(([id, val]) => {
      const input = el(id);
      const next = val || "";
      if (input !== active && input.value !== next) input.value = next;
    });
  }

  function isLevelingCategory(category) {
    return category === "levelingPoints" || category === "levelingLoop";
  }

  function isTraverseCategory(category) {
    return category === "traverseOpen" || category === "traverseClosed";
  }

  // A leveling run's very first station is the starting benchmark: it has no
  // incoming shot (nothing precedes it), only the outgoing Backsight that
  // establishes the first setup's HI - so it never shows a Foresight field.
  // Order is what determines this everywhere else in the app (see
  // syncOneAutoRun in state.js), so it's what determines it here too: for a
  // brand-new point (excludePointId omitted), it's the benchmark only if no
  // other leveling point exists yet; for a point being edited, it's the
  // benchmark only if it's the first leveling point by that same order.
  function isBenchmarkPoint(excludePointId) {
    const levelingPts = State.getProject().points.filter((p) => isLevelingCategory(p.surveyCategory));
    if (excludePointId) return levelingPts.length > 0 && levelingPts[0].id === excludePointId;
    return levelingPts.length === 0;
  }

  // ---------- Survey-type scoping ----------
  // The project's overall "Type of Survey" narrows the app down to just the
  // tools/fields relevant to that type: "General / Mixed" leaves everything
  // available, but picking a specific Leveling or Traverse type hides the
  // other type's tab and restricts new points' own Survey Type choices to
  // match (existing out-of-scope data is never hidden or lost, only the
  // *choices offered* are narrowed).
  function surveyScope(surveyType) {
    if (surveyType === "levelingPoints" || surveyType === "levelingLoop") return "leveling";
    if (surveyType === "traverseOpen" || surveyType === "traverseClosed") return "traverse";
    return "all";
  }

  function applyTabScope(scope) {
    const traverseTab = document.querySelector('.tab-btn[data-tab="traverse"]');
    const levelingTab = document.querySelector('.tab-btn[data-tab="leveling"]');
    traverseTab.classList.toggle("scope-hidden", scope === "leveling");
    levelingTab.classList.toggle("scope-hidden", scope === "traverse");
    const activeTab = document.querySelector(".tab-btn.active");
    if (activeTab && activeTab.classList.contains("scope-hidden")) {
      document.querySelector('.tab-btn[data-tab="notebook"]').click();
    }
  }

  function applySurveyScope(project) {
    applyTabScope(surveyScope(project.meta.surveyType));
  }

  // Rebuilds the point editor's Survey Type options to match the project's
  // scope, always keeping the point's own current value selectable even if
  // it falls outside that scope (e.g. project scope changed after the fact).
  function buildSurveyCategoryOptions(currentValue) {
    const scope = surveyScope(State.getProject().meta.surveyType);
    const select = el("pf_surveyCategory");
    select.innerHTML = Object.entries(State.SURVEY_CATEGORIES)
      .filter(([value]) => {
        if (value === "none" || value === currentValue || scope === "all") return true;
        if (scope === "leveling") return isLevelingCategory(value);
        if (scope === "traverse") return value === "traverseOpen" || value === "traverseClosed";
        return true;
      })
      .map(([value, label]) => `<option value="${value}">${label}</option>`)
      .join("");
    select.value = currentValue || "none";
  }

  // ---------- Mode handling ----------
  function setMode(next) {
    mode = mode === next ? "idle" : next;
    el("btnAddPoint").classList.toggle("tool-active", mode === "add");
    el("btnConnect").classList.toggle("tool-active", mode === "connect");
    el("btnFinishConnect").disabled = !(mode === "connect" && connectSelection.length >= 2);
    el("btnUndoConnect").disabled = !(mode === "connect" && connectSelection.length >= 1);

    const banner = el("modeBanner");
    if (mode === "add") {
      banner.textContent = "Click the map to add a survey point.";
      banner.classList.remove("hidden");
    } else if (mode === "connect") {
      banner.textContent = "Click points in order to connect them (click a point again to deselect it), then press Finish Line.";
      banner.classList.remove("hidden");
    } else {
      banner.classList.add("hidden");
      connectSelection = [];
      MapView.setSelectedIds([]);
    }

    // Rebuild markers now so popup suppression (and any selection change
    // above) takes effect immediately, not on the next unrelated state change.
    MapView.setSuppressPopups(mode === "connect");
    MapView.render(State.getProject());
  }

  function toggleConnectSelection(id) {
    const idx = connectSelection.indexOf(id);
    if (idx >= 0) connectSelection.splice(idx, 1);
    else connectSelection.push(id);
    MapView.setSelectedIds(connectSelection);
    MapView.render(State.getProject());
    el("btnFinishConnect").disabled = connectSelection.length < 2;
    el("btnUndoConnect").disabled = connectSelection.length < 1;
  }

  function undoLastConnectPoint() {
    connectSelection.pop();
    MapView.setSelectedIds(connectSelection);
    MapView.render(State.getProject());
    el("btnFinishConnect").disabled = connectSelection.length < 2;
    el("btnUndoConnect").disabled = connectSelection.length < 1;
  }

  // ---------- Point modal ----------
  // Shows/hides the leveling-only Foresight/Backsight blocks: FS is the
  // default (any regular point), BS only for the starting benchmark or a
  // point flagged as a turning point (checkbox or Feature Type dropdown).
  // In a CLOSED run, the benchmark also gets a closing Foresight once the
  // loop comes back around to it - only an open run's benchmark truly never
  // has one, since nothing ever closes back onto it.
  function refreshLevelingFieldVisibility(category) {
    if (!isLevelingCategory(category)) {
      el("pf_levelFsBlock").classList.add("hidden");
      el("pf_levelBsBlock").classList.add("hidden");
      return;
    }
    const isTurningPoint = el("pf_levelIsTurningPoint").checked;
    const isClosedSurvey = State.getProject().meta.surveyType === "levelingLoop";
    el("pf_levelFsBlock").classList.toggle("hidden", modalIsBenchmark && !isClosedSurvey);
    el("pf_levelBsBlock").classList.toggle("hidden", !modalIsBenchmark && !isTurningPoint);
    el("pf_levelBsHint").textContent = modalIsBenchmark ? "the starting known elevation" : "starting a new setup here";
    el("pf_levelFsHint").textContent = modalIsBenchmark ? "closing the loop back onto this point (fill in once you've walked the whole loop)" : "sighting this point from the current setup";
    el("pf_levelIsTurningPoint").closest("label").classList.toggle("hidden", modalIsBenchmark);
  }

  function populateLevelingFields(p) {
    const num = (v) => (v === null || v === undefined ? "" : v);
    el("pf_levelFs").value = num(p.fs);
    el("pf_levelFsStadiaTop").value = num(p.fsStadiaTop);
    el("pf_levelFsStadiaBottom").value = num(p.fsStadiaBottom);
    el("pf_levelFsDistTaped").value = num(p.fsDistTaped);
    el("pf_levelBs").value = num(p.bs);
    el("pf_levelBsStadiaTop").value = num(p.bsStadiaTop);
    el("pf_levelBsStadiaBottom").value = num(p.bsStadiaBottom);
    el("pf_levelBsDistTaped").value = num(p.bsDistTaped);
    el("pf_levelIsTurningPoint").checked = !!p.isTurningPoint;
  }

  function openPointModal(id) {
    const p = State.getPoint(id);
    if (!p) return;
    editingPointId = id;
    pendingNewLatLng = null;
    pendingPhotoDataUrl = null;
    modalIsBenchmark = isBenchmarkPoint(id);

    el("pointModalTitle").textContent = `Edit Survey Point ${p.id}`;
    el("pf_id").value = p.id;
    el("pf_date").value = p.dateCollected || "";
    el("pf_lat").value = p.lat.toFixed(6);
    el("pf_lng").value = p.lng.toFixed(6);
    el("pf_northing").value = p.northing.toFixed(2);
    el("pf_easting").value = p.easting.toFixed(2);
    el("pf_elevation").value = p.elevation === null || p.elevation === undefined ? "" : p.elevation;
    el("pf_featureType").value = p.featureType;
    buildSurveyCategoryOptions(p.surveyCategory || "none");
    populateLevelingFields(p);
    el("pf_fieldAngle").value = p.fieldAngle || "";
    el("pf_fieldBearing").value = p.fieldBearing || "";
    el("pf_fieldAzimuth").value = p.fieldAzimuth || "";
    el("pf_instrumentFieldsRow").classList.toggle("hidden", !isLevelingCategory(p.surveyCategory) && !isTraverseCategory(p.surveyCategory));
    refreshLevelingFieldVisibility(p.surveyCategory);
    el("pf_traverseReadingsRow").classList.toggle("hidden", !isTraverseCategory(p.surveyCategory));
    el("pf_adjustedNote").classList.toggle("hidden", !isTraverseCategory(p.surveyCategory));
    // Differential leveling doesn't use Northing/Easting - hide that row too.
    el("pf_coordRow").classList.toggle("hidden", isLevelingCategory(p.surveyCategory));
    el("pf_description").value = p.description || "";
    el("pf_notes").value = p.notes || "";
    el("pf_photo").value = "";
    if (p.photo) {
      el("pf_photoPreview").src = p.photo;
      el("pf_photoPreview").classList.remove("hidden");
    } else {
      el("pf_photoPreview").classList.add("hidden");
    }
    el("pf_deleteBtn").style.display = "inline-flex";
    el("pointModalOverlay").classList.remove("hidden");
  }

  // Opens the same modal for a point that hasn't been created yet - nothing
  // is written to State until the student clicks Save Point (see
  // handlePointFormSubmit), so Cancel truly cancels and Save is one single
  // undoable action.
  function openPointModalForNew(lat, lng) {
    editingPointId = null;
    pendingNewLatLng = { lat, lng };
    pendingPhotoDataUrl = null;
    modalIsBenchmark = isBenchmarkPoint();
    const ne = Coords.forward(lat, lng);
    const defaultCategory = State.getProject().meta.surveyType && State.getProject().meta.surveyType !== "none"
      ? State.getProject().meta.surveyType
      : "none";

    el("pointModalTitle").textContent = "Add Survey Point";
    el("pf_id").value = State.nextPointId();
    el("pf_date").value = new Date().toISOString().slice(0, 10);
    el("pf_lat").value = lat.toFixed(6);
    el("pf_lng").value = lng.toFixed(6);
    el("pf_northing").value = ne.northing.toFixed(2);
    el("pf_easting").value = ne.easting.toFixed(2);
    el("pf_elevation").value = "";
    // Feature Type describes what the point physically is, independent of
    // its survey role (benchmark/turning point) - it's never auto-set from
    // that role, so it stays exactly what the student picks.
    el("pf_featureType").value = "Other";
    buildSurveyCategoryOptions(defaultCategory);
    populateLevelingFields({});
    el("pf_fieldAngle").value = "";
    el("pf_fieldBearing").value = "";
    el("pf_fieldAzimuth").value = "";
    el("pf_instrumentFieldsRow").classList.toggle("hidden", !isLevelingCategory(defaultCategory) && !isTraverseCategory(defaultCategory));
    refreshLevelingFieldVisibility(defaultCategory);
    el("pf_traverseReadingsRow").classList.toggle("hidden", !isTraverseCategory(defaultCategory));
    el("pf_adjustedNote").classList.toggle("hidden", !isTraverseCategory(defaultCategory));
    el("pf_coordRow").classList.toggle("hidden", isLevelingCategory(defaultCategory));
    el("pf_description").value = "";
    el("pf_notes").value = "";
    el("pf_photo").value = "";
    el("pf_photoPreview").classList.add("hidden");
    el("pf_deleteBtn").style.display = "none";
    el("pointModalOverlay").classList.remove("hidden");
  }

  function closePointModal() {
    el("pointModalOverlay").classList.add("hidden");
    editingPointId = null;
    pendingNewLatLng = null;
    pendingPhotoDataUrl = null;
  }

  async function handlePointFormSubmit(e) {
    e.preventDefault();
    if (!editingPointId && !pendingNewLatLng) return;

    const newId = el("pf_id").value.trim();
    const clash = State.getProject().points.some((p) => p.id === newId && p.id !== editingPointId);
    if (clash) {
      alert(`Point ID "${newId}" is already used by another point.`);
      return;
    }

    const numOrNull = (v) => (v === "" ? null : parseFloat(v));
    const elevRaw = el("pf_elevation").value;
    const cat = el("pf_surveyCategory").value;
    const leveling = isLevelingCategory(cat);
    // Only Leveling has point-level instrument-reading quick-entry (split
    // into Foresight/Backsight shot blocks) - Traverse's BS/FS/HI/Corr./Adj.
    // are all entered later, in the Traverse Table, once the whole station
    // sequence is known. bsStadiaTop/etc. are forced null outside Leveling
    // rather than picked up stale from a previous category this point may
    // have had.
    const patch = {
      id: newId || editingPointId,
      dateCollected: el("pf_date").value,
      elevation: elevRaw === "" ? null : parseFloat(elevRaw),
      featureType: el("pf_featureType").value,
      // A survey role, not a feature - kept separate so checking this never
      // overwrites whatever the student picked for Feature Type.
      isTurningPoint: leveling ? el("pf_levelIsTurningPoint").checked : false,
      surveyCategory: cat,
      // Traverse has no point-level HI/BS/FS/Distance quick-entry anymore -
      // those, like Correction/Adjusted, are only ever entered in the
      // Traverse Table once the whole station sequence is known. Leveling's
      // HI is computed (Elevation + BS), not a raw reading, so it's the same
      // - table-only, never collected here.
      hi: null,
      bs: leveling ? numOrNull(el("pf_levelBs").value) : null,
      fs: leveling ? numOrNull(el("pf_levelFs").value) : null,
      dist: null,
      fieldAngle: el("pf_fieldAngle").value.trim() || null,
      fieldBearing: el("pf_fieldBearing").value.trim() || null,
      fieldAzimuth: el("pf_fieldAzimuth").value.trim() || null,
      bsStadiaTop: leveling ? numOrNull(el("pf_levelBsStadiaTop").value) : null,
      bsStadiaBottom: leveling ? numOrNull(el("pf_levelBsStadiaBottom").value) : null,
      bsDistTaped: leveling ? numOrNull(el("pf_levelBsDistTaped").value) : null,
      fsStadiaTop: leveling ? numOrNull(el("pf_levelFsStadiaTop").value) : null,
      fsStadiaBottom: leveling ? numOrNull(el("pf_levelFsStadiaBottom").value) : null,
      fsDistTaped: leveling ? numOrNull(el("pf_levelFsDistTaped").value) : null,
      description: el("pf_description").value.trim(),
      notes: el("pf_notes").value.trim(),
    };
    if (pendingPhotoDataUrl) patch.photo = pendingPhotoDataUrl;

    if (pendingNewLatLng) {
      // Nothing was written to State on map click - this is the one and only
      // mutation for "add a point", so it's a single step on the undo stack.
      const { lat, lng } = pendingNewLatLng;
      const p = State.addPoint(lat, lng, patch);
      closePointModal();
      showToast(`Added ${p.id}`);
    } else {
      State.updatePoint(editingPointId, patch);
      closePointModal();
      showToast(`Saved ${patch.id}`);
    }
  }

  // ---------- Connection modal ----------
  // Only "Survey Path" and "Boundary" are drawn here now - Traverse and
  // Differential Leveling runs are auto-built from points' own Survey Type
  // (see Traverse.renderPanel / Leveling.renderPanel), no manual line needed.
  function openConnectionModal() {
    if (connectSelection.length < 2) return;
    const typeSel = el("connectType").value;
    const label = State.CONNECTION_STYLES[typeSel].label;
    el("conn_name").value = "";
    el("conn_summary").textContent = `${label}: ${connectSelection.join(" → ")} (${connectSelection.length} points)`;
    el("connModalOverlay").classList.remove("hidden");
  }

  function closeConnectionModal() {
    el("connModalOverlay").classList.add("hidden");
  }

  function saveConnection() {
    const typeSel = el("connectType").value;
    const name = el("conn_name").value.trim();
    State.addConnection(typeSel, connectSelection, name);
    closeConnectionModal();
    connectSelection = [];
    MapView.setSelectedIds([]);
    setMode("idle");
    showToast("Line saved.");
  }

  // ---------- Tabs ----------
  function initTabs() {
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
        document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
        btn.classList.add("active");
        el("tab-" + btn.dataset.tab).classList.add("active");
        document.querySelector(".workspace").classList.toggle(
          "data-focus",
          btn.dataset.tab === "traverse" || btn.dataset.tab === "leveling"
        );
        // The map pane's width just changed via CSS; Leaflet caches its
        // container size and won't notice on its own, so tell it once the
        // resize transition finishes or tiles/clicks will be misaligned.
        setTimeout(() => MapView.getMap().invalidateSize(), 180);
        const project = State.getProject();
        if (btn.dataset.tab === "traverse") Traverse.renderPanel(project);
        if (btn.dataset.tab === "leveling") Leveling.renderPanel(project);
        if (btn.dataset.tab === "planview") {
          showToast("Loading map imagery...");
          PlanView.render(el("planViewCanvas"), project);
        }
      });
    });
  }

  // Opens a pre-filled email draft (student picks the recipient) - a static,
  // no-backend app can't attach the downloaded PDF automatically, so the
  // toast reminds them to do that by hand before sending.
  function openEmailDraft(project) {
    const subject = `Survey Report - ${project.meta.title || "Untitled Survey"}`;
    const body = [
      `Survey Report: ${project.meta.title || "Untitled Survey"}`,
      `Team: ${project.meta.teamName || ""}`,
      `Team Members: ${project.meta.teamMembers || ""}`,
      `Date: ${project.meta.date || ""}`,
      `Coordinate System: ${Coords.systemLabel()}`,
      "",
      `Points collected: ${project.points.length}`,
      `Connections: ${project.connections.length}`,
      "",
      "A PDF of this survey report was just downloaded to this computer. Browsers can't attach files to an email automatically, so please attach the downloaded PDF here before sending.",
    ].join("\n");
    window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  // ---------- Toolbar ----------
  function initToolbar() {
    el("btnUndo").addEventListener("click", () => {
      if (State.undo()) showToast("Undid last change.");
    });
    el("btnAddPoint").addEventListener("click", () => setMode("add"));
    el("btnConnect").addEventListener("click", () => setMode("connect"));
    el("btnFinishConnect").addEventListener("click", openConnectionModal);
    el("btnUndoConnect").addEventListener("click", undoLastConnectPoint);

    el("btnGrid").addEventListener("click", (e) => {
      const on = MapView.toggleGrid();
      e.target.classList.toggle("tool-active", on);
    });
    el("btnLegend").addEventListener("click", (e) => {
      MapView.toggleLegend();
      e.target.classList.toggle("tool-active");
    });

    el("btnExport").addEventListener("click", async () => {
      showToast("Building PDF report (fetching map imagery)...");
      try {
        await PdfExport.generate(State.getProject());
        showToast("Survey report exported.");
      } catch (err) {
        console.error(err);
        alert("Export failed: " + err.message);
      }
    });

    el("btnEmailReport").addEventListener("click", async () => {
      const project = State.getProject();
      showToast("Building PDF report (fetching map imagery)...");
      try {
        await PdfExport.generate(project);
      } catch (err) {
        console.error(err);
        alert("Export failed: " + err.message);
        return;
      }
      openEmailDraft(project);
      showToast("PDF downloaded — attach it to the email that just opened.");
    });

    el("btnSaveJson").addEventListener("click", () => {
      Storage.downloadJson(State.getProject());
      showToast("Project saved to file.");
    });

    el("loadJsonInput").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const data = await Storage.readJsonFile(file);
        // loadProject() synchronously emits "load", whose handler already
        // fits the map to the imported points - no need to do it again here.
        State.loadProject(data);
        showToast("Project loaded.");
      } catch (err) {
        alert("Could not read project file: " + err.message);
      }
      e.target.value = "";
    });

    el("btnClearAll").addEventListener("click", () => {
      if (confirm("Clear all survey points and connections? This cannot be undone.")) {
        State.clearAll();
        showToast("Project cleared.");
      }
    });
  }

  // ---------- Project meta ----------
  function initMetaFields() {
    el("projectTitle").addEventListener("change", (e) => State.setMeta({ title: e.target.value }));
    el("teamName").addEventListener("change", (e) => State.setMeta({ teamName: e.target.value }));
    el("teamMembers").addEventListener("change", (e) => State.setMeta({ teamMembers: e.target.value }));
    el("projectDate").addEventListener("change", (e) => State.setMeta({ date: e.target.value }));
    el("coordSystem").addEventListener("change", (e) => {
      State.setMeta({ coordSystem: e.target.value });
      showToast("Coordinates recalculated for " + Coords.systemLabel());
    });
    el("projectSurveyType").addEventListener("change", (e) => {
      State.setMeta({ surveyType: e.target.value });
      showToast("Scoped to " + (State.SURVEY_CATEGORIES[e.target.value] || "General / Mixed") + ".");
    });
  }

  // ---------- Modals ----------
  function initModals() {
    el("pointForm").addEventListener("submit", handlePointFormSubmit);
    el("pf_cancelBtn").addEventListener("click", closePointModal);
    el("pf_deleteBtn").addEventListener("click", () => {
      if (!editingPointId) return;
      if (confirm(`Delete point ${editingPointId}? This cannot be undone.`)) {
        State.deletePoint(editingPointId);
        closePointModal();
        showToast("Point deleted.");
      }
    });
    el("pointModalOverlay").addEventListener("click", (e) => {
      if (e.target === el("pointModalOverlay")) closePointModal();
    });
    el("pf_photo").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      pendingPhotoDataUrl = await Photo.processFile(file);
      el("pf_photoPreview").src = pendingPhotoDataUrl;
      el("pf_photoPreview").classList.remove("hidden");
    });
    el("pf_surveyCategory").addEventListener("change", (e) => {
      const cat = e.target.value;
      modalIsBenchmark = isBenchmarkPoint(editingPointId);
      el("pf_instrumentFieldsRow").classList.toggle("hidden", !isLevelingCategory(cat) && !isTraverseCategory(cat));
      refreshLevelingFieldVisibility(cat);
      el("pf_traverseReadingsRow").classList.toggle("hidden", !isTraverseCategory(cat));
      el("pf_adjustedNote").classList.toggle("hidden", !isTraverseCategory(cat));
      el("pf_coordRow").classList.toggle("hidden", isLevelingCategory(cat));
    });
    el("pf_levelIsTurningPoint").addEventListener("change", () => refreshLevelingFieldVisibility(el("pf_surveyCategory").value));

    el("conn_cancelBtn").addEventListener("click", closeConnectionModal);
    el("conn_saveBtn").addEventListener("click", saveConnection);
    el("connModalOverlay").addEventListener("click", (e) => {
      if (e.target === el("connModalOverlay")) closeConnectionModal();
    });
  }

  // ---------- Startup modal ----------
  function openStartupModal() {
    const project = State.getProject();
    el("su_teamName").value = project.meta.teamName || "";
    el("su_teamMembers").value = project.meta.teamMembers || "";
    el("su_title").value = project.meta.title || "";
    el("su_date").value = new Date().toISOString().slice(0, 10);
    el("su_surveyType").value = project.meta.surveyType || "";
    el("su_error").classList.add("hidden");
    el("startupModalOverlay").classList.remove("hidden");
  }

  function closeStartupModal() {
    el("startupModalOverlay").classList.add("hidden");
  }

  // Team Name, Team Members, and Type of Survey are all required before a
  // team can start collecting points - a returning team (within the 24h save
  // window, see storage.js) will find these already filled in from last
  // time, so this only demands real input the first time.
  function initStartupModal() {
    el("su_startBtn").addEventListener("click", () => {
      const teamName = el("su_teamName").value.trim();
      const teamMembers = el("su_teamMembers").value.trim();
      const surveyType = el("su_surveyType").value;

      const missing = [];
      if (!teamName) missing.push("Team Name");
      if (!teamMembers) missing.push("Team Members");
      if (!surveyType) missing.push("Type of Survey");

      if (missing.length) {
        const errEl = el("su_error");
        errEl.textContent = "Please fill in: " + missing.join(", ") + ".";
        errEl.classList.remove("hidden");
        return;
      }

      State.setMeta({
        teamName,
        teamMembers,
        title: el("su_title").value.trim() || "Untitled Survey",
        date: el("su_date").value,
        surveyType,
      });
      closeStartupModal();
      showToast("Survey set up — start adding points.");
    });
  }

  // ---------- Map events ----------
  function initMapEvents() {
    MapView.on("mapclick", (latlng) => {
      if (mode === "add") {
        openPointModalForNew(latlng.lat, latlng.lng);
      }
    });
    MapView.on("markerclick", (id) => {
      if (mode === "connect") toggleConnectSelection(id);
      // Leaflet markers don't bubble clicks to the map, so clicking exactly on
      // an existing marker while in Add Point mode would otherwise silently
      // do nothing (no new point, no feedback) - tell the student what happened.
      else if (mode === "add") showToast(`That's existing point ${id} — click elsewhere on the map to add a new one.`);
    });
    MapView.on("editrequest", (id) => openPointModal(id));
    Table.on("editRequest", (id) => openPointModal(id));
  }

  // ---------- Boot ----------
  document.addEventListener("DOMContentLoaded", () => {
    State.init();
    const project = State.getProject();

    MapView.init(project);
    Table.init();
    Traverse.init();
    Leveling.init();
    initTabs();
    initToolbar();
    initMetaFields();
    initModals();
    initStartupModal();
    initMapEvents();

    populateMetaInputs(project);
    applySurveyScope(project);
    fullRender(project);
    MapView.fitToPoints(project);
    openStartupModal();

    State.on("change", (p) => {
      syncMetaInputsIfIdle(p);
      applySurveyScope(p);
      fullRender(p);
    });
    State.on("load", (p) => {
      populateMetaInputs(p);
      applySurveyScope(p);
      fullRender(p);
      MapView.fitToPoints(p);
    });
  });
})();

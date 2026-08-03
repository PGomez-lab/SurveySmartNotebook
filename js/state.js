/* state.js
 * Single source of truth for the project: metadata, survey points, and connections
 * (survey paths / traverses / boundaries). Other modules subscribe to changes via
 * State.on(event, handler) and mutate only through the exported functions below,
 * so the map, table, traverse view, and leveling view always stay in sync.
 */

const State = (() => {
  const FEATURE_STYLES = {
    "Storm Drain": { color: "#1f5f8b", code: "SD" },
    "Sidewalk": { color: "#6b7785", code: "SW" },
    "Tree": { color: "#2c6e49", code: "TR" },
    "Light Pole": { color: "#c98a12", code: "LP" },
    "Building Corner": { color: "#a5342a", code: "BC" },
    "Utility Feature": { color: "#6a3fa0", code: "UF" },
    "Benchmark": { color: "#7a4419", code: "BM" },
    "Turning Point": { color: "#5a6672", code: "TP" },
    "Other": { color: "#3a3a3a", code: "OT" },
  };

  const CONNECTION_STYLES = {
    path: { color: "#1f5f8b", dashArray: "6,6", label: "Survey Path" },
    traverse: { color: "#c1272d", dashArray: null, label: "Traverse" },
    boundary: { color: "#2c6e49", dashArray: null, label: "Boundary" },
    level: { color: "#8a3fa0", dashArray: "2,5", label: "Differential Leveling Run" },
  };

  // Which survey campaign a point was collected for - set by the student when
  // adding/editing the point, independent of which connections it ends up in.
  const SURVEY_CATEGORIES = {
    none: "General Point",
    levelingPoints: "Differential Leveling — Points (open)",
    levelingLoop: "Differential Leveling — Loop (closed)",
    traverseOpen: "Traverse — Open",
    traverseClosed: "Traverse — Closed",
  };
  const LEVELING_CATEGORIES = ["levelingPoints", "levelingLoop"];
  const TRAVERSE_CATEGORIES = ["traverseOpen", "traverseClosed"];
  // Fixed IDs for the one auto-managed run per type - no manual "Connect
  // Points" step needed for Traverse/Leveling: just add points with the
  // matching Survey Type and these stay in sync automatically, in the order
  // the points were added.
  const AUTO_LEVEL_ID = "auto-level-run";
  const AUTO_TRAVERSE_ID = "auto-traverse-run";

  function todayIso() {
    const d = new Date();
    return d.toISOString().slice(0, 10);
  }

  function defaultProject() {
    return {
      meta: {
        title: "Fort Greene Park Smart Survey",
        teamName: "",
        teamMembers: "",
        date: todayIso(),
        surveyType: "",
        coordSystem: "EPSG:2263",
        originLat: 40.6915,
        originLng: -73.972,
      },
      points: [],
      connections: [],
    };
  }

  let project = defaultProject();
  const listeners = {};

  // Snapshot-based undo: covers structural changes (add/edit/delete a point
  // or connection, clear all, load project) - the "go back" a student needs
  // after a mistake. Per-cell worksheet edits (fieldData/checks, saved via
  // the silent path) are deliberately NOT snapshotted - those are corrected
  // in place like any spreadsheet cell, not undone one keystroke at a time.
  const UNDO_LIMIT = 30;
  let undoStack = [];

  function snapshotForUndo() {
    undoStack.push(JSON.parse(JSON.stringify(project)));
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  }

  function canUndo() {
    return undoStack.length > 0;
  }

  function undo() {
    if (!undoStack.length) return false;
    project = undoStack.pop();
    Coords.setMode(project.meta.coordSystem);
    Coords.setOrigin(project.meta.originLat, project.meta.originLng);
    // Cancel any pending debounced save from the edit just undone - it would
    // otherwise still fire later and write over this synchronous save (with
    // the same data, since it reads `project` live, but there's no reason to
    // leave a stale timer armed).
    clearTimeout(saveTimer);
    Storage.save(project);
    emit("load", project);
    return true;
  }

  function on(evt, fn) {
    (listeners[evt] = listeners[evt] || []).push(fn);
  }

  function emit(evt, payload) {
    (listeners[evt] || []).forEach((fn) => fn(payload));
  }

  // silent: true skips emitting "change" - used for per-cell worksheet edits
  // (traverse/leveling fieldData & checks) where the input already shows what
  // was just typed, so a full app re-render would only destroy and recreate
  // every input in the table, silently breaking keyboard Tab-to-next-field
  // navigation for the very tables meant for heavy sequential data entry.
  //
  // The localStorage write itself is debounced (not the in-memory `project`,
  // which is always current) - JSON.stringify-ing the whole project on every
  // single field commit is wasted work at Tab-through-a-table speed, and gets
  // expensive fast once a project has photos attached (their base64 data gets
  // re-serialized every time too, even though photos aren't what changed).
  // beforeunload flushes any pending write so a fast exit never drops it.
  const SAVE_DEBOUNCE_MS = 500;
  let saveTimer = null;
  function flushSave() {
    clearTimeout(saveTimer);
    saveTimer = null;
    Storage.save(project);
  }
  window.addEventListener("beforeunload", flushSave);

  function persist(opts = {}) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
    if (!opts.silent) emit("change", project);
  }

  function init() {
    const saved = Storage.load();
    if (saved && saved.points) {
      project = Object.assign(defaultProject(), saved);
      project.meta = Object.assign(defaultProject().meta, saved.meta || {});
    } else {
      // No save, or it expired (see storage.js's 24h window) - reset to a
      // clean slate rather than leaving whatever project was already in
      // memory, so init() is safe to re-run rather than only ever correct
      // the first time the page loads.
      project = defaultProject();
    }
    Coords.setMode(project.meta.coordSystem);
    Coords.setOrigin(project.meta.originLat, project.meta.originLng);
    emit("load", project);
  }

  function getProject() {
    return project;
  }

  function setMeta(patch) {
    snapshotForUndo();
    Object.assign(project.meta, patch);
    if (patch.coordSystem) {
      Coords.setMode(patch.coordSystem);
      // Recompute northing/easting for all existing points under the new system
      project.points.forEach((p) => {
        const ne = Coords.forward(p.lat, p.lng);
        p.northing = ne.northing;
        p.easting = ne.easting;
      });
    }
    if (patch.surveyType) syncAutoRuns();
    persist();
  }

  // Keeps the one auto-managed run of a given type in sync with whichever
  // points currently carry a matching Survey Type, in the order they appear
  // in project.points (i.e. the order they were added). Field data is keyed
  // by point ID (not position), so re-ordering/adding/removing points never
  // misaligns anyone else's readings.
  function syncOneAutoRun(connId, type, categories, surveyType) {
    const matching = project.points.filter((p) => categories.includes(p.surveyCategory)).map((p) => p.id);
    const existingIdx = project.connections.findIndex((c) => c.id === connId);
    if (matching.length < 2) {
      if (existingIdx >= 0) project.connections.splice(existingIdx, 1);
      return;
    }
    if (existingIdx >= 0) {
      const c = project.connections[existingIdx];
      c.pointIds = matching;
      c.surveyType = surveyType;
      if (!c.fieldData) c.fieldData = {};
      if (!c.checks) c.checks = {};
    } else {
      project.connections.push({
        id: connId,
        type,
        auto: true,
        pointIds: matching,
        name: type === "level" ? "Differential Leveling Run" : "Traverse",
        surveyType,
        angleType: type === "traverse" ? "interior" : undefined,
        fieldData: {},
        checks: {},
      });
    }
  }

  function syncAutoRuns() {
    syncOneAutoRun(AUTO_LEVEL_ID, "level", LEVELING_CATEGORIES, project.meta.surveyType === "levelingLoop" ? "closed" : "open");
    syncOneAutoRun(AUTO_TRAVERSE_ID, "traverse", TRAVERSE_CATEGORIES, project.meta.surveyType === "traverseClosed" ? "closed" : "open");
  }

  function nextPointId() {
    let n = project.points.length + 1;
    let id;
    const used = new Set(project.points.map((p) => p.id));
    do {
      id = "P" + String(n).padStart(3, "0");
      n++;
    } while (used.has(id));
    return id;
  }

  function addPoint(lat, lng, extra = {}) {
    snapshotForUndo();
    const ne = Coords.forward(lat, lng);
    const point = Object.assign(
      {
        id: nextPointId(),
        lat,
        lng,
        northing: ne.northing,
        easting: ne.easting,
        elevation: null,
        featureType: "Other",
        surveyCategory: project.meta.surveyType && project.meta.surveyType !== "none" ? project.meta.surveyType : "none",
        // Quick-entry instrument readings for this point - only relevant
        // when surveyCategory is a Leveling or Traverse type, but stored
        // regardless so switching category later doesn't lose data.
        // hi/bs/fs/dist ("Distance to Next Point") serve a Traverse station's
        // single instrument setup. The Corrected/Adjusted Angle/Bearing/
        // Azimuth are NOT recorded here - those depend on the whole
        // traverse's angular closure, so they're only ever entered later, in
        // the Traverse Table.
        hi: null,
        bs: null,
        fs: null,
        dist: null,
        fieldAngle: null,
        fieldBearing: null,
        fieldAzimuth: null,
        // Differential leveling only: with a single rod and instrument, a
        // turning point is sighted from two different setups - the incoming
        // foresight and the outgoing backsight each need their own distance
        // (stadia hairs + a taped measurement), not the one shared `dist`
        // above. bs/fs/hi are reused for the actual rod readings.
        bsStadiaTop: null,
        bsStadiaBottom: null,
        bsDistTaped: null,
        fsStadiaTop: null,
        fsStadiaBottom: null,
        fsDistTaped: null,
        // Whether this point is a leveling turning point (a new instrument
        // setup starts here) - a survey ROLE, kept separate from Feature
        // Type (what the point physically is: a nail in a sidewalk, a rock
        // outcropping, etc.) so checking one never overwrites the other.
        isTurningPoint: false,
        description: "",
        notes: "",
        photo: null,
        dateCollected: todayIso(),
      },
      extra
    );
    project.points.push(point);
    syncAutoRuns();
    persist();
    return point;
  }

  function updatePoint(id, patch) {
    const p = project.points.find((pt) => pt.id === id);
    if (!p) return null;
    snapshotForUndo();
    const oldId = p.id;
    Object.assign(p, patch);
    if (patch.lat !== undefined || patch.lng !== undefined) {
      const ne = Coords.forward(p.lat, p.lng);
      p.northing = ne.northing;
      p.easting = ne.easting;
    }
    if (patch.id && patch.id !== oldId) {
      project.connections.forEach((c) => {
        c.pointIds = c.pointIds.map((pid) => (pid === oldId ? patch.id : pid));
        if (c.fieldData && Object.prototype.hasOwnProperty.call(c.fieldData, oldId)) {
          c.fieldData[patch.id] = c.fieldData[oldId];
          delete c.fieldData[oldId];
        }
      });
    }
    syncAutoRuns();
    persist();
    return p;
  }

  function deletePoint(id) {
    snapshotForUndo();
    project.points = project.points.filter((p) => p.id !== id);
    project.connections.forEach((c) => {
      c.pointIds = c.pointIds.filter((pid) => pid !== id);
      if (c.fieldData) delete c.fieldData[id];
    });
    project.connections = project.connections.filter((c) => c.auto || c.pointIds.length >= 2);
    syncAutoRuns();
    persist();
  }

  function getPoint(id) {
    return project.points.find((p) => p.id === id) || null;
  }

  // Manual connections - only "path" and "boundary" are user-drawn now;
  // "traverse" and "level" runs are auto-managed (see syncAutoRuns) straight
  // from each point's own Survey Type, no separate connect step needed.
  function addConnection(type, pointIds, name) {
    snapshotForUndo();
    const conn = {
      id: "L" + (project.connections.length + 1) + "-" + Date.now().toString(36),
      type,
      pointIds: pointIds.slice(),
      name: name || CONNECTION_STYLES[type].label + " " + (project.connections.length + 1),
      fieldData: {},
    };
    project.connections.push(conn);
    persist();
    return conn;
  }

  function updateConnectionMeta(id, patch) {
    const c = project.connections.find((conn) => conn.id === id);
    if (!c) return null;
    snapshotForUndo();
    Object.assign(c, patch);
    persist();
    return c;
  }

  // patch keyed by point ID, e.g. updateFieldData(connId, "P003", {bs: 5.2}).
  function updateFieldData(connId, pointId, patch) {
    const c = project.connections.find((conn) => conn.id === connId);
    if (!c) return null;
    if (!c.fieldData) c.fieldData = {};
    c.fieldData[pointId] = Object.assign({}, c.fieldData[pointId] || {}, patch);
    persist({ silent: true });
    return c;
  }

  // Connection-level self-check values (e.g. a traverse's linear-closure/precision
  // check, or a level run's arithmetic check) - student-entered, not derived by index.
  function updateConnectionChecks(connId, patch) {
    const c = project.connections.find((conn) => conn.id === connId);
    if (!c) return null;
    if (!c.checks) c.checks = {};
    Object.assign(c.checks, patch);
    persist({ silent: true });
    return c;
  }

  function deleteConnection(id) {
    snapshotForUndo();
    project.connections = project.connections.filter((c) => c.id !== id);
    persist();
  }

  function clearAll() {
    snapshotForUndo();
    project = defaultProject();
    // Without this, a save debounced from just before Clear All was clicked
    // would still fire ~500ms later and write a fresh project back to
    // localStorage right after Storage.clear() removed it.
    clearTimeout(saveTimer);
    Storage.clear();
    Coords.setMode(project.meta.coordSystem);
    Coords.setOrigin(project.meta.originLat, project.meta.originLng);
    emit("load", project);
  }

  function loadProject(data) {
    snapshotForUndo();
    project = Object.assign(defaultProject(), data);
    project.meta = Object.assign(defaultProject().meta, data.meta || {});
    Coords.setMode(project.meta.coordSystem);
    Coords.setOrigin(project.meta.originLat, project.meta.originLng);
    syncAutoRuns();
    // silent: the "load" event below already triggers a full UI refresh
    // (plus fitting the map to the imported points) - emitting "change" too
    // would just render everything a second time for no reason.
    persist({ silent: true });
    emit("load", project);
  }

  return {
    FEATURE_STYLES,
    CONNECTION_STYLES,
    SURVEY_CATEGORIES,
    init,
    on,
    getProject,
    setMeta,
    addPoint,
    updatePoint,
    deletePoint,
    getPoint,
    addConnection,
    updateConnectionMeta,
    updateFieldData,
    updateConnectionChecks,
    deleteConnection,
    clearAll,
    loadProject,
    nextPointId,
    undo,
    canUndo,
  };
})();

/* table.js
 * Digital field notebook: renders the points array as an editable table.
 * Northing/Easting/Elevation/Description/Notes/Date/Feature Type can all be
 * edited in place; edits write straight back through State, which keeps the
 * map and every other view in sync.
 */

const Table = (() => {
  const listeners = {};
  function on(evt, fn) {
    (listeners[evt] = listeners[evt] || []).push(fn);
  }
  function emit(evt, payload) {
    (listeners[evt] || []).forEach((fn) => fn(payload));
  }

  let sortKey = null;
  let sortDir = 1;

  function init() {
    document.querySelectorAll("#notebookTable th[data-sort]").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        sortDir = sortKey === key ? -sortDir : 1;
        sortKey = key;
        render(State.getProject());
      });
    });

    const body = document.getElementById("notebookBody");

    body.addEventListener("change", (e) => {
      const td = e.target.closest("[data-id]");
      if (!td) return;
      const id = td.dataset.id;
      const field = td.dataset.field;
      if (field === "featureType") {
        State.updatePoint(id, { featureType: e.target.value });
      }
      if (field === "surveyCategory") {
        State.updatePoint(id, { surveyCategory: e.target.value });
      }
    });

    body.addEventListener("blur", (e) => {
      const td = e.target.closest("[data-field]");
      if (!td || !td.isContentEditable) return;
      const id = td.dataset.id;
      const field = td.dataset.field;
      const raw = td.textContent.trim();
      commitEdit(id, field, raw);
    }, true);

    body.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.isContentEditable) {
        e.preventDefault();
        e.target.blur();
      }
    });

    body.addEventListener("click", (e) => {
      const editBtn = e.target.closest("[data-action='edit']");
      const locateBtn = e.target.closest("[data-action='locate']");
      const delBtn = e.target.closest("[data-action='delete']");
      const photo = e.target.closest("[data-action='photo']");
      if (editBtn) emit("editRequest", editBtn.dataset.id);
      if (locateBtn) MapView.flyToPoint(locateBtn.dataset.id);
      if (photo) emit("editRequest", photo.dataset.id);
      if (delBtn) {
        if (confirm(`Delete point ${delBtn.dataset.id}? This cannot be undone.`)) {
          State.deletePoint(delBtn.dataset.id);
        }
      }
    });
  }

  function commitEdit(id, field, raw) {
    const point = State.getPoint(id);
    if (!point) return;

    if (field === "id") {
      if (!raw || raw === id) return render(State.getProject());
      const clash = State.getProject().points.some((p) => p.id === raw && p.id !== id);
      if (clash) {
        alert(`Point ID "${raw}" is already used.`);
        return render(State.getProject());
      }
      State.updatePoint(id, { id: raw });
      return;
    }

    if (field === "elevation") {
      const num = raw === "" ? null : parseFloat(raw);
      State.updatePoint(id, { elevation: Number.isNaN(num) ? null : num });
      return;
    }

    if (field === "northing" || field === "easting") {
      const num = parseFloat(raw);
      if (Number.isNaN(num)) return render(State.getProject());
      const nextN = field === "northing" ? num : point.northing;
      const nextE = field === "easting" ? num : point.easting;
      const ll = Coords.inverse(nextN, nextE);
      State.updatePoint(id, { lat: ll.lat, lng: ll.lng, northing: nextN, easting: nextE });
      return;
    }

    // description, notes, dateCollected: plain text fields
    State.updatePoint(id, { [field]: raw });
  }

  function sortedPoints(points) {
    if (!sortKey) return points;
    return [...points].sort((a, b) => {
      let av = a[sortKey], bv = b[sortKey];
      if (typeof av === "string") av = av.toLowerCase();
      if (typeof bv === "string") bv = bv.toLowerCase();
      if (av === null || av === undefined) av = "";
      if (bv === null || bv === undefined) bv = "";
      if (av < bv) return -1 * sortDir;
      if (av > bv) return 1 * sortDir;
      return 0;
    });
  }

  function featureOptions(selected) {
    return Object.keys(State.FEATURE_STYLES)
      .map((name) => `<option value="${name}" ${name === selected ? "selected" : ""}>${name}</option>`)
      .join("");
  }

  function surveyCategoryOptions(selected) {
    return Object.entries(State.SURVEY_CATEGORIES)
      .map(([value, label]) => `<option value="${value}" ${value === (selected || "none") ? "selected" : ""}>${label}</option>`)
      .join("");
  }

  function rowHtml(p) {
    const style = State.FEATURE_STYLES[p.featureType] || State.FEATURE_STYLES.Other;
    const elevText = p.elevation === null || p.elevation === undefined ? "" : p.elevation;
    const photoCell = p.photo
      ? `<img src="${p.photo}" class="thumb" data-action="photo" data-id="${p.id}" title="Click to edit" />`
      : `<span data-action="photo" data-id="${p.id}" style="cursor:pointer;color:#8a97a3;">&#128247; add</span>`;

    return `
      <tr>
        <td data-id="${p.id}" data-field="id" contenteditable="true">${p.id}</td>
        <td class="col-northing" data-id="${p.id}" data-field="northing" contenteditable="true">${p.northing.toFixed(2)}</td>
        <td class="col-easting" data-id="${p.id}" data-field="easting" contenteditable="true">${p.easting.toFixed(2)}</td>
        <td data-id="${p.id}" data-field="elevation" contenteditable="true">${elevText}</td>
        <td data-id="${p.id}" data-field="featureType">
          <span class="badge" style="background:${style.color}">${style.code}</span>
          <select data-id="${p.id}" data-field="featureType" style="margin-left:4px;">${featureOptions(p.featureType)}</select>
        </td>
        <td data-id="${p.id}" data-field="surveyCategory">
          <select data-id="${p.id}" data-field="surveyCategory">${surveyCategoryOptions(p.surveyCategory)}</select>
        </td>
        <td data-id="${p.id}" data-field="description" contenteditable="true">${p.description || ""}</td>
        <td data-id="${p.id}" data-field="dateCollected" contenteditable="true">${p.dateCollected || ""}</td>
        <td>${photoCell}</td>
        <td data-id="${p.id}" data-field="notes" contenteditable="true">${p.notes || ""}</td>
        <td class="row-actions">
          <button data-action="locate" data-id="${p.id}" title="Locate on map">&#128205;</button>
          <button data-action="edit" data-id="${p.id}" title="Full editor">&#9998;</button>
          <button data-action="delete" data-id="${p.id}" title="Delete">&#128465;</button>
        </td>
      </tr>
    `;
  }

  function render(project) {
    const body = document.getElementById("notebookBody");
    const hint = document.getElementById("notebookEmptyHint");
    const points = sortedPoints(project.points);
    body.innerHTML = points.map(rowHtml).join("");
    hint.style.display = points.length ? "none" : "block";

    // Differential leveling is a vertical-control survey - Northing/Easting
    // (and, in the Traverse tab, Latitude/Departure) aren't part of it, so
    // hide those columns here when the project is scoped to that survey type.
    const levelingScope = project.meta.surveyType === "levelingPoints" || project.meta.surveyType === "levelingLoop";
    document.getElementById("notebookTable").classList.toggle("hide-coords", levelingScope);
  }

  return { init, render, on };
})();

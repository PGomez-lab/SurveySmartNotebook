/* storage.js
 * Persists the project to localStorage so work survives a page reload,
 * plus JSON export/import for backing up or moving between computers.
 */

const Storage = (() => {
  const KEY = "smartSurveyNotebook.project.v1";
  // If a laptop dies or a student closes the tab mid-survey, they can reopen
  // this page later and pick up where they left off - but only within this
  // window, so stale data from a previous team/period doesn't linger forever.
  const MAX_AGE_MS = 24 * 60 * 60 * 1000;

  function save(project) {
    try {
      localStorage.setItem(KEY, JSON.stringify({ savedAt: Date.now(), project }));
    } catch (e) {
      console.warn("Auto-save failed (storage may be full):", e);
    }
  }

  function load() {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      // Wrapped format: { savedAt, project }. Anything saved more than 24h
      // ago is treated as expired - as if nothing had been saved at all.
      if (parsed && parsed.project && typeof parsed.savedAt === "number") {
        if (Date.now() - parsed.savedAt > MAX_AGE_MS) {
          localStorage.removeItem(KEY);
          return null;
        }
        return parsed.project;
      }
      // Pre-existing save from before the 24h-expiry format - honor it once
      // rather than silently discarding a team's in-progress work.
      return parsed;
    } catch (e) {
      console.warn("Could not parse saved project:", e);
      return null;
    }
  }

  function clear() {
    localStorage.removeItem(KEY);
  }

  function downloadJson(project) {
    const safeName = (project.meta.title || "survey-project").replace(/[^a-z0-9\-_]+/gi, "_");
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${safeName}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function readJsonFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          resolve(JSON.parse(reader.result));
        } catch (e) {
          reject(e);
        }
      };
      reader.onerror = reject;
      reader.readAsText(file);
    });
  }

  return { save, load, clear, downloadJson, readJsonFile };
})();

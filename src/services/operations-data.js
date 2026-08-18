(function initializeOperationsData(globalScope) {
  "use strict";

  function createOperationsDataService(cloud) {
    async function loadPhotosPage(options = {}) {
      return cloud.getPhotosPage(options);
    }

    async function loadAllPhotos({ pageSize = 100, maxPages = 100 } = {}) {
      const loaded = [];
      let after = null;
      for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
        const page = await cloud.getPhotosPage({ pageSize, after });
        loaded.push(...(page.photos || []));
        if (!page.hasMore || !page.after) break;
        after = page.after;
      }
      return [...new Map(loaded.map((photo) => [photo.id, photo])).values()];
    }

    async function loadAttendance({ pageSize = 500 } = {}) {
      return cloud.getAttendance({ pageSize });
    }

    async function loadDashboardSessions() {
      return cloud.getDashboardSessions();
    }

    return Object.freeze({
      loadAllPhotos,
      loadAttendance,
      loadDashboardSessions,
      loadPhotosPage,
    });
  }

  const api = Object.freeze({ createOperationsDataService });
  globalScope.StampNoteOperationsData = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

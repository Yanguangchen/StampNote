(function initializePhotoStore(globalScope) {
  "use strict";

  // Captures land here first and stay here. Nothing is uploaded: the record
  // keeps a "local" status so a later sync step has a queue to drain, and until
  // that exists the queue simply never drains.
  const DB_NAME = "stampnote";
  const STORE_NAME = "captures";
  const DB_VERSION = 1;

  // Roughly two hours at the 30-second cadence. Past that the oldest captures
  // are dropped rather than filling the device.
  const MAX_RECORDS = 240;
  const MAX_BYTES = 192 * 1024 * 1024;

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function buildFileName(date, poseDetected) {
    const stamp = [
      date.getFullYear(),
      pad(date.getMonth() + 1),
      pad(date.getDate()),
      "-",
      pad(date.getHours()),
      pad(date.getMinutes()),
      pad(date.getSeconds()),
    ].join("");

    return `stampnote-${stamp}${poseDetected ? "-pose" : ""}.jpg`;
  }

  function createId(date) {
    const random =
      typeof globalScope.crypto?.randomUUID === "function"
        ? globalScope.crypto.randomUUID().slice(0, 8)
        : Math.random().toString(36).slice(2, 10);

    return `${date.getTime()}-${random}`;
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;

    if (value < 1024) {
      return `${value} B`;
    }
    if (value < 1024 * 1024) {
      return `${Math.round(value / 1024)} KB`;
    }

    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  function createCaptureRecord(input = {}) {
    const date =
      input.date instanceof Date && !Number.isNaN(input.date.getTime()) ? input.date : new Date();
    const pose = input.pose || null;
    const poseDetected = Boolean(pose?.present);

    return {
      id: createId(date),
      capturedAt: date.toISOString(),
      capturedAtMs: date.getTime(),
      address: String(input.address || "").trim(),
      poseDetected,
      pose: poseDetected
        ? {
            confidence: Number(pose.confidence?.toFixed?.(3) ?? pose.confidence ?? 0),
            label: pose.pose || "unknown",
            // How many were in the frame, not just that somebody was.
            people: Math.max(1, Number(pose.people) || 1),
          }
        : null,
      intervalMs: Number(input.intervalMs) || null,
      // What the on-device triage made of the frame: how worth keeping it is,
      // how much detail it carried, and a fingerprint of the view. The score is
      // what decides which photographs go when the device runs out of room.
      score: typeof input.score === "number" ? Number(input.score.toFixed(3)) : null,
      sharpness: typeof input.sharpness === "number" ? Math.round(input.sharpness) : null,
      fingerprint: typeof input.fingerprint === "string" ? input.fingerprint : null,
      // Whether the schedule asked for this one or somebody did.
      trigger: input.trigger === "gesture" ? "gesture" : "schedule",
      bytes: Number(input.blob?.size) || 0,
      type: input.blob?.type || "image/jpeg",
      name: buildFileName(date, poseDetected),
      // Flipped by markSynced() once something has taken the photo elsewhere.
      status: "local",
      blob: input.blob || null,
    };
  }

  function byNewestFirst(left, right) {
    return (right.capturedAtMs || 0) - (left.capturedAtMs || 0);
  }

  // Worst first, until both budgets are satisfied — a blurred frame of an empty
  // room goes before a photograph of somebody, however much older that is.
  // Photographs with no score sort by age alone, so a store filled before the
  // triage existed sheds its oldest exactly as it always did.
  //
  // The newest capture is never dropped: one photo larger than the whole budget
  // should cost the store its history, not the photo just taken.
  function byExpendability(left, right) {
    const difference = (left.score ?? 0.5) - (right.score ?? 0.5);

    if (difference !== 0) {
      return difference;
    }

    return (left.capturedAtMs || 0) - (right.capturedAtMs || 0);
  }

  function selectExpired(records, limits = {}) {
    const maxRecords = limits.maxRecords ?? MAX_RECORDS;
    const maxBytes = limits.maxBytes ?? MAX_BYTES;
    const ordered = [...records].sort(byNewestFirst);

    if (ordered.length === 0) {
      return [];
    }

    const [newest, ...rest] = ordered;
    const expendable = [...rest].sort(byExpendability);
    const expired = new Set();

    let count = ordered.length;
    let bytes = ordered.reduce((total, record) => total + (record.bytes || 0), 0);

    expendable.forEach((record) => {
      if (count <= maxRecords && bytes <= maxBytes) {
        return;
      }

      expired.add(record.id);
      count -= 1;
      bytes -= record.bytes || 0;
    });

    // Never the newest, whatever it costs.
    expired.delete(newest.id);

    // Returned newest-first, the order the store has always handed them back
    // in. Which ones are chosen is what changed here, not how they are listed.
    return ordered.filter((record) => expired.has(record.id)).map((record) => record.id);
  }

  function summarize(records) {
    return {
      count: records.length,
      bytes: records.reduce((total, record) => total + (record.bytes || 0), 0),
      pending: records.filter((record) => record.status === "local").length,
      oldest: records.length > 0 ? records[records.length - 1].capturedAt : null,
    };
  }

  function promisifyRequest(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error || new Error("The local photo store rejected the request."));
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () =>
        reject(transaction.error || new Error("The local photo store aborted."));
      transaction.onerror = () =>
        reject(transaction.error || new Error("The local photo store failed."));
    });
  }

  function createIndexedDbBackend(factory) {
    let database = null;

    async function open() {
      if (database) {
        return database;
      }

      database = await new Promise((resolve, reject) => {
        const request = factory.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: "id" });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () =>
          reject(request.error || new Error("This browser refused the local photo store."));
        request.onblocked = () =>
          reject(new Error("Another tab is holding the local photo store open."));
      });

      return database;
    }

    async function write(action) {
      const db = await open();
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const result = action(transaction.objectStore(STORE_NAME));

      await transactionDone(transaction);
      return result;
    }

    return {
      persistent: true,
      ready: open,
      async getAll() {
        const db = await open();
        const transaction = db.transaction(STORE_NAME, "readonly");
        return promisifyRequest(transaction.objectStore(STORE_NAME).getAll());
      },
      put(record) {
        return write((store) => {
          store.put(record);
          return record;
        });
      },
      remove(id) {
        return write((store) => store.delete(id));
      },
      clear() {
        return write((store) => store.clear());
      },
    };
  }

  // Private browsing, an older WebView, or a storage quota refusal all end up
  // here: captures still work for the session, they just do not survive a reload.
  function createMemoryBackend() {
    const rows = new Map();

    return {
      persistent: false,
      async ready() {},
      async getAll() {
        return [...rows.values()];
      },
      async put(record) {
        rows.set(record.id, record);
        return record;
      },
      async remove(id) {
        rows.delete(id);
      },
      async clear() {
        rows.clear();
      },
    };
  }

  function createDefaultBackend(factory) {
    return factory && typeof factory.open === "function"
      ? createIndexedDbBackend(factory)
      : createMemoryBackend();
  }

  function createPhotoStore(options = {}) {
    const limits = {
      maxRecords: options.maxRecords ?? MAX_RECORDS,
      maxBytes: options.maxBytes ?? MAX_BYTES,
    };

    let backend =
      options.backend ||
      createDefaultBackend(options.indexedDb ?? globalScope.indexedDB);
    let opened = null;

    function ready() {
      if (!opened) {
        opened = backend.ready().catch(() => {
          // Losing the database is not worth losing the session over.
          backend = createMemoryBackend();
        });
      }

      return opened;
    }

    async function list() {
      await ready();
      const records = await backend.getAll();
      return records.sort(byNewestFirst);
    }

    return {
      ready,
      list,

      isPersistent() {
        return backend.persistent === true;
      },

      async save(input) {
        await ready();
        const record = createCaptureRecord(input);
        await backend.put(record);

        const expired = selectExpired(await backend.getAll(), limits);
        await Promise.all(expired.map((id) => backend.remove(id)));

        return record;
      },

      async listPending() {
        return (await list()).filter((record) => record.status === "local");
      },

      async markSynced(id) {
        await ready();
        const record = (await backend.getAll()).find((entry) => entry.id === id);

        if (!record) {
          return null;
        }

        const updated = { ...record, status: "synced", syncedAt: new Date().toISOString() };
        await backend.put(updated);
        return updated;
      },

      async remove(id) {
        await ready();
        return backend.remove(id);
      },

      async clear() {
        await ready();
        return backend.clear();
      },

      // Pass the records in when they have already been read, so the interface
      // does not pull every stored photo out of the database twice.
      async usage(records) {
        return summarize(records || (await list()));
      },
    };
  }

  const api = Object.freeze({
    DB_NAME,
    DB_VERSION,
    MAX_BYTES,
    MAX_RECORDS,
    STORE_NAME,
    buildFileName,
    byExpendability,
    createCaptureRecord,
    createIndexedDbBackend,
    createMemoryBackend,
    createPhotoStore,
    formatBytes,
    promisifyRequest,
    selectExpired,
    summarize,
  });

  globalScope.StampNoteStore = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);

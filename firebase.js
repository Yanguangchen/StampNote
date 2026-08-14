(function initializeStampNoteFirebase(globalScope) {
  "use strict";

  const SDK_BASE = "https://www.gstatic.com/firebasejs/12.17.1";
  const firebaseConfig = {
    apiKey: "AIzaSyArs5PDu31KE6wdV-o3Y16UpTdRkaj2JYw",
    authDomain: "stampnote-eedcd.firebaseapp.com",
    projectId: "stampnote-eedcd",
    storageBucket: "stampnote-eedcd.firebasestorage.app",
    messagingSenderId: "436163750873",
    appId: "1:436163750873:web:7a73d375be41975e2207c8",
    measurementId: "G-XG9MCLSZ6G",
  };

  function createFirebaseClient(options = {}) {
    const scope = options.globalScope || globalScope;
    const loadSdk = options.loadSdk || ((url) => import(url));
    let services = null;

    const ready = Promise.all([
      loadSdk(`${SDK_BASE}/firebase-app.js`),
      loadSdk(`${SDK_BASE}/firebase-auth.js`),
      loadSdk(`${SDK_BASE}/firebase-firestore.js`),
      loadSdk(`${SDK_BASE}/firebase-analytics.js`),
    ]).then(async ([appSdk, authSdk, firestoreSdk, analyticsSdk]) => {
      const app = appSdk.initializeApp(firebaseConfig);
      const auth = authSdk.getAuth(app);
      const db = firestoreSdk.getFirestore(app);
      const provider = new authSdk.GoogleAuthProvider();

      provider.setCustomParameters({ prompt: "select_account" });
      await authSdk.setPersistence(auth, authSdk.browserLocalPersistence);

      services = {
        app,
        auth,
        db,
        provider,
        authSdk,
        firestoreSdk,
      };

      // Analytics is optional. Auth and Firestore must remain usable if
      // a privacy setting or browser extension blocks its initialization.
      analyticsSdk
        .isSupported()
        .then((supported) => {
          if (supported) {
            analyticsSdk.getAnalytics(app);
          }
        })
        .catch(() => {});

      return services;
    });

    function requireCloudData() {
      if (!scope.StampNoteCloudData) {
        throw new Error("StampNote photo metadata helpers are unavailable.");
      }

      return scope.StampNoteCloudData;
    }

    function requireUser(cloud, message) {
      const user = cloud.auth.currentUser;
      if (!user) {
        throw Object.assign(new Error(message), { code: "auth-required" });
      }
      return user;
    }

    function normalizeFaceEmbedding(value) {
      const raw = ArrayBuffer.isView(value) ? Array.from(value) : value;
      if (
        !Array.isArray(raw) ||
        raw.length !== 128 ||
        !raw.every((entry) => Number.isFinite(entry) && Math.abs(entry) <= 10)
      ) {
        return null;
      }
      const numeric = raw.map(Number);
      const magnitude = Math.sqrt(numeric.reduce((total, entry) => total + entry ** 2, 0));
      return magnitude > 0 ? numeric.map((entry) => entry / magnitude) : numeric;
    }

    function averageFaceEmbeddings(values) {
      const valid = (values || []).map(normalizeFaceEmbedding).filter(Boolean);
      if (valid.length === 0) return null;
      const average = Array.from({ length: 128 }, (_, index) =>
        valid.reduce((total, sample) => total + sample[index], 0) / valid.length,
      );
      return normalizeFaceEmbedding(average);
    }

    function faceGallery(value) {
      if (Array.isArray(value?.embeddings)) return value.embeddings;
      if (value?.embeddings && typeof value.embeddings === "object") {
        return Object.keys(value.embeddings)
          .sort()
          .map((key) => value.embeddings[key]);
      }
      if (
        Array.isArray(value?.embeddingGallery) &&
        value.embeddingGallery.length > 0 &&
        value.embeddingGallery.length % 128 === 0
      ) {
        return Array.from(
          { length: Math.min(7, value.embeddingGallery.length / 128) },
          (_, index) => value.embeddingGallery.slice(index * 128, (index + 1) * 128),
        );
      }
      return [];
    }

    function workerRecord(value) {
      const workerId = String(value?.workerId || "").trim().toUpperCase();
      const displayName = String(value?.displayName || "").trim().replace(/\s+/g, " ");
      const embeddings = faceGallery(value)
        .map(normalizeFaceEmbedding)
        .filter(Boolean)
        .filter(
          (candidate, index, gallery) =>
            gallery.findIndex((saved) =>
              saved.every((entry, position) => Math.abs(entry - candidate[position]) < 0.000001),
            ) === index,
        )
        .slice(0, 7);
      const embedding =
        normalizeFaceEmbedding(value?.embedding) || averageFaceEmbeddings(embeddings);

      if (embedding && embeddings.length === 0) embeddings.push([...embedding]);

      if (!/^[A-Z0-9][A-Z0-9_-]{1,31}$/.test(workerId)) {
        throw new Error("Worker ID must be 2–32 letters, numbers, dashes, or underscores.");
      }
      if (!displayName || displayName.length > 60) {
        throw new Error("Worker name must be between 1 and 60 characters.");
      }
      if (!embedding) {
        throw new Error("The worker face template is incomplete.");
      }
      return { workerId, displayName, embedding, embeddings };
    }

    // A worker portrait is stored the same economical way a reviewed photo is:
    // a small JPEG held as Firestore bytes, so the project needs no paid
    // Storage bucket. The cap is deliberately tight — this is a face at badge
    // size, not a photograph.
    const PROFILE_PHOTO_MAX_BYTES = 120000;

    function decodeProfilePhoto(value) {
      const source = typeof value === "string" ? value.trim() : "";
      if (!source) return null;

      const match = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(source);
      if (!match) {
        throw new Error("The worker photo must be a JPEG or PNG data URL.");
      }

      const binary = scope.atob(match[2]);
      if (binary.length > PROFILE_PHOTO_MAX_BYTES) {
        throw new Error("The worker photo is too large to store.");
      }

      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return { bytes, contentType: `image/${match[1]}` };
    }

    function encodeProfilePhoto(value) {
      const bytes = value?.profilePhotoData?.toUint8Array?.();
      if (!bytes || bytes.length === 0) return null;

      let binary = "";
      for (let index = 0; index < bytes.length; index += 1) {
        binary += String.fromCharCode(bytes[index]);
      }
      return `data:${value.profilePhotoContentType || "image/jpeg"};base64,${scope.btoa(binary)}`;
    }

    function normalizeAttendanceDateKey(value) {
      const dateKey = String(value || "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
        throw new Error("Attendance needs a valid date.");
      }
      return dateKey;
    }

    function localAttendanceDateKey(value = Date.now()) {
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(date.getTime())) {
        throw new Error("Attendance needs a valid check-in time.");
      }
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    }

    function attendanceRecord(value, fallbackEventId = null) {
      const workerId = String(value?.workerId || "").trim().toUpperCase();
      const displayName = String(value?.displayName || value?.personLabel || "")
        .trim()
        .replace(/\s+/g, " ");
      const checkedInAtMs = Number(value?.checkedInAtMs);
      const eventId = String(value?.eventId || fallbackEventId || "").trim();
      const dateKey = normalizeAttendanceDateKey(
        value?.dateKey || localAttendanceDateKey(checkedInAtMs),
      );
      const timeZone = String(value?.timeZone || "").trim().slice(0, 80) || null;
      const location = String(value?.location || "").trim().replace(/\s+/g, " ").slice(0, 180) || null;

      if (!/^[A-Z0-9][A-Z0-9_-]{1,31}$/.test(workerId)) {
        throw new Error("Attendance has no valid worker ID.");
      }
      if (!displayName || displayName.length > 60) {
        throw new Error("Attendance has no valid worker name.");
      }
      if (!Number.isFinite(checkedInAtMs) || checkedInAtMs <= 0) {
        throw new Error("Attendance has no valid check-in time.");
      }
      if (!/^[A-Za-z0-9_-]{8,80}$/.test(eventId)) {
        throw new Error("Attendance has no valid event ID.");
      }

      return {
        eventId,
        workerId,
        displayName,
        checkedInAtMs,
        dateKey,
        timeZone,
        location,
        status: "present",
        source: "face-match",
      };
    }

    function dashboardSessionRecord(value, options = {}) {
      const data = requireCloudData();
      const location = data.normalizeLocation(value?.location);
      const locationKey = data.createLocationKey(location);
      const dateKey = String(value?.dateKey || "").trim();
      const sessionId = String(value?.sessionId || "").trim();
      const key = data.createSessionKey({ locationKey, dateKey, sessionId });
      const label = String(value?.label || "").trim().replace(/\s+/g, " ");
      const truckLocation = data.cleanTruckLocation(value?.truckLocation);

      if (options.requireLabel && (!label || label.length > 60)) {
        throw new Error("Session name must be between 1 and 60 characters.");
      }

      return { key, location, locationKey, dateKey, sessionId, label, truckLocation };
    }

    function isDashboardSessionRecord(value, session) {
      const data = requireCloudData();
      const locationKey = data.createLocationKey(value?.location);
      const atMs = Number(value?.checkedInAtMs || value?.capturedAtMs) ||
        Date.parse(value?.capturedAt) || 0;
      return (
        locationKey === session.locationKey &&
        data.sessionDefinitionFor(atMs).id === session.sessionId
      );
    }

    async function deleteReferences(cloud, references) {
      const chunkSize = 450;
      for (let start = 0; start < references.length; start += chunkSize) {
        const batch = cloud.firestoreSdk.writeBatch(cloud.db);
        references
          .slice(start, start + chunkSize)
          .forEach((reference) => batch.delete(reference));
        await batch.commit();
      }
    }

  async function signIn() {
    const cloud = await ready;

    try {
      return await cloud.authSdk.signInWithPopup(cloud.auth, cloud.provider);
    } catch (error) {
      // A real browser gesture opened the flow, so popup is the least fragile
      // cross-device default. Redirect is a safe fallback when it is blocked.
      if (error?.code === "auth/popup-blocked") {
        await cloud.authSdk.signInWithRedirect(cloud.auth, cloud.provider);
        return null;
      }
      throw error;
    }
  }

  async function signOut() {
    const cloud = await ready;
    await cloud.authSdk.signOut(cloud.auth);
  }

  async function saveWorkerFace(input) {
    const cloud = services || (await ready);
    const user = requireUser(cloud, "Sign in with Google before enrolling a worker.");
    const worker = workerRecord(input);
    const { embeddings, ...documentWorker } = worker;
    const portrait = decodeProfilePhoto(input?.profilePhoto);
    const reference = cloud.firestoreSdk.doc(
      cloud.db,
      "workers",
      worker.workerId,
    );

    await cloud.firestoreSdk.setDoc(
      reference,
      {
        ...documentWorker,
        // Firestore rejects an array whose elements are themselves arrays.
        // Persist the gallery as one flat numeric array, then rebuild its
        // 128-value views in workerRecord when the roster is loaded.
        embeddingGallery: embeddings.flat(),
        embeddingCount: embeddings.length,
        embeddingDimensions: 128,
        ownerId: user.uid,
        templateType: "face-api-128-flat-gallery",
        schemaVersion: 3,
        consentVersion: "worker-face-v1",
        sampleCount: Math.max(1, Math.min(12, Math.floor(Number(input?.sampleCount) || 7))),
        enrolledAt: cloud.firestoreSdk.serverTimestamp(),
        updatedAt: cloud.firestoreSdk.serverTimestamp(),
        // A re-enrollment without a fresh portrait keeps the one already there.
        ...(portrait
          ? {
              profilePhotoData: cloud.firestoreSdk.Bytes.fromUint8Array(portrait.bytes),
              profilePhotoContentType: portrait.contentType,
              profilePhotoBytes: portrait.bytes.length,
            }
          : {}),
      },
      { merge: true },
    );
    return {
      ...worker,
      profilePhoto: portrait ? String(input.profilePhoto).trim() : null,
    };
  }

  async function getWorkerFaces() {
    const cloud = services || (await ready);
    const user = requireUser(cloud, "Sign in with Google to load enrolled workers.");
    const reference = cloud.firestoreSdk.collection(cloud.db, "workers");
    const snapshot = await cloud.firestoreSdk.getDocs(reference);

    return snapshot.docs
      .map((entry) => {
        try {
          const data = entry.data();
          return {
            documentId: entry.id,
            ...workerRecord(data),
            profilePhoto: encodeProfilePhoto(data),
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((left, right) => left.workerId.localeCompare(right.workerId));
  }

  async function deleteWorkerFace(workerId) {
    const cloud = services || (await ready);
    const user = requireUser(cloud, "Sign in with Google before deleting an enrollment.");
    const normalized = String(workerId || "").trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_-]{1,31}$/.test(normalized)) {
      throw new Error("The worker enrollment has no valid ID.");
    }
    await cloud.firestoreSdk.deleteDoc(
      cloud.firestoreSdk.doc(cloud.db, "workers", normalized),
    );
  }

  async function saveAttendance(input) {
    const cloud = services || (await ready);
    const user = requireUser(cloud, "Sign in with Google before recording attendance.");
    const fallbackEventId =
      typeof scope.crypto?.randomUUID === "function"
        ? scope.crypto.randomUUID().replace(/-/g, "")
        : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
    const attendance = attendanceRecord(input, fallbackEventId);
    const reference = cloud.firestoreSdk.doc(
      cloud.db,
      "attendanceDays",
      attendance.dateKey,
      "entries",
      attendance.eventId,
    );

    await cloud.firestoreSdk.setDoc(
      reference,
      {
        ...attendance,
        recordedBy: user.uid,
        checkedInAt: cloud.firestoreSdk.serverTimestamp(),
        updatedAt: cloud.firestoreSdk.serverTimestamp(),
      },
      { merge: true },
    );
    return attendance;
  }

  async function getAttendance(options = {}) {
    const cloud = services || (await ready);
    requireUser(cloud, "Sign in with Google to view attendance.");
    const requestedSize = Math.floor(Number(options.pageSize) || 500);
    const pageSize = Math.min(500, Math.max(1, requestedSize));
    const entries = options.dateKey
      ? cloud.firestoreSdk.collection(
          cloud.db,
          "attendanceDays",
          normalizeAttendanceDateKey(options.dateKey),
          "entries",
        )
      : cloud.firestoreSdk.collectionGroup(cloud.db, "entries");
    const snapshot = await cloud.firestoreSdk.getDocs(
      cloud.firestoreSdk.query(
        entries,
        cloud.firestoreSdk.orderBy("checkedInAtMs", "desc"),
        cloud.firestoreSdk.limit(pageSize),
      ),
    );

    return snapshot.docs
      .map((entry) => {
        try {
          return attendanceRecord(entry.data(), entry.id);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  async function getDashboardSessions() {
    const cloud = services || (await ready);
    requireUser(cloud, "Sign in with Google to load dashboard sessions.");
    const reference = cloud.firestoreSdk.collection(cloud.db, "dashboardSessions");
    const snapshot = await cloud.firestoreSdk.getDocs(reference);

    return snapshot.docs
      .map((entry) => {
        try {
          const session = dashboardSessionRecord(entry.data());
          return entry.id === session.key ? session : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  const getSessionLabels = getDashboardSessions;

  async function renameSession(input) {
    const cloud = services || (await ready);
    const user = requireUser(cloud, "Sign in with Google before renaming a session.");
    const session = dashboardSessionRecord(input, { requireLabel: true });
    const reference = cloud.firestoreSdk.doc(cloud.db, "dashboardSessions", session.key);

    await cloud.firestoreSdk.setDoc(
      reference,
      {
        location: session.location,
        locationKey: session.locationKey,
        dateKey: session.dateKey,
        sessionId: session.sessionId,
        label: session.label,
        renamedBy: user.uid,
        updatedAt: cloud.firestoreSdk.serverTimestamp(),
      },
      { merge: true },
    );
    return session;
  }

  async function deleteSession(input) {
    const cloud = services || (await ready);
    const user = requireUser(cloud, "Sign in with Google before deleting a session.");
    const session = dashboardSessionRecord(input);
    const attendanceCollection = cloud.firestoreSdk.collection(
      cloud.db,
      "attendanceDays",
      session.dateKey,
      "entries",
    );
    const photoCollection = cloud.firestoreSdk.collection(
      cloud.db,
      "users",
      user.uid,
      "photos",
    );
    const photosForDate = session.dateKey === "unknown-date"
      ? photoCollection
      : cloud.firestoreSdk.query(
          photoCollection,
          cloud.firestoreSdk.where("dateKey", "==", session.dateKey),
        );
    const [attendanceSnapshot, photoSnapshot] = await Promise.all([
      cloud.firestoreSdk.getDocs(attendanceCollection),
      cloud.firestoreSdk.getDocs(photosForDate),
    ]);
    const attendanceDocuments = attendanceSnapshot.docs.filter((entry) =>
      isDashboardSessionRecord(entry.data(), session),
    );
    const photoDocuments = photoSnapshot.docs.filter((entry) =>
      isDashboardSessionRecord(entry.data(), session),
    );
    const attendanceEventIds = attendanceDocuments.map((entry) => entry.id);
    const photoIds = photoDocuments.map((entry) => String(entry.data()?.id || entry.id));
    const references = [
      ...attendanceDocuments.map((entry) =>
        cloud.firestoreSdk.doc(
          cloud.db,
          "attendanceDays",
          session.dateKey,
          "entries",
          entry.id,
        ),
      ),
      ...photoDocuments.map((entry) =>
        cloud.firestoreSdk.doc(cloud.db, "users", user.uid, "photos", entry.id),
      ),
      cloud.firestoreSdk.doc(cloud.db, "dashboardSessions", session.key),
    ];

    await deleteReferences(cloud, references);
    return {
      attendanceDeleted: attendanceDocuments.length,
      attendanceEventIds,
      photoDeleted: photoDocuments.length,
      photoIds,
    };
  }

  function subscribeAuth(callback) {
    let unsubscribe = null;
    let cancelled = false;

    ready
      .then((cloud) => {
        if (cancelled) {
          return;
        }
        unsubscribe = cloud.authSdk.onAuthStateChanged(
          cloud.auth,
          (user) => callback(user, null),
          (error) => callback(null, error),
        );
      })
      .catch((error) => {
        if (!cancelled) {
          callback(null, error);
        }
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }

    function loadBlobImage(blob) {
      return new Promise((resolve, reject) => {
        const url = scope.URL.createObjectURL(blob);
        const image = new scope.Image();

        image.addEventListener("load", () => resolve({ image, url }), { once: true });
        image.addEventListener(
          "error",
          () => {
            scope.URL.revokeObjectURL(url);
            reject(new Error("The photo could not be prepared for Firestore."));
          },
          { once: true },
        );
        image.src = url;
      });
    }

  function canvasBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error("The Firestore photo could not be encoded."));
          }
        },
        "image/jpeg",
        0.72,
      );
    });
  }

  // Firestore documents top out at 1 MiB. This is the same economical 512 px
  // representation Gemini reviewed, leaving ample room for metadata and the
  // base document overhead without requiring a paid Storage bucket.
  async function createFirestoreImage(blob, firestoreSdk) {
    const loaded = await loadBlobImage(blob);

    try {
      const maxEdge = 512;
      const scale = Math.min(
        1,
        maxEdge / Math.max(loaded.image.naturalWidth, loaded.image.naturalHeight),
      );
      const canvas = scope.document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(loaded.image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(loaded.image.naturalHeight * scale));
      canvas.getContext("2d").drawImage(loaded.image, 0, 0, canvas.width, canvas.height);
      const encoded = await canvasBlob(canvas);
      const bytes = new Uint8Array(await encoded.arrayBuffer());

      return {
        imageData: firestoreSdk.Bytes.fromUint8Array(bytes),
        imageContentType: "image/jpeg",
        imageBytes: bytes.byteLength,
        imageWidth: canvas.width,
        imageHeight: canvas.height,
      };
    } finally {
      scope.URL.revokeObjectURL(loaded.url);
    }
  }

  async function uploadReviewedPhoto(record) {
    const cloud = services || (await ready);
    const user = cloud.auth.currentUser;

    if (!user) {
      throw Object.assign(new Error("Sign in with Google before uploading photos."), {
        code: "auth-required",
      });
    }
    if (!record?.blob || !record?.aiReview) {
      throw new Error("Only complete Gemini-reviewed photos can be uploaded.");
    }

    const data = requireCloudData();
    const metadata = data.createPhotoMetadata(record, user.uid);
    const image = await createFirestoreImage(record.blob, cloud.firestoreSdk);

    const documentReference = cloud.firestoreSdk.doc(
      cloud.db,
      "users",
      user.uid,
      "photos",
      metadata.id,
    );
    await cloud.firestoreSdk.setDoc(
      documentReference,
      {
        ...metadata,
        ...image,
        uploadedAt: cloud.firestoreSdk.serverTimestamp(),
        updatedAt: cloud.firestoreSdk.serverTimestamp(),
      },
      { merge: true },
    );

    return metadata;
  }

  async function updateSessionTruckLocation(sessionInput, input) {
    const cloud = services || (await ready);
    const user = requireUser(cloud, "Sign in with Google before editing the truck location.");
    const data = requireCloudData();
    const session = dashboardSessionRecord(sessionInput);
    const truckLocation = data.cleanTruckLocation(input);
    for (const axis of ["x", "y"]) {
      const raw = input?.[axis];
      if (raw !== undefined && raw !== null && raw !== "" && truckLocation[axis] === null) {
        throw new Error(
          axis === "x"
            ? "Truck location X must be a longitude between -180 and 180."
            : "Truck location Y must be a latitude between -90 and 90.",
        );
      }
    }
    if ((truckLocation.x === null) !== (truckLocation.y === null)) {
      throw new Error("Enter both truck location coordinates, or clear both.");
    }

    const documentReference = cloud.firestoreSdk.doc(
      cloud.db,
      "dashboardSessions",
      session.key,
    );
    await cloud.firestoreSdk.setDoc(
      documentReference,
      {
        location: session.location,
        locationKey: session.locationKey,
        dateKey: session.dateKey,
        sessionId: session.sessionId,
        truckLocation,
        truckLocationUpdatedBy: user.uid,
        truckLocationUpdatedAt: cloud.firestoreSdk.serverTimestamp(),
        updatedAt: cloud.firestoreSdk.serverTimestamp(),
      },
      { merge: true },
    );

    return { ...session, truckLocation };
  }

  async function getPhotosPage(options = {}) {
    const cloud = services || (await ready);
    const user = cloud.auth.currentUser;

    if (!user) {
      throw Object.assign(new Error("Sign in with Google to browse cloud photos."), {
        code: "auth-required",
      });
    }

    const requestedSize = Math.floor(Number(options.pageSize) || 48);
    const pageSize = Math.min(100, Math.max(1, requestedSize));
    const clauses = [
      cloud.firestoreSdk.orderBy("capturedAtMs", "desc"),
      cloud.firestoreSdk.limit(pageSize),
    ];

    if (options.after) {
      clauses.splice(1, 0, cloud.firestoreSdk.startAfter(options.after));
    }

    const photos = cloud.firestoreSdk.collection(cloud.db, "users", user.uid, "photos");
    const snapshot = await cloud.firestoreSdk.getDocs(
      cloud.firestoreSdk.query(photos, ...clauses),
    );

    return {
      photos: snapshot.docs.map((entry) => ({ documentId: entry.id, ...entry.data() })),
      after: snapshot.docs.at(-1) || null,
      hasMore: snapshot.size === pageSize,
    };
  }

  async function deleteReviewedPhoto(record) {
    const cloud = services || (await ready);
    const user = cloud.auth.currentUser;

    if (!user) {
      throw Object.assign(new Error("Sign in with Google before deleting cloud photos."), {
        code: "auth-required",
      });
    }

    const photoId = String(record?.id || "");
    if (!photoId) {
      throw new Error("The cloud photo has no ID.");
    }

    await cloud.firestoreSdk.deleteDoc(
      cloud.firestoreSdk.doc(cloud.db, "users", user.uid, "photos", photoId),
    );
  }

  async function getPhotoBlob(photo) {
    const cloud = services || (await ready);

    if (!cloud.auth.currentUser) {
      throw Object.assign(new Error("Sign in with Google to open cloud photos."), {
        code: "auth-required",
      });
    }

    const bytes = photo?.imageData?.toUint8Array?.();
    if (!bytes) {
      throw new Error("This Firestore photo has no image data.");
    }

    return new scope.Blob([bytes], { type: photo.imageContentType || "image/jpeg" });
  }

    return Object.freeze({
      ready,
      deleteWorkerFace,
      deleteSession,
      getAttendance,
      getDashboardSessions,
      getSessionLabels,
      signIn,
      signOut,
      subscribeAuth,
      getWorkerFaces,
      saveAttendance,
      saveWorkerFace,
      renameSession,
      uploadReviewedPhoto,
      updateSessionTruckLocation,
      deleteReviewedPhoto,
      getPhotosPage,
      getPhotoBlob,
    });
  }

  const testApi = Object.freeze({ SDK_BASE, firebaseConfig, createFirebaseClient });

  if (typeof module !== "undefined" && module.exports) {
    module.exports = testApi;
  }

  if (globalScope?.document) {
    globalScope.StampNoteFirebase = createFirebaseClient();
  }
})(typeof window !== "undefined" ? window : globalThis);

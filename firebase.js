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
      },
      { merge: true },
    );
    return worker;
  }

  async function getWorkerFaces() {
    const cloud = services || (await ready);
    const user = requireUser(cloud, "Sign in with Google to load enrolled workers.");
    const reference = cloud.firestoreSdk.collection(cloud.db, "workers");
    const snapshot = await cloud.firestoreSdk.getDocs(reference);

    return snapshot.docs
      .map((entry) => {
        try {
          return { documentId: entry.id, ...workerRecord(entry.data()) };
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
      signIn,
      signOut,
      subscribeAuth,
      getWorkerFaces,
      saveWorkerFace,
      uploadReviewedPhoto,
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

(function initializeAiDashboardWorkspace(globalScope) {
  "use strict";

  const assistant = globalScope.StampNoteAiDashboard;
  if (!assistant) return;

  const {
    buildKnowledgeBase,
    createAssistantPayload,
    comparisonMapGeometry,
    coordinateQuery,
    describeAssistantError,
    externalGeographyDisclosure,
    gpsAccuracyMarginSuggestion,
    inlineMapForQuestion,
    metricChartsForQuestion,
    navigationActions,
    photoFlagsMentionedInAnswer,
    renderAnswer,
    resolveAssistantEndpoint,
  } = assistant;

  const document = globalScope.document;
  if (!document?.querySelector("#ai-chat-form")) return;

  const cloud = globalScope.StampNoteFirebase;
  const data = globalScope.StampNoteCloudData;
  const coordinates = globalScope.StampNoteCoordinates;
  const metricsApi = globalScope.StampNoteMetrics;
  const telemetry = globalScope.StampNoteObservability;
  const operationsData = globalScope.StampNoteOperationsData?.createOperationsDataService(cloud);
  const signInButton = document.querySelector("#ai-sign-in");
  const signOutButton = document.querySelector("#ai-sign-out");
  const authGate = document.querySelector("#ai-auth-gate");
  const workspace = document.querySelector("#ai-workspace");
  const accountName = document.querySelector("#ai-account-name");
  const status = document.querySelector("#ai-dashboard-status");
  const scopeLabel = document.querySelector("#ai-scope-label");
  const refreshButton = document.querySelector("#ai-refresh");
  const messageList = document.querySelector("#ai-message-list");
  const form = document.querySelector("#ai-chat-form");
  const prompt = document.querySelector("#ai-prompt");
  const sendButton = document.querySelector("#ai-send");
  const micButton = document.querySelector("#ai-mic");
  const voiceStatus = document.querySelector("#ai-voice-status");
  const themeToggle = document.querySelector("#theme-toggle");
  const themeIcon = document.querySelector("#theme-toggle-icon");
  const themeLabel = document.querySelector("#theme-toggle-label");
  const assistantEndpoint = resolveAssistantEndpoint(globalScope.location);
  const speechEndpoint = assistantEndpoint.replace(/\/assistant$/, "/speech");
  const SpeechAudioContext = globalScope.AudioContext || globalScope.webkitAudioContext;

  telemetry?.configure({ surface: "ai-dashboard" });

  let signedInUser = null;
  let knowledge = null;
  let loading = false;
  let asking = false;
  let recognition = null;
  let currentSpeech = null;
  const history = [];

  function setStatus(message, state = "idle") {
    status.textContent = message;
    status.dataset.state = state;
    status.hidden = !message;
  }

  function setBusy() {
    const disabled = loading || asking || !knowledge;
    sendButton.disabled = disabled || !prompt.value.trim();
    refreshButton.disabled = loading || asking;
    micButton.disabled = asking || !recognition;
    document.querySelectorAll("[data-ai-question]").forEach((button) => {
      button.disabled = disabled;
    });
    form.setAttribute("aria-busy", String(asking));
  }

  function metricValue(id, value) {
    const element = document.querySelector(id);
    if (element) element.textContent = String(value);
  }

  function renderMetrics(metrics) {
    metricValue("#ai-metric-sessions", metrics.sessionCount);
    metricValue("#ai-metric-flags", metrics.flaggedSessionCount);
    metricValue("#ai-metric-weather", metrics.weatherIssueCount);
    metricValue("#ai-metric-attendance", metrics.attendanceCheckIns);
  }

  function sourceDisclosure(sources) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    const list = document.createElement("ul");
    details.className = "ai-sources";
    summary.textContent = `${sources.length} retrieved facts`;
    sources.forEach((source) => {
      const item = document.createElement("li");
      const reference = document.createElement("strong");
      reference.textContent = `[${source.ref}]`;
      item.append(reference, ` ${source.text}`);
      list.append(item);
    });
    details.append(summary, list);
    return details;
  }


  function createFlaggedPhotoGallery(answer, sources = []) {
    const mentioned = photoFlagsMentionedInAnswer(answer, sources);
    if (mentioned.length === 0) return null;

    const gallery = document.createElement("section");
    gallery.className = "ai-flagged-photo-gallery";
    gallery.setAttribute("aria-label", "Flagged photos mentioned in this answer");
    mentioned.forEach((source) => {
      const { photoFlag } = source;
      const figure = document.createElement("figure");
      const image = document.createElement("img");
      const caption = document.createElement("figcaption");
      const title = document.createElement("strong");
      const context = document.createElement("span");
      const reason = document.createElement("p");
      figure.className = "ai-flagged-photo";
      figure.dataset.state = "loading";
      image.alt = `Flagged photo ${photoFlag.photoId} from ${photoFlag.location}`;
      image.loading = "lazy";
      image.decoding = "async";
      title.textContent = `Flagged photo ${photoFlag.photoId}`;
      context.textContent = [
        photoFlag.location,
        photoFlag.dateKey,
        photoFlag.sessionLabel,
      ].filter(Boolean).join(" · ");
      reason.textContent = photoFlag.detail;
      caption.append(title, context, reason);
      figure.append(image, caption);
      gallery.append(figure);

      Promise.resolve(cloud.getPhotoBlob(photoFlag.photo))
        .then((blob) => {
          const url = globalScope.URL.createObjectURL(blob);
          image.src = url;
          figure.dataset.state = "ready";
          image.addEventListener(
            "load",
            () => globalScope.URL.revokeObjectURL(url),
            { once: true },
          );
          image.addEventListener(
            "error",
            () => globalScope.URL.revokeObjectURL(url),
            { once: true },
          );
        })
        .catch(() => {
          figure.dataset.state = "error";
          image.remove();
          const unavailable = document.createElement("p");
          unavailable.className = "ai-flagged-photo-unavailable";
          unavailable.textContent = "The flagged image could not be opened.";
          figure.prepend(unavailable);
        });
    });
    return gallery;
  }

  function navigationLinks(actions) {
    const navigation = document.createElement("nav");
    const label = document.createElement("span");
    navigation.className = "ai-answer-actions";
    navigation.setAttribute("aria-label", "Open relevant StampNote sections");
    label.className = "ai-answer-actions-label";
    label.textContent = "Go to record";
    navigation.append(label);
    actions.forEach((action) => {
      const link = document.createElement("a");
      const arrow = document.createElement("span");
      link.href = action.href;
      link.dataset.actionKind = action.kind;
      link.textContent = action.label;
      arrow.setAttribute("aria-hidden", "true");
      arrow.textContent = "↗";
      link.append(arrow);
      navigation.append(link);
    });
    return navigation;
  }

  function svgNode(name, attributes = {}) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
    return node;
  }

  function createInlineLocationMap(snapshot) {
    const geometry = comparisonMapGeometry(snapshot);
    if (!geometry) return null;
    const isAddressMap = snapshot.kind === "public-addresses";
    const referenceLabel =
      snapshot.markerLabels?.reference ||
      (snapshot.reference.sourcePhotoId ? "Photo GPS" : "GPS reference");
    const comparisonLabel = snapshot.markerLabels?.comparison || "Truck";
    const figure = document.createElement("figure");
    const heading = document.createElement("figcaption");
    const headingText = document.createElement("div");
    const eyebrow = document.createElement("span");
    const title = document.createElement("strong");
    const summary = document.createElement("p");
    const svg = svgNode("svg", {
      viewBox: `0 0 ${geometry.width} ${geometry.height}`,
      role: "img",
      "aria-label": isAddressMap
        ? `Relative map comparing ${referenceLabel} with ${comparisonLabel}`
        : "Relative map comparing the photo GPS reference with the truck location",
    });
    const grid = svgNode("g", { class: "ai-inline-map-grid", "aria-hidden": "true" });
    const connection = svgNode("line", {
      class: "ai-inline-map-connection",
      x1: geometry.reference.x,
      y1: geometry.reference.y,
      x2: geometry.truck.x,
      y2: geometry.truck.y,
    });
    const accuracy = svgNode("circle", {
      class: "ai-inline-map-accuracy",
      cx: geometry.reference.x,
      cy: geometry.reference.y,
      r: geometry.accuracyRadius,
    });

    figure.className = "ai-inline-map";
    figure.dataset.reviewRequired = String(snapshot.flaggedForReview);
    figure.dataset.mapKind = snapshot.kind || "gps-truck";
    eyebrow.textContent = snapshot.eyebrow || "Location comparison";
    title.textContent = isAddressMap
      ? `${referenceLabel} · ${comparisonLabel}`
      : [snapshot.session?.location, snapshot.session?.sessionLabel]
          .filter(Boolean)
          .join(" · ") || "Photo and truck";
    summary.textContent = snapshot.summary
      || (snapshot.flaggedForReview
        ? `${snapshot.distanceMeters} m apart · over the ${snapshot.thresholdMeters} m limit`
        : `${snapshot.distanceMeters} m apart · within the ${snapshot.thresholdMeters} m limit`);
    headingText.append(eyebrow, title);
    heading.append(headingText, summary);

    for (let x = 0; x <= geometry.width; x += 50) {
      grid.append(svgNode("line", { x1: x, y1: 0, x2: x, y2: geometry.height }));
    }
    for (let y = 0; y <= geometry.height; y += 50) {
      grid.append(svgNode("line", { x1: 0, y1: y, x2: geometry.width, y2: y }));
    }
    svg.append(grid, connection, accuracy);

    [
      { key: "reference", point: geometry.reference, label: referenceLabel },
      { key: "truck", point: geometry.truck, label: comparisonLabel },
    ].forEach((marker) => {
      const group = svgNode("g", { class: `ai-inline-map-marker ai-inline-map-marker-${marker.key}` });
      const dot = svgNode("circle", { cx: marker.point.x, cy: marker.point.y, r: 8 });
      const label = svgNode("text", {
        x: marker.point.x,
        y: marker.point.y < 38 ? marker.point.y + 28 : marker.point.y - 16,
        "text-anchor": "middle",
      });
      label.textContent = marker.label;
      group.append(dot, label);
      svg.append(group);
    });

    const distanceLabel = svgNode("g", { class: "ai-inline-map-distance" });
    const distanceTextValue = `${snapshot.distanceMeters} m`;
    const labelWidth = Math.max(78, distanceTextValue.length * 9 + 24);
    distanceLabel.append(
      svgNode("rect", {
        x: geometry.midpoint.x - labelWidth / 2,
        y: geometry.midpoint.y - 13,
        width: labelWidth,
        height: 26,
        rx: 9,
      }),
    );
    const distanceText = svgNode("text", {
      x: geometry.midpoint.x,
      y: geometry.midpoint.y + 4,
      "text-anchor": "middle",
    });
    distanceText.textContent = distanceTextValue;
    distanceLabel.append(distanceText);
    svg.append(distanceLabel);

    const details = document.createElement("div");
    details.className = "ai-inline-map-details";
    const detailLines = isAddressMap
      ? [
          `${snapshot.fromLabel || referenceLabel} ${snapshot.reference.latitude.toFixed(6)}, ${snapshot.reference.longitude.toFixed(6)}`,
          `${snapshot.toLabel || comparisonLabel} ${snapshot.truck.latitude.toFixed(6)}, ${snapshot.truck.longitude.toFixed(6)}`,
          `GPS uncertainty ±${snapshot.reference.accuracyMeters} m`,
        ]
      : [
          `Photo GPS ${snapshot.reference.latitude.toFixed(6)}, ${snapshot.reference.longitude.toFixed(6)}`,
          `Truck ${snapshot.truck.latitude.toFixed(6)}, ${snapshot.truck.longitude.toFixed(6)}`,
          `GPS uncertainty ±${snapshot.reference.accuracyMeters} m`,
        ];
    detailLines.forEach((value) => {
      const item = document.createElement("span");
      item.textContent = value;
      details.append(item);
    });
    figure.append(heading, svg, details);
    if (snapshot.session?.sessionKey || !isAddressMap) {
      const fullMap = document.createElement("a");
      fullMap.className = "ai-inline-map-open";
      fullMap.href = coordinateQuery(snapshot.session);
      fullMap.textContent = "Open full coordinate session ↗";
      figure.append(fullMap);
    }
    return figure;
  }

  function formatMetricDay(dateKey, options = { day: "numeric", month: "short" }) {
    const date = new Date(`${dateKey}T00:00:00`);
    return Number.isNaN(date.getTime()) ? dateKey : date.toLocaleDateString(undefined, options);
  }

  function niceMetricCeiling(value) {
    if (value <= 4) return Math.max(1, value);
    const magnitude = 10 ** Math.floor(Math.log10(value));
    return Math.ceil(value / (magnitude / 2)) * (magnitude / 2);
  }

  function createInlineMetricChart(entry) {
    if (!entry?.keys?.length || entry.keys.length !== entry.values?.length) return null;
    const figure = document.createElement("figure");
    const caption = document.createElement("figcaption");
    const heading = document.createElement("div");
    const eyebrow = document.createElement("span");
    const title = document.createElement("strong");
    const summary = document.createElement("p");
    const plot = document.createElement("div");
    const width = 640;
    const height = 226;
    const left = 38;
    const right = 12;
    const top = 24;
    const bottom = 32;
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;
    const baseline = top + plotHeight;
    const ceiling = niceMetricCeiling(Math.max(...entry.values, 0));
    const band = plotWidth / entry.values.length;
    const barWidth = Math.max(2, Math.min(22, band - 2));
    const peak = Math.max(...entry.values, 0);
    const peakIndex = entry.values.indexOf(peak);
    const unit = `${entry.unit}${entry.total === 1 ? "" : "s"}`;
    const svg = svgNode("svg", {
      viewBox: `0 0 ${width} ${height}`,
      role: "img",
      "aria-label": `${entry.title}: ${entry.total} ${unit} over the last ${entry.rangeDays} days.`,
    });

    figure.className = "ai-inline-chart";
    figure.dataset.series = entry.id;
    eyebrow.textContent = `Metrics · ${entry.rangeDays} days`;
    title.textContent = entry.title;
    summary.textContent = `${entry.total.toLocaleString()} ${unit} · peak ${peak} on ${formatMetricDay(
      entry.keys[Math.max(0, peakIndex)],
    )}`;
    heading.append(eyebrow, title);
    caption.append(heading, summary);
    plot.className = "ai-inline-chart-plot";

    [0, 0.5, 1].forEach((fraction) => {
      const y = top + plotHeight * (1 - fraction);
      svg.append(
        svgNode("line", {
          class: fraction === 0 ? "ai-stat-axis" : "ai-stat-grid",
          x1: left,
          x2: width - right,
          y1: y,
          y2: y,
        }),
      );
      const tick = svgNode("text", {
        class: "ai-stat-tick",
        x: left - 7,
        y: y + 4,
        "text-anchor": "end",
      });
      tick.textContent = String(Math.round(ceiling * fraction));
      svg.append(tick);
    });

    entry.values.forEach((value, index) => {
      const x = left + band * index + (band - barWidth) / 2;
      const barHeight = ceiling > 0 ? (value / ceiling) * plotHeight : 0;
      if (barHeight > 0) {
        const bar = svgNode("rect", {
          class: "ai-stat-bar",
          x,
          y: baseline - barHeight,
          width: barWidth,
          height: barHeight,
          rx: Math.min(4, barWidth / 2, barHeight / 2),
        });
        const barTitle = svgNode("title");
        barTitle.textContent = `${formatMetricDay(entry.keys[index], {
          weekday: "short",
          day: "numeric",
          month: "short",
          year: "numeric",
        })}: ${value} ${entry.unit}${value === 1 ? "" : "s"}`;
        bar.append(barTitle);
        svg.append(bar);
      }
      if (entry.values.length <= 12 && value > 0) {
        const valueLabel = svgNode("text", {
          class: "ai-stat-value",
          x: x + barWidth / 2,
          y: Math.max(13, baseline - barHeight - 6),
          "text-anchor": "middle",
        });
        valueLabel.textContent = String(value);
        svg.append(valueLabel);
      }
    });

    [...new Set([0, Math.floor(entry.keys.length / 2), entry.keys.length - 1])].forEach(
      (index, position, indexes) => {
        const label = svgNode("text", {
          class: "ai-stat-tick",
          x: left + band * (index + 0.5),
          y: height - 8,
          "text-anchor": position === 0 ? "start" : position === indexes.length - 1 ? "end" : "middle",
        });
        label.textContent = formatMetricDay(entry.keys[index]);
        svg.append(label);
      },
    );
    plot.append(svg);

    const dataDetails = document.createElement("details");
    const dataSummary = document.createElement("summary");
    const tableWrap = document.createElement("div");
    const table = document.createElement("table");
    const tableCaption = document.createElement("caption");
    const body = document.createElement("tbody");
    dataDetails.className = "ai-inline-chart-data";
    dataSummary.textContent = "View daily values";
    tableWrap.className = "ai-inline-chart-table-wrap";
    tableCaption.textContent = `${entry.title}, last ${entry.rangeDays} days`;
    entry.keys.forEach((dateKey, index) => {
      const row = document.createElement("tr");
      const date = document.createElement("th");
      const value = document.createElement("td");
      date.scope = "row";
      date.textContent = formatMetricDay(dateKey, {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
      });
      value.textContent = `${entry.values[index]} ${entry.unit}${entry.values[index] === 1 ? "" : "s"}`;
      row.append(date, value);
      body.append(row);
    });
    table.append(tableCaption, body);
    tableWrap.append(table);
    dataDetails.append(dataSummary, tableWrap);
    figure.append(caption, plot, dataDetails);
    return figure;
  }

  function stopSpeech(playback = currentSpeech) {
    if (!playback) return;
    playback.controller?.abort?.();
    playback.reader?.cancel?.().catch?.(() => {});
    playback.audio?.pause?.();
    if (playback.audio) playback.audio.src = "";
    playback.sources?.forEach?.((source) => {
      try {
        source.stop();
      } catch {
        // A source that has already ended needs no further cleanup.
      }
    });
    playback.sources?.clear?.();
    if (playback.finishTimer) globalScope.clearTimeout(playback.finishTimer);
    playback.context?.close?.().catch?.(() => {});
    if (playback.url) globalScope.URL?.revokeObjectURL?.(playback.url);
    if (playback.button) {
      playback.button.disabled = false;
      playback.button.dataset.state = "idle";
      playback.button.textContent = "Listen";
    }
    if (currentSpeech === playback) currentSpeech = null;
  }

  function decodePcmAudio(value) {
    const binary = globalScope.atob(String(value || ""));
    if (!binary.length || binary.length % 2 !== 0) {
      throw new Error("Gemini voice returned an invalid audio chunk.");
    }
    const samples = new Float32Array(binary.length / 2);
    for (let index = 0; index < samples.length; index += 1) {
      const low = binary.charCodeAt(index * 2);
      const high = binary.charCodeAt(index * 2 + 1);
      const signed = (high << 8) | low;
      samples[index] = (signed >= 0x8000 ? signed - 0x10000 : signed) / 0x8000;
    }
    return samples;
  }

  function scheduleSpeechChunk(playback, event) {
    if (currentSpeech !== playback || !playback.context) return;
    const sampleRate = Number(event.sampleRate) || 24_000;
    const samples = decodePcmAudio(event.data);
    const buffer = playback.context.createBuffer(1, samples.length, sampleRate);
    if (typeof buffer.copyToChannel === "function") buffer.copyToChannel(samples, 0);
    else buffer.getChannelData(0).set(samples);
    const source = playback.context.createBufferSource();
    source.buffer = buffer;
    source.connect(playback.context.destination);
    const firstChunk = !playback.receivedAudio;
    const startAt = Math.max(
      playback.nextStartTime || 0,
      playback.context.currentTime + (firstChunk ? 0.08 : 0.015),
    );
    source.start(startAt);
    playback.nextStartTime = startAt + buffer.duration;
    playback.receivedAudio = true;
    playback.sources.add(source);
    source.onended = () => playback.sources.delete(source);
    playback.button.disabled = false;
    playback.button.dataset.state = "playing";
    playback.button.textContent = "Stop";
    voiceStatus.textContent = "Playing Gemini voice · Kore.";
  }

  async function playSpeechStream(response, playback) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    playback.reader = reader;
    let pending = "";
    let completed = false;

    function handleLine(line) {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      if (event.type === "audio") scheduleSpeechChunk(playback, event);
      if (event.type === "done") completed = true;
    }

    while (currentSpeech === playback && !completed) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || "";
      lines.forEach(handleLine);
      if (done) break;
    }
    if (pending.trim()) handleLine(pending);
    playback.reader = null;
    if (currentSpeech !== playback) return;
    if (!playback.receivedAudio) {
      throw new Error("Gemini voice returned no playable audio.");
    }
    const remainingMs = Math.max(
      0,
      Math.ceil((playback.nextStartTime - playback.context.currentTime) * 1_000),
    );
    playback.finishTimer = globalScope.setTimeout(() => {
      if (currentSpeech !== playback) return;
      stopSpeech(playback);
      voiceStatus.textContent = "Gemini voice finished.";
    }, remainingMs + 40);
  }

  async function speakAnswer(text, button) {
    const canStream = Boolean(SpeechAudioContext && globalScope.atob);
    const canPlayWav = Boolean(globalScope.Audio && globalScope.URL?.createObjectURL);
    if (!signedInUser || (!canStream && !canPlayWav)) return;
    if (currentSpeech?.button === button) {
      if (currentSpeech.audio && button.dataset.state === "ready") {
        try {
          await currentSpeech.audio.play();
          button.dataset.state = "playing";
          button.textContent = "Stop";
          voiceStatus.textContent = "Playing Gemini voice · Kore.";
        } catch {
          voiceStatus.textContent = "The Gemini voice response could not be played.";
        }
      } else stopSpeech();
      voiceStatus.textContent = "Gemini voice stopped.";
      return;
    }
    stopSpeech();

    const controller = globalScope.AbortController ? new globalScope.AbortController() : null;
    const playback = {
      audio: null,
      button,
      context: null,
      controller,
      finishTimer: null,
      nextStartTime: 0,
      reader: null,
      receivedAudio: false,
      sources: new Set(),
      url: null,
    };
    currentSpeech = playback;
    button.disabled = false;
    button.dataset.state = "loading";
    button.textContent = "Generating voice…";
    voiceStatus.textContent = "Starting Gemini voice…";

    try {
      if (canStream) {
        try {
          playback.context = new SpeechAudioContext({ sampleRate: 24_000 });
        } catch {
          playback.context = new SpeechAudioContext();
        }
        await playback.context.resume?.();
      }
      const token = await signedInUser.getIdToken();
      const response = await globalScope.fetch(speechEndpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(canStream ? { Accept: "application/x-ndjson" } : {}),
        },
        body: JSON.stringify({ text: String(text || "").slice(0, 2_400) }),
        signal: controller?.signal,
      });
      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        throw new Error(errorBody.error || `Gemini voice returned HTTP ${response.status}.`);
      }
      if (
        canStream &&
        response.body?.getReader &&
        /application\/x-ndjson/i.test(response.headers?.get?.("content-type") || "")
      ) {
        await playSpeechStream(response, playback);
        return;
      }
      const blob = await response.blob();
      if (currentSpeech !== playback) return;
      playback.url = globalScope.URL.createObjectURL(blob);
      playback.audio = new globalScope.Audio(playback.url);
      playback.audio.addEventListener("ended", () => {
        if (currentSpeech !== playback) return;
        stopSpeech(playback);
        voiceStatus.textContent = "Gemini voice finished.";
      });
      playback.audio.addEventListener("error", () => {
        if (currentSpeech !== playback) return;
        stopSpeech(playback);
        voiceStatus.textContent = "The Gemini voice response could not be played.";
      });
      button.disabled = false;
      button.dataset.state = "playing";
      button.textContent = "Stop";
      try {
        await playback.audio.play();
        voiceStatus.textContent = "Playing Gemini voice · Kore.";
      } catch (error) {
        if (error?.name !== "NotAllowedError") throw error;
        button.dataset.state = "ready";
        button.textContent = "Play";
        voiceStatus.textContent = "Gemini voice is ready · tap Play.";
      }
    } catch (error) {
      if (error?.name === "AbortError") return;
      if (currentSpeech === playback) stopSpeech(playback);
      voiceStatus.textContent = error?.message || "Gemini voice is unavailable right now.";
    }
  }

  function createListenButton(text) {
    if (
      !(SpeechAudioContext && globalScope.atob) &&
      (!globalScope.Audio || !globalScope.URL?.createObjectURL)
    ) {
      return null;
    }
    const listen = document.createElement("button");
    listen.className = "ai-listen";
    listen.type = "button";
    listen.dataset.state = "idle";
    listen.textContent = "Listen";
    listen.addEventListener("click", () => speakAnswer(text, listen));
    return listen;
  }

  function addMessage(role, content, options = {}) {
    const item = document.createElement("li");
    const article = document.createElement("article");
    const label = document.createElement("span");
    const body = document.createElement("div");
    item.className = `ai-message-row ai-message-row-${role}`;
    article.className = `ai-message ai-message-${role}`;
    label.className = "ai-message-label";
    label.textContent = role === "assistant" ? "Operations AI" : "You";
    body.className = "ai-message-body";
    if (role === "assistant") renderAnswer(body, content);
    else body.textContent = content;
    article.append(label, body);
    if (options.map) {
      const inlineMap = createInlineLocationMap(options.map);
      if (inlineMap) article.append(inlineMap);
    }
    if (options.actions?.length) article.append(navigationLinks(options.actions));
    if (options.sources?.length) article.append(sourceDisclosure(options.sources));
    item.append(article);
    messageList.append(item);
    messageList.scrollTop = messageList.scrollHeight;
    return { item, article, body };
  }

  function describeError(error) {
    return describeAssistantError(error, assistantEndpoint);
  }

  async function loadAllPhotos() {
    return operationsData.loadAllPhotos();
  }

  async function loadKnowledge() {
    if (!signedInUser || loading) return;
    loading = true;
    const now = () => (typeof performance !== "undefined" && performance?.now ? performance.now() : Date.now());
    const startedAt = now();
    const traceId = telemetry?.createTraceId?.();
    knowledge = null;
    setBusy();
    setStatus("Building the operations knowledge index…", "loading");
    try {
      const [photos, attendance, savedSessions] = await Promise.all([
        loadAllPhotos(),
        operationsData.loadAttendance({ pageSize: 500 }),
        operationsData.loadDashboardSessions(),
      ]);
      knowledge = buildKnowledgeBase({ photos, attendance, savedSessions }, data, coordinates, metricsApi);
      renderMetrics(knowledge.metrics);
      scopeLabel.textContent =
        `${knowledge.metrics.sessionCount} sessions · ${knowledge.metrics.attendanceCheckIns} check-ins · ` +
        `${knowledge.metrics.photoCount} photos`;
      setStatus(
        `Ready · ${knowledge.facts.length} searchable operational facts indexed in this browser.`,
        "success",
      );
      telemetry?.event?.(
        "ai.knowledge.loaded",
        {
          durationMs: now() - startedAt,
          sessionCount: knowledge.metrics.sessionCount,
          factCount: knowledge.facts.length,
          status: "success",
        },
        { traceId },
      );
    } catch (error) {
      setStatus(describeError(error), "error");
      telemetry?.event?.(
        "ai.knowledge.failed",
        {
          durationMs: now() - startedAt,
          errorCode: telemetry?.safeErrorCode?.(error, "knowledge_build_failed"),
          status: "failed",
        },
        { traceId, immediate: true, dedupeMs: 60000 },
      );
    } finally {
      loading = false;
      setBusy();
      refreshGpsMarginSuggestion();
    }
  }

  async function askQuestion(question) {
    const cleaned = String(question || "").trim();
    if (!cleaned || !knowledge || asking || !signedInUser) return;
    const now = () => (typeof performance !== "undefined" && performance?.now ? performance.now() : Date.now());
    const startedAt = now();
    const traceId = telemetry?.createTraceId?.();
    const request = createAssistantPayload(cleaned, history, knowledge);
    addMessage("user", cleaned);
    const pending = addMessage("assistant", "Reviewing the relevant records…");
    pending.article.dataset.state = "thinking";
    asking = true;
    prompt.value = "";
    setBusy();
    telemetry?.event?.(
      "ai.assistant.query.started",
      { factCount: request.sources.length },
      { traceId },
    );
    try {
      const token = await signedInUser.getIdToken();
      const response = await globalScope.fetch(assistantEndpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-StampNote-Trace-Id": traceId,
        },
        body: JSON.stringify(request.payload),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `The assistant returned HTTP ${response.status}.`);
      renderAnswer(pending.body, result.answer);
      pending.article.dataset.state = "complete";
      const externalGeography = externalGeographyDisclosure(result.geography, document);
      if (externalGeography) pending.article.append(externalGeography);
      const flaggedPhotoGallery = createFlaggedPhotoGallery(result.answer, request.sources);
      if (flaggedPhotoGallery) pending.article.append(flaggedPhotoGallery);
      metricChartsForQuestion(cleaned, knowledge).forEach((entry) => {
        const chart = createInlineMetricChart(entry);
        if (chart) pending.article.append(chart);
      });
      const inlineMap = createInlineLocationMap(
        inlineMapForQuestion(cleaned, request.sources, result.map),
      );
      if (inlineMap) pending.article.append(inlineMap);
      const actions = navigationActions(cleaned, request.sources);
      if (actions.length) pending.article.append(navigationLinks(actions));
      pending.article.append(sourceDisclosure(request.sources));
      const listen = createListenButton(result.answer);
      if (listen) pending.article.append(listen);
      history.push(
        { role: "user", content: cleaned },
        { role: "assistant", content: String(result.answer).slice(0, 2_400) },
      );
      if (history.length > 8) history.splice(0, history.length - 8);
      telemetry?.event?.(
        "ai.assistant.query.completed",
        {
          durationMs: now() - startedAt,
          factCount: request.sources.length,
          status: "success",
        },
        { traceId },
      );
    } catch (error) {
      pending.body.textContent = describeError(error);
      pending.article.dataset.state = "error";
      telemetry?.event?.(
        "ai.assistant.query.failed",
        {
          durationMs: now() - startedAt,
          errorCode: telemetry?.safeErrorCode?.(error, "assistant_query_failed"),
          status: "failed",
        },
        { traceId, immediate: true, dedupeMs: 60000 },
      );
    } finally {
      asking = false;
      setBusy();
      prompt.focus?.();
      messageList.scrollTop = messageList.scrollHeight;
    }
  }

  function systemPrefersDark() {
    return globalScope.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
  }

  function storedTheme() {
    try {
      const saved = globalScope.localStorage?.getItem("stampnote-theme");
      return saved === "light" || saved === "dark" ? saved : null;
    } catch {
      return null;
    }
  }

  function applyTheme(theme) {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    const dark = theme ? theme === "dark" : systemPrefersDark();
    themeToggle?.setAttribute("aria-pressed", String(dark));
    themeToggle?.setAttribute("title", dark ? "Switch to light theme" : "Switch to dark theme");
    if (themeIcon) themeIcon.textContent = dark ? "☀" : "☾";
    if (themeLabel) themeLabel.textContent = dark ? "Light" : "Dark";
  }

  function toggleTheme() {
    const next = (storedTheme() || (systemPrefersDark() ? "dark" : "light")) === "dark"
      ? "light"
      : "dark";
    try {
      globalScope.localStorage?.setItem("stampnote-theme", next);
    } catch {
      /* The selected theme still applies for this visit. */
    }
    applyTheme(next);
    telemetry?.event("dashboard.theme.changed", { theme: next });
  }

  const Recognition = globalScope.SpeechRecognition || globalScope.webkitSpeechRecognition;
  if (Recognition) {
    recognition = new Recognition();
    recognition.lang = globalScope.navigator?.language || "en-SG";
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.addEventListener("start", () => {
      micButton.dataset.state = "listening";
      micButton.setAttribute("aria-pressed", "true");
      voiceStatus.textContent = "Listening…";
    });
    recognition.addEventListener("result", (event) => {
      const transcript = [...event.results].map((result) => result[0]?.transcript || "").join(" ").trim();
      if (transcript) {
        prompt.value = transcript;
        setBusy();
      }
      voiceStatus.textContent = event.results[event.results.length - 1]?.isFinal
        ? "Voice captured. Review it, then send."
        : "Listening…";
    });
    recognition.addEventListener("error", (event) => {
      voiceStatus.textContent = event.error === "not-allowed"
        ? "Microphone access was not allowed."
        : "Voice input stopped. You can still type your question.";
    });
    recognition.addEventListener("end", () => {
      micButton.dataset.state = "idle";
      micButton.setAttribute("aria-pressed", "false");
    });
  } else {
    micButton.title = "Voice input is not supported by this browser";
    voiceStatus.textContent = "Voice input is unavailable in this browser; typing still works.";
  }

  function bindPromptSuggestions(root = document) {
    root.querySelectorAll("[data-ai-question]").forEach((button) => {
      if (button.dataset.aiBound === "true") return;
      button.dataset.aiBound = "true";
      button.addEventListener("click", () => {
        prompt.value = button.dataset.aiQuestion;
        setBusy();
        askQuestion(prompt.value);
      });
    });
  }

  function refreshGpsMarginSuggestion() {
    const bar = document.querySelector(".ai-prompt-suggestions");
    if (!bar) return;
    const suggestion = gpsAccuracyMarginSuggestion(prompt.value, knowledge);
    let chip = bar.querySelector("[data-ai-gps-margin-suggestion]");
    if (!suggestion) {
      chip?.remove();
      return;
    }
    if (!chip) {
      chip = document.createElement("button");
      chip.type = "button";
      chip.dataset.aiGpsMarginSuggestion = "true";
      bar.prepend(chip);
    }
    chip.dataset.aiQuestion = suggestion.question;
    chip.textContent = suggestion.label;
    bindPromptSuggestions(bar);
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    askQuestion(prompt.value);
  });
  prompt.addEventListener("input", () => {
    setBusy();
    refreshGpsMarginSuggestion();
  });
  prompt.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      askQuestion(prompt.value);
    }
  });
  micButton.addEventListener("click", () => {
    if (!recognition) return;
    if (micButton.dataset.state === "listening") recognition.stop();
    else recognition.start();
  });
  refreshButton.addEventListener("click", loadKnowledge);
  signInButton.addEventListener("click", () =>
    cloud
      .signIn()
      .catch((error) => {
        setStatus(describeError(error), "error");
        telemetry?.event(
          "cloud.auth.failed",
          { errorCode: telemetry?.safeErrorCode(error, "auth_failed"), status: "failed" },
          { immediate: true, dedupeMs: 60000 },
        );
      }),
  );
  signOutButton.addEventListener("click", () =>
    cloud
      .signOut()
      .catch((error) => {
        setStatus(describeError(error), "error");
        telemetry?.event(
          "cloud.auth.failed",
          { errorCode: telemetry?.safeErrorCode(error, "auth_failed"), status: "failed" },
          { immediate: true, dedupeMs: 60000 },
        );
      }),
  );
  themeToggle?.addEventListener("click", toggleTheme);
  bindPromptSuggestions();

  applyTheme(storedTheme());
  globalScope.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => applyTheme(storedTheme()));
  setBusy();

  if (!cloud || !data || !coordinates) {
    signInButton.disabled = true;
    setStatus("The operations data client could not initialize.", "error");
    telemetry?.event(
      "client.error",
      { errorCode: "cloud_dependencies_missing" },
      { immediate: true },
    );
    return;
  }
  cloud.subscribeAuth((user, error) => {
    if (error) {
      signedInUser = null;
      authGate.hidden = false;
      workspace.hidden = true;
      setStatus(describeError(error), "error");
      telemetry?.event(
        "cloud.auth.failed",
        { errorCode: telemetry?.safeErrorCode(error, "auth_failed"), status: "failed" },
        { immediate: true, dedupeMs: 60000 },
      );
      return;
    }
    signedInUser = user || null;
    authGate.hidden = Boolean(user);
    workspace.hidden = !user;
    signOutButton.hidden = !user;
    accountName.textContent = user?.email || "";
    telemetry?.event("cloud.auth.state", {
      status: user ? "signed_in" : "signed_out",
    });
    if (!user) {
      knowledge = null;
      setStatus("");
      renderMetrics({ sessionCount: 0, flaggedSessionCount: 0, weatherIssueCount: 0, attendanceCheckIns: 0 });
      setBusy();
      return;
    }
    Promise.resolve(cloud.getAccess?.(user))
      .then((access) => {
        if (access && access.canAccessAdmin === false) {
          knowledge = null;
          setStatus(
            describeError({
              code: "admin-required",
              message: "Operations AI is available to administrators only.",
            }),
            "error",
          );
          setBusy();
          return;
        }
        return loadKnowledge();
      })
      .catch((accessError) => {
        setStatus(describeError(accessError), "error");
        setBusy();
      });
  });
})(typeof globalThis !== "undefined" ? globalThis : this);

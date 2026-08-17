process.env.TZ = "UTC";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");

const data = require("../photo-cloud.js");
globalThis.StampNoteCloudData = data;
const metrics = require("../metrics.js");
const dashboard = require("../ai-dashboard.js");
const coordinates = require("../coordinates.js");

const root = resolve(__dirname, "..");
const html = readFileSync(resolve(root, "ai-dashboard.html"), "utf8");
const css = readFileSync(resolve(root, "ai-dashboard.css"), "utf8");
const source = readFileSync(resolve(root, "ai-dashboard.js"), "utf8");
const adminSource = readFileSync(resolve(root, "admin.js"), "utf8");
const coordinatesSource = readFileSync(resolve(root, "coordinates.js"), "utf8");
const operationsAiGuide = readFileSync(resolve(root, "OPERATIONS_AI_GUIDE.md"), "utf8");

function knowledgeFixture() {
  const location = "10 Marina Bay";
  const capturedAtMs = Date.parse("2026-08-14T13:10:00.000Z");
  return dashboard.buildKnowledgeBase(
    {
      photos: [
        {
          id: "photo-1",
          capturedAt: new Date(capturedAtMs).toISOString(),
          capturedAtMs,
          dateKey: "2026-08-14",
          location,
          locationKey: data.createLocationKey(location),
          gpsLocation: { latitude: 1.2868, longitude: 103.8545, accuracyMeters: 8 },
          aiReview: { action: "discard", recommendation: "discard", reason: "Unusable." },
        },
      ],
      attendance: [
        {
          eventId: "attendance-1",
          workerId: "W001",
          displayName: "Jane Tan",
          checkedInAtMs: Date.parse("2026-08-14T13:05:00.000Z"),
          dateKey: "2026-08-14",
          location,
        },
      ],
      savedSessions: [
        {
          key: data.createSessionKey({
            locationKey: data.createLocationKey(location),
            dateKey: "2026-08-14",
            sessionId: "afternoon",
          }),
          location,
          dateKey: "2026-08-14",
          sessionId: "afternoon",
          gpsLocation: { latitude: 1.2868, longitude: 103.8545, accuracyMeters: 8 },
          gpsCapturedAtMs: Date.parse("2026-08-14T12:00:00.000Z"),
          truckLocation: { x: 103.8645, y: 1.2868 },
          weather: {
            severity: "storm",
            condition: "Thunderstorm",
            precipitationMm: 8.5,
            maxGustKph: 74,
            lostHours: 1.7,
            impactPercent: 33,
            hours: 5,
            wetHours: 2,
          },
        },
      ],
      now: Date.parse("2026-08-17T09:00:00.000Z"),
    },
    data,
    coordinates,
    metrics,
  );
}

test("the AI dashboard is the conversation, its prompts, and its sources", () => {
  assert.match(html, /<title>Operations AI · StampNote<\/title>/);
  assert.doesNotMatch(html, /Read-only operations intelligence|Ask your field data|Speak or type a question/);
  assert.doesNotMatch(html, /class="ai-intro"|class="ai-live-badge"/);
  assert.match(html, /id="ai-workspace"/);
  assert.match(html, /id="ai-message-list"/);
  assert.match(html, /id="ai-prompt"[^>]*maxlength="1200"/);
  assert.match(html, /id="ai-mic"[^>]*aria-pressed="false"/);
  assert.match(html, /data-ai-question="Show me the flagged sessions/);
  assert.match(html, /data-ai-question="Show the last 30 days of Metrics statistics and graphs/);
  assert.match(html, /<script src="metrics\.js\?v=/);
  assert.match(
    html,
    /<link\s+rel="help"\s+href="OPERATIONS_AI_GUIDE\.md"\s+type="text\/markdown"/,
  );
  assert.match(
    html,
    /class="ai-page-guide-link"[\s\S]*?href="OPERATIONS_AI_GUIDE\.md"[\s\S]*?rel="help"/,
  );
  assert.match(operationsAiGuide, /#ai-prompt/);
  assert.match(operationsAiGuide, /data-state="complete"/);
  assert.match(operationsAiGuide, /assistant is read-only/i);
  assert.doesNotMatch(html, /Try asking|ai-suggested-questions/);
  assert.match(
    html,
    /<\/ol>\s*<div class="ai-prompt-suggestions"[\s\S]*?<form class="ai-chat-form"/,
  );
  assert.match(css, /\.ai-prompt-suggestions\s*\{[^}]*display: flex/);
  assert.match(css, /\.ai-prompt-suggestions button\s*\{[^}]*border-radius: 999px/);
  // The scope panel and the standing disclaimers are gone: the page is the
  // conversation. What the assistant may and may not do is enforced by the
  // endpoint, not by a paragraph under the composer.
  assert.doesNotMatch(html, /class="ai-context-panel"|Operational scope|id="ai-metric-/);
  assert.doesNotMatch(html, /Gemini grounded chat|class="ai-disclaimer"/);
  assert.doesNotMatch(css, /\.ai-metrics|\.ai-context-panel|\.ai-disclaimer/);
  // Refreshing the index survived its panel, beside the scope line it refreshes.
  assert.match(html, /class="ai-chat-heading-actions"[\s\S]*?id="ai-refresh"/);
  assert.match(source, /refreshButton\.addEventListener\("click", loadKnowledge\)/);
  assert.match(source, /SpeechRecognition \|\| globalScope\.webkitSpeechRecognition/);
  assert.match(source, /signedInUser\.getIdToken\(\)/);
  assert.match(source, /Authorization: `Bearer \$\{token\}`/);
  assert.match(source, /sourceDisclosure\(request\.sources\)/);
});

test("the knowledge index joins flags, weather, photos, sessions, and attendance", () => {
  const knowledge = knowledgeFixture();
  assert.deepEqual(knowledge.metrics, {
    sessionCount: 1,
    flaggedSessionCount: 1,
    weatherIssueCount: 1,
    attendanceCheckIns: 1,
    workerCount: 1,
    photoCount: 1,
  });
  assert.equal(knowledge.sessions[0].flaggedForReview, true);
  assert.equal(knowledge.sessions[0].weatherIssue, true);
  assert.ok(knowledge.facts.some((fact) => fact.kind === "flag"));
  const photoFlag = knowledge.facts.find((fact) => fact.photoFlag?.photoId === "photo-1");
  assert.ok(photoFlag, "the flagged image has its own citable fact");
  assert.match(photoFlag.text, /Specific photo flag photo-1/);
  assert.match(photoFlag.text, /Unusable/);
  assert.ok(knowledge.facts.some((fact) => fact.kind === "weather"));
  assert.ok(
    knowledge.facts.some(
      (fact) => fact.kind === "attendance" && /Jane Tan \(W001\)/.test(fact.text),
    ),
  );
  assert.equal(knowledge.metricSeries[30].length, 3);
  assert.equal(knowledge.metricSeries[30].find((entry) => entry.id === "attendance").total, 1);
  assert.equal(knowledge.metricSeries[30].find((entry) => entry.id === "flags").total, 1);
  assert.ok(knowledge.facts.some((fact) => fact.kind === "metric" && fact.rangeDays === 30));
});

test("only specifically cited photo flags are selected for inline display", () => {
  const knowledge = knowledgeFixture();
  const request = dashboard.createAssistantPayload(
    "Why was photo-1 flagged?",
    [],
    knowledge,
  );
  const photoSource = request.sources.find((fact) => fact.photoFlag?.photoId === "photo-1");
  const transmitted = request.payload.facts.find((fact) => /photo-1/.test(fact.text));

  assert.ok(photoSource);
  assert.equal(Object.hasOwn(transmitted, "photoFlag"), false, "image data stays in the browser");
  assert.deepEqual(
    dashboard.photoFlagsMentionedInAnswer(
      `Photo photo-1 was unusable [${photoSource.ref}].`,
      request.sources,
    ).map((fact) => fact.photoFlag.photoId),
    ["photo-1"],
  );
  assert.deepEqual(
    dashboard.photoFlagsMentionedInAnswer(
      "The session has one photo flag [S1].",
      request.sources,
    ),
    [],
  );
  assert.match(source, /createFlaggedPhotoGallery\(result\.answer, request\.sources\)/);
  assert.match(source, /cloud\.getPhotoBlob\(photoFlag\.photo\)/);
  assert.match(css, /\.ai-flagged-photo-gallery\s*\{/);
});

test("metrics questions retrieve exact Metrics-page series and choose truthful graphs", () => {
  const knowledge = knowledgeFixture();
  const charts = dashboard.metricChartsForQuestion(
    "Show the last 30 days of Metrics statistics and graphs for attendance, flags, and sessions.",
    knowledge,
  );
  const flagChart = dashboard.metricChartsForQuestion("Graph flags for the last 7 days", knowledge);
  const retrieval = dashboard.rankKnowledge("Graph flags for the last 7 days", knowledge);
  const actions = dashboard.navigationActions("Graph flags for the last 7 days", retrieval.facts);

  assert.deepEqual(charts.map((entry) => entry.id), ["attendance", "flags", "sessions"]);
  assert.ok(charts.every((entry) => entry.rangeDays === 30 && entry.values.length === 30));
  assert.equal(flagChart.length, 1);
  assert.equal(flagChart[0].id, "flags");
  assert.equal(flagChart[0].rangeDays, 7);
  assert.equal(retrieval.facts[1].kind, "metric");
  assert.equal(retrieval.facts[1].metricId, "flags");
  assert.ok(actions.some((action) => action.href === "metrics.html#metrics-panels"));
  assert.deepEqual(dashboard.metricChartsForQuestion("Which sessions are flagged?", knowledge), []);
  assert.deepEqual(dashboard.metricChartsForQuestion("Graph the weather impact", knowledge), []);
  assert.match(source, /createInlineMetricChart/);
  assert.match(source, /metricChartsForQuestion\(cleaned, knowledge\)/);
  assert.match(css, /\.ai-inline-chart\[data-series="flags"\]/);
  assert.match(css, /\.ai-inline-chart-table-wrap/);
});

test("retrieval favors the requested operational evidence and returns bounded citations", () => {
  const knowledge = knowledgeFixture();
  const weather = dashboard.rankKnowledge("Which sessions had problematic weather?", knowledge);
  const attendance = dashboard.rankKnowledge("When did Jane Tan check in?", knowledge);

  assert.equal(weather.facts[0].kind, "overview");
  assert.ok(weather.facts.slice(1, 4).some((fact) => fact.kind === "weather"));
  assert.ok(attendance.facts.slice(1, 4).some((fact) => fact.kind === "attendance"));
  assert.ok(weather.facts.length <= dashboard.MAX_RETRIEVED_FACTS);
  assert.deepEqual(
    weather.facts.map((fact) => fact.ref),
    weather.facts.map((_, index) => `S${index + 1}`),
  );

  const request = dashboard.createAssistantPayload(
    "Show flagged sessions",
    [{ role: "assistant", content: "Previous answer" }],
    knowledge,
  );
  assert.equal(request.payload.scope.retrieved, request.payload.facts.length);
  assert.equal(request.payload.scope.flaggedSessions, 1);
  assert.ok(request.payload.facts.some((fact) => fact.kind === "flag"));
});

test("a location with no activity today does not retrieve unrelated sites", () => {
  const knowledge = knowledgeFixture();
  const retrieval = dashboard.rankKnowledge(
    "Were there any attendance check-ins at Airport today?",
    knowledge,
  );

  assert.equal(knowledge.currentDate, "2026-08-17");
  assert.deepEqual(retrieval.facts.map((fact) => fact.kind), ["overview", "overview"]);
  assert.match(retrieval.facts[0].text, /Current local date: 2026-08-17/);
  assert.match(retrieval.facts[1].text, /found 0 records/);
  assert.match(retrieval.facts[1].text, /airport/);
  assert.match(retrieval.facts[1].text, /on 2026-08-17/);
  assert.doesNotMatch(retrieval.facts[1].text, /10 Marina Bay/);

  const phrasedWithFor = dashboard.rankKnowledge(
    "Were there any attendance check-ins for Airport today?",
    knowledge,
  );
  assert.match(phrasedWithFor.facts[1].text, /found 0 records/);
  assert.doesNotMatch(phrasedWithFor.facts[1].text, /10 Marina Bay/);
});

test("a differently worded airport address reaches Gemini as a reasoning candidate", () => {
  const capturedAtMs = Date.parse("2026-08-16T09:10:00.000Z");
  const knowledge = dashboard.buildKnowledgeBase(
    {
      photos: [
        {
          id: "airport-photo",
          capturedAtMs,
          dateKey: "2026-08-16",
          location: "65 T1 Boulevard",
          gpsLocation: { latitude: 1.3644, longitude: 103.9915, accuracyMeters: 8 },
        },
        {
          id: "parbury-photo",
          capturedAtMs,
          dateKey: "2026-08-16",
          location: "34 Parbury Avenue",
          gpsLocation: { latitude: 1.31, longitude: 103.92, accuracyMeters: 8 },
        },
      ],
      attendance: [],
      savedSessions: [],
      now: Date.parse("2026-08-17T09:00:00.000Z"),
    },
    data,
    coordinates,
    metrics,
  );

  const retrieval = dashboard.rankKnowledge(
    "What happened at 64 Airport Blvd?",
    knowledge,
  );

  assert.equal(retrieval.facts[1].kind, "overview");
  assert.match(retrieval.facts[1].text, /plausible site session candidate/);
  assert.ok(retrieval.facts.some((fact) => /65 T1 Boulevard/.test(fact.text)));
  assert.equal(retrieval.facts.some((fact) => /34 Parbury Avenue/.test(fact.text)), false);
  assert.equal(retrieval.facts.some((fact) => /found 0 records/.test(fact.text)), false);
});

test("GPS-clustered address aliases are explicit same-site evidence", () => {
  const capturedAtMs = Date.parse("2026-08-16T09:10:00.000Z");
  const knowledge = dashboard.buildKnowledgeBase(
    {
      photos: [
        {
          id: "canonical-1",
          capturedAtMs,
          dateKey: "2026-08-16",
          location: "65 T1 Boulevard",
          gpsLocation: { latitude: 1.3644, longitude: 103.9915, accuracyMeters: 8 },
        },
        {
          id: "canonical-2",
          capturedAtMs: capturedAtMs + 1_000,
          dateKey: "2026-08-16",
          location: "65 T1 Boulevard",
          gpsLocation: { latitude: 1.36441, longitude: 103.9915, accuracyMeters: 8 },
        },
        {
          id: "alias",
          capturedAtMs: capturedAtMs + 2_000,
          dateKey: "2026-08-16",
          location: "64 Airport Blvd",
          gpsLocation: { latitude: 1.36442, longitude: 103.99151, accuracyMeters: 8 },
        },
      ],
      attendance: [],
      savedSessions: [],
      now: Date.parse("2026-08-17T09:00:00.000Z"),
    },
    data,
    coordinates,
    metrics,
  );

  const retrieval = dashboard.rankKnowledge(
    "I sent my team to 64 Airport Blvd, what happened in that session?",
    knowledge,
  );
  const session = retrieval.facts.find((fact) => fact.kind === "session");

  assert.match(session.text, /65 T1 Boulevard/);
  assert.match(session.text, /GPS-clustered address alias.*64 Airport Blvd/);
});

test("a named worker or site retrieves only directly matching records", () => {
  const knowledge = knowledgeFixture();
  const worker = dashboard.rankKnowledge("When did Jane Tan check in?", knowledge);
  const site = dashboard.rankKnowledge("What happened at 10 Marina Bay?", knowledge);

  assert.ok(worker.facts.slice(1).some((fact) => /Jane Tan/.test(fact.text)));
  assert.ok(worker.facts.slice(1).every((fact) => /jane|tan/.test(fact.searchText)));
  assert.ok(site.facts.slice(1).some((fact) => /10 Marina Bay/.test(fact.text)));
  assert.ok(site.facts.slice(1).every((fact) => /10|marina|bay/.test(fact.searchText)));
  const latest = dashboard.rankKnowledge(
    "Summarize the latest recorded site activity and anything needing attention.",
    knowledge,
  );
  assert.ok(latest.facts.slice(1).some((fact) => fact.kind === "session"));
});

test("local Live Server uses the deployed API and reports connection failures clearly", () => {
  assert.equal(
    dashboard.resolveAssistantEndpoint({ hostname: "127.0.0.1", port: "5500" }),
    "https://stampnote-omega.vercel.app/api/assistant",
  );
  assert.equal(
    dashboard.resolveAssistantEndpoint({ hostname: "stampnote-omega.vercel.app", port: "" }),
    "/api/assistant",
  );
  assert.equal(
    dashboard.describeAssistantError(
      new TypeError("Failed to fetch"),
      "https://stampnote-omega.vercel.app/api/assistant",
    ),
    "The Operations AI API is not deployed or could not be reached.",
  );
});

test("coordinate questions return a grounded inline map and safe deep links", () => {
  const knowledge = knowledgeFixture();
  const request = dashboard.createAssistantPayload(
    "Show the map between the photo GPS and truck location, then open the record.",
    [],
    knowledge,
  );
  const map = dashboard.inlineMapForQuestion(request.payload.question, request.sources);
  const actions = dashboard.navigationActions(request.payload.question, request.sources);
  const geometry = dashboard.comparisonMapGeometry(map);

  assert.equal(map.reference.sourcePhotoId, "photo-1");
  assert.equal(map.truck.longitude, 103.8645);
  assert.equal(map.flaggedForReview, true);
  assert.ok(Number.isFinite(geometry.reference.x));
  assert.ok(Number.isFinite(geometry.truck.y));
  assert.ok(actions.some((action) => action.href.startsWith("coordinates.html?session=")));
  assert.ok(actions.some((action) => action.href.includes("admin.html?")));
  assert.equal(Object.hasOwn(request.payload.facts[0], "map"), false);
  assert.equal(Object.hasOwn(request.payload.facts[0], "session"), false);
  assert.match(source, /createInlineLocationMap/);
  assert.match(css, /\.ai-inline-map-marker-truck circle/);
});

test("flag queries automatically show a real GPS and truck discrepancy map", () => {
  const knowledge = knowledgeFixture();
  const request = dashboard.createAssistantPayload(
    "Which sessions are flagged?",
    [],
    knowledge,
  );
  const map = dashboard.inlineMapForQuestion(request.payload.question, request.sources);

  assert.equal(map.flaggedForReview, true);
  assert.equal(map.reference.sourcePhotoId, "photo-1");
  assert.equal(
    dashboard.inlineMapForQuestion("Show the flagging", [
      { map: { flaggedForReview: false, reference: { sourcePhotoId: "photo-safe" } } },
    ]),
    null,
  );
});

test("assistant links reveal the requested record and section on destination pages", () => {
  assert.match(adminSource, /function applyNavigationRequest\(scope\)/);
  assert.match(adminSource, /target\.scrollIntoView/);
  assert.match(coordinatesSource, /function revealRequestedSession\(\)/);
  assert.match(coordinatesSource, /entry\.dataset\.sessionKey === requestedSessionKey/);
});

test("the page sits on slow drifting colour rather than a flat plane", () => {
  // Two layers, moving against each other: one alone reads as the whole page
  // sliding, two read as weather.
  assert.match(css, /:root::after,\s+body::after\s*\{[^}]*position:\s*fixed/);
  assert.match(css, /:root::after\s*\{[^}]*animation:\s*ai-blotch-drift-a/);
  assert.match(css, /body::after\s*\{[^}]*animation:\s*ai-blotch-drift-b/);
  assert.match(css, /@keyframes ai-blotch-drift-a/);
  assert.match(css, /@keyframes ai-blotch-drift-b/);

  // Behind the grid, and far enough oversized that no edge enters frame.
  assert.match(css, /:root::after,\s+body::after\s*\{[^}]*z-index:\s*-2/);
  assert.match(css, /:root::after,\s+body::after\s*\{[^}]*inset:\s*-35%/);
  assert.match(css, /body::before\s*\{[^}]*z-index:\s*-1/);

  // Transform only: no repaint, and the colour comes from the theme's own
  // soft tokens so it swaps with the palette rather than being hard-coded.
  assert.match(css, /@keyframes ai-blotch-drift-a\s*\{[\s\S]*?transform: translate3d/);
  // Bounded to the block itself: an unbounded lazy match would run past it and
  // find the composer shimmer's own background-position.
  const driftBlock = css.slice(
    css.indexOf("@keyframes ai-blotch-drift-a"),
    css.indexOf("body::before {"),
  );
  assert.doesNotMatch(driftBlock, /background|filter|opacity/);
  assert.match(css, /:root::after\s*\{[^}]*var\(--ai-accent-soft\)/);

  // Asked to be still, they rest where they start.
  assert.match(
    css,
    /prefers-reduced-motion: reduce[\s\S]*?:root::after,\s+body::after,[\s\S]*?animation: none !important/,
  );
});

// The smallest document the renderer needs: it builds nodes through the
// container's own owner, so a plain object is enough to read the result.
function fakeNode(tag) {
  const node = {
    tagName: tag,
    className: "",
    children: [],
    text: "",
    ownerDocument: null,
    append(...parts) {
      parts.forEach((part) => node.children.push(part));
    },
    replaceChildren() {
      node.children = [];
    },
    get childElementCount() {
      return node.children.filter((child) => child && child.tagName).length;
    },
    set textContent(value) {
      node.text = String(value);
      node.children = [];
    },
    get textContent() {
      return node.children.length === 0
        ? node.text
        : node.children.map((child) => (child?.tagName ? child.textContent : String(child))).join("");
    },
  };
  node.ownerDocument = {
    createElement: (name) => fakeNode(name),
    createTextNode: (value) => String(value),
  };
  return node;
}

function shape(node) {
  return node.children.map((child) =>
    child?.tagName ? { tag: child.tagName, text: child.textContent, className: child.className } : child,
  );
}

test("an answer is rendered as blocks, never as markup from the model", () => {
  const container = fakeNode("div");
  dashboard.renderAnswer(
    container,
    "On the most recent date, 2026-08-17, attendance was recorded for one worker:\n\n" +
      "*   **Ernest (ER-0001):** 2 check-ins [S3, S4, S8].\n" +
      "*   **Bo Lim (BL-0002):** 1 check-in [S9].\n\n" +
      "To inspect these records, use the verified link on your dashboard.",
  );

  const blocks = shape(container);
  assert.deepEqual(
    blocks.map((block) => block.tag),
    ["p", "ul", "p"],
  );

  // The bullets became list items, and the leading "*   " is gone from the text.
  const list = container.children[1];
  assert.equal(list.children.length, 2);
  assert.match(list.children[0].textContent, /^Ernest \(ER-0001\):/);

  // The bold run is an element, not asterisks left in the sentence.
  const firstItem = list.children[0];
  assert.equal(firstItem.children[0].tagName, "strong");
  assert.equal(firstItem.children[0].textContent, "Ernest (ER-0001):");
  assert.doesNotMatch(container.textContent, /\*\*|^\*\s/m);

  // The markers become chips, one per retrieved fact.
  const citations = firstItem.children.find((child) => child?.className === "ai-citations");
  assert.ok(citations, "the [S3, S4, S8] marker became chips");
  assert.deepEqual(
    citations.children.map((chip) => chip.textContent),
    ["S3", "S4", "S8"],
  );
});

test("the renderer never lets a model's text become markup", () => {
  const container = fakeNode("div");
  dashboard.renderAnswer(container, "A worker <img src=x onerror=alert(1)> and `code` and **bold**.");

  // Angle brackets survive as characters, because every part is inserted as a
  // text node or an element's textContent — there is no HTML path in or out.
  assert.match(container.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(
    container.children[0].children.some((child) => child?.tagName === "img"),
    false,
  );
  assert.match(source, /createTextNode/);
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML/);

  // A single break inside a block is the model's line width, not a paragraph.
  const wrapped = fakeNode("div");
  dashboard.renderAnswer(wrapped, "one line\nand its continuation");
  assert.equal(wrapped.children.length, 1);
  assert.equal(wrapped.children[0].textContent, "one line and its continuation");

  // Numbered lists get an ordered list; empty input leaves nothing behind.
  const numbered = fakeNode("div");
  dashboard.renderAnswer(numbered, "1. first\n2. second");
  assert.equal(numbered.children[0].tagName, "ol");
  assert.equal(numbered.children[0].children.length, 2);
});

test("the composer carries a shimmer around its ring, not under its text", () => {
  // Masked to the 1.5px band, so the field underneath stays flat and the text
  // on it never sits on a moving gradient.
  assert.match(css, /\.ai-chat-form::before\s*\{[^}]*mask-composite:\s*exclude/);
  assert.match(css, /\.ai-chat-form::before\s*\{[^}]*-webkit-mask-composite:\s*xor/);
  assert.match(css, /\.ai-chat-form::before\s*\{[^}]*animation:\s*ai-composer-shimmer/);
  assert.match(css, /@keyframes ai-composer-shimmer/);
  assert.match(css, /\.ai-chat-form\s*\{[^}]*position:\s*relative/);

  // Writing brightens it; waiting on an answer makes it travel. The busy flag
  // is the one the form already sets for assistive technology.
  assert.match(css, /\.ai-chat-form:focus-within::before\s*\{[^}]*opacity/);
  assert.match(css, /\.ai-chat-form\[aria-busy="true"\]::before\s*\{[^}]*animation-duration/);
  assert.match(source, /form\.setAttribute\("aria-busy", String\(asking\)\)/);
});

test("the transcript reads as a conversation rather than two columns of boxes", () => {
  // The reader's turn is a bubble; the assistant's is the page itself.
  assert.match(css, /\.ai-message-user\s*\{[^}]*border-radius:\s*20px/);
  assert.match(css, /\.ai-message-assistant\s*\{[^}]*background:\s*transparent/);
  assert.match(css, /\.ai-message-assistant\s*\{[^}]*border:\s*0/);
  assert.match(css, /\.ai-message-assistant\s*\{[^}]*box-shadow:\s*none/);

  // An error is the one assistant turn that keeps a box: it is not an answer.
  assert.match(css, /\.ai-message-assistant\[data-state="error"\]\s*\{[^}]*border:\s*1px solid/);

  // The reader's own turn is placed and coloured already; naming it inside its
  // own bubble is one label too many.
  assert.match(css, /\.ai-message-user \.ai-message-label\s*\{\s*display:\s*none/);
});

test("the dashboard has eased entrances, responsive chat, dark mode, and reduced motion", () => {
  assert.match(css, /:root\[data-theme="dark"\]/);
  assert.match(css, /\.ai-workspace\s*\{[^}]*grid-template-columns:/);
  assert.match(css, /animation: ai-panel-right-enter 820ms var\(--ai-ease\) 260ms both/);
  assert.match(css, /\.ai-message-row\s*\{[^}]*animation: ai-message-enter/);
  assert.match(css, /@media \(max-width: 980px\)[\s\S]*\.ai-workspace\s*\{\s*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*?\.ai-chat-panel,[\s\S]*?animation: none !important/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*?\.ai-inline-map,[\s\S]*?animation: none !important/);
});

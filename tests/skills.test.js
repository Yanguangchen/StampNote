const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const root = resolve(__dirname, "..");
const skillsHtml = readFileSync(resolve(root, "skills.html"), "utf8");
const skillsCss = readFileSync(resolve(root, "skills.css"), "utf8");
const skillsJs = readFileSync(resolve(root, "skills.js"), "utf8");
const skillsMd = readFileSync(resolve(root, "skills.md"), "utf8");
const sidebarJs = readFileSync(resolve(root, "sidebar.js"), "utf8");
const sidebarCss = readFileSync(resolve(root, "sidebar.css"), "utf8");
const serverJs = readFileSync(resolve(root, "server.js"), "utf8");

function loadSkillsEngine() {
  const context = { globalThis: {}, console };
  context.window = context.globalThis;
  vm.createContext(context);
  vm.runInContext(skillsJs, context);
  return context.globalThis.StampNoteSkills;
}

test("skills.html has complete metadata, stylesheets, semantic structure and download controls", () => {
  assert.match(skillsHtml, /<!doctype html>/i);
  assert.match(skillsHtml, /<html\s+lang="en"\s+data-surface="skills"/);
  assert.match(skillsHtml, /<title>Skills &amp; Playbook · StampNote<\/title>/);
  assert.match(skillsHtml, /<link rel="stylesheet" href="sidebar\.css" \/>/);
  assert.match(skillsHtml, /<link rel="stylesheet" href="skills\.css" \/>/);
  assert.match(skillsHtml, /<header\s+class="skills-header"\s+data-sidebar-mount>/);
  assert.match(skillsHtml, /<script src="skills\.js" defer><\/script>/);
  assert.match(skillsHtml, /<script src="sidebar\.js" defer><\/script>/);

  // Dedicated download controls
  assert.match(skillsHtml, /id="btn-download-header"[^>]*href="skills\.md"[^>]*download="skills\.md"/);
  assert.match(skillsHtml, /id="hero-download-btn"[^>]*href="skills\.md"[^>]*download="skills\.md"/);

  // Copy buttons
  assert.match(skillsHtml, /id="btn-copy-header"/);
  assert.match(skillsHtml, /id="hero-copy-btn"/);

  // View switchers
  assert.match(skillsHtml, /id="btn-view-rendered"/);
  assert.match(skillsHtml, /id="btn-view-raw"/);

  // Search input
  assert.match(skillsHtml, /id="skills-search-input"/);

  // Content containers
  assert.match(skillsHtml, /id="skills-rendered-doc"/);
  assert.match(skillsHtml, /id="skills-raw-doc"/);
  assert.match(skillsHtml, /id="toc-list"/);
});

test("skills.md is registered as a public static asset in server.js alongside html, css and js", () => {
  assert.match(serverJs, /"skills\.html"/);
  assert.match(serverJs, /"skills\.css"/);
  assert.match(serverJs, /"skills\.js"/);
  assert.match(serverJs, /"skills\.md"/);
});

test("sidebar.js places a small skills.md button with icon at the side toolbar footer, not as a workspace page item", () => {
  // Must NOT be in the main GROUPS page list
  assert.doesNotMatch(sidebarJs, /pages:\s*\[[\s\S]*?file:\s*"skills\.html"/);

  // Must be in the sidebar footer/utility section
  assert.match(sidebarJs, /className = "sidebar-skills-button"/);
  assert.match(sidebarJs, /href = "skills\.html"/);
  assert.match(sidebarJs, /className = "sidebar-skills-icon"/);
  assert.match(sidebarJs, /className = "sidebar-skills-label"/);
  assert.match(sidebarJs, /skillsLabel\.textContent = "skills\.md"/);

  // Sidebar CSS must style the button and icon
  assert.match(sidebarCss, /\.sidebar-skills-button/);
  assert.match(sidebarCss, /\.sidebar-skills-icon/);
  assert.match(sidebarCss, /\.sidebar-skills-label/);
});

test("StampNoteSkills parser extracts frontmatter, headings, tables, code blocks and checklists", () => {
  const engine = loadSkillsEngine();
  assert.ok(engine);

  const sampleMarkdown = `---
name: test-playbook
description: "A test specification."
---

# Main Title

Introductory text with **bold**, *italic*, \`inline code\`, and [link](https://example.com).

## Section One

- [ ] Task 1
- [x] Task 2 completed

| Column A | Column B |
| --- | --- |
| Val 1 | Val 2 |

\`\`\`json
{ "status": "ok" }
\`\`\`

> [!NOTE]
> Important operational note.
`;

  const parsed = engine.parseMarkdown(sampleMarkdown);

  assert.equal(parsed.metadata.name, "test-playbook");
  assert.equal(parsed.metadata.description, "A test specification.");

  // Headings & TOC
  assert.equal(parsed.toc.length, 2);
  assert.equal(parsed.toc[0].text, "Main Title");
  assert.equal(parsed.toc[0].id, "main-title");
  assert.equal(parsed.toc[1].text, "Section One");
  assert.equal(parsed.toc[1].id, "section-one");

  // HTML content
  assert.match(parsed.html, /<h1 id="main-title"><a class="heading-anchor" href="#main-title"/);
  assert.match(parsed.html, /<strong>bold<\/strong>/);
  assert.match(parsed.html, /<em>italic<\/em>/);
  assert.match(parsed.html, /<code>inline code<\/code>/);
  assert.match(parsed.html, /<a href="https:\/\/example\.com"/);

  // Checklists
  assert.match(parsed.html, /<li class="task-list-item"><input type="checkbox" class="task-checkbox"/);
  assert.match(parsed.html, /checked/);

  // Tables
  assert.match(parsed.html, /<div class="table-wrapper"><table><thead><tr><th>Column A<\/th><th>Column B<\/th>/);
  assert.match(parsed.html, /<td>Val 1<\/td><td>Val 2<\/td>/);

  // Code blocks
  assert.match(parsed.html, /<div class="code-block-wrapper">/);
  assert.match(parsed.html, /<span class="code-block-lang">json<\/span>/);
  assert.match(parsed.html, /<code class="language-json">\{ &quot;status&quot;: &quot;ok&quot; \}<\/code>/);

  // Callouts
  assert.match(parsed.html, /<div class="callout callout-note">/);
  assert.match(parsed.html, /<strong>NOTE<\/strong>/);
});

test("StampNoteSkills parses repo skills.md completely with accurate sections and statistics", () => {
  const engine = loadSkillsEngine();
  const parsed = engine.parseMarkdown(skillsMd);

  assert.equal(parsed.metadata.name, "stampnote-platform");
  assert.ok(parsed.stats.wordCount > 3000, "word count should be > 3000");
  assert.ok(parsed.stats.readingTimeMinutes >= 10, "reading time should be calculated");
  assert.ok(parsed.toc.length >= 10, "TOC should contain all major sections");

  const tocTitles = parsed.toc.map((t) => t.text);
  assert.ok(tocTitles.includes("StampNote platform"));
  assert.ok(tocTitles.includes("Sign in (Google / Gmail)"));
  assert.ok(tocTitles.includes("Token doctrine"));
  assert.ok(tocTitles.includes("Origins and pages"));
  assert.ok(tocTitles.includes("Default workflow"));
  assert.ok(tocTitles.includes("Operations AI protocol"));

  // Check that all tables and JSON blocks in skills.md were rendered
  assert.match(parsed.html, /<table/);
  assert.match(parsed.html, /Coordinate entry/);
  assert.match(parsed.html, /Geographic Surveillence/);
  assert.match(parsed.html, /code-block-wrapper/);
});

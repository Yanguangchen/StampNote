/* ==========================================================================
   StampNote Platform Skills & Playbook Engine (skills.js)
   ========================================================================== */

(function initializeSkillsPage(globalScope) {
  "use strict";

  const THEME_KEY = "stampnote-theme";

  // ---------------------------------------------------------------------------
  // 1. Markdown Parsing & Rendering Engine
  // ---------------------------------------------------------------------------

  function escapeHtml(text) {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function slugify(text) {
    return String(text || "")
      .toLowerCase()
      .trim()
      .replace(/<[^>]+>/g, "")
      .replace(/[^a-z0-9\s-_]/g, "")
      .replace(/[\s_]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function parseFrontmatter(rawText) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(rawText);
    if (!match) {
      return { metadata: {}, content: rawText };
    }

    const yamlBlock = match[1];
    const content = rawText.slice(match[0].length);
    const metadata = {};

    yamlBlock.split(/\r?\n/).forEach((line) => {
      const parts = line.split(":");
      if (parts.length >= 2) {
        const key = parts[0].trim();
        let value = parts.slice(1).join(":").trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        metadata[key] = value;
      }
    });

    return { metadata, content };
  }

  function renderInline(text) {
    let result = escapeHtml(text);

    // Inline code: `code`
    result = result.replace(/`([^`]+)`/g, "<code>$1</code>");

    // Bold: **text** or __text__
    result = result.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    result = result.replace(/__([^_]+)__/g, "<strong>$1</strong>");

    // Strikethrough: ~~text~~
    result = result.replace(/~~([^~]+)~~/g, "<del>$1</del>");

    // Italic: *text* or _text_
    result = result.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    result = result.replace(/(^|[^a-zA-Z0-9_])_([^_]+)_(?![a-zA-Z0-9_])/g, "$1<em>$2</em>");

    // Links: [label](url)
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, url) => {
      const isInternal = url.startsWith("#");
      const targetAttr = isInternal ? "" : ' target="_blank" rel="noopener noreferrer"';
      return `<a href="${url}"${targetAttr}>${label}</a>`;
    });

    // Autolinks: http:// or https://
    result = result.replace(
      /(^|[\s(])(https?:\/\/[^\s)<]+)/g,
      '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>',
    );

    return result;
  }

  function parseMarkdown(rawMarkdown) {
    const { metadata, content } = parseFrontmatter(rawMarkdown);
    const lines = content.replace(/\r\n/g, "\n").split("\n");

    const codeBlocks = [];
    const tables = [];
    const toc = [];
    const usedSlugs = new Set();

    let inCodeBlock = false;
    let codeLang = "";
    let codeContent = [];

    let processedLines = [];

    // Pass 1: Extract Fenced Code Blocks
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const codeStart = /^```([a-zA-Z0-9_-]*)/.exec(line);

      if (!inCodeBlock && codeStart) {
        inCodeBlock = true;
        codeLang = codeStart[1] || "text";
        codeContent = [];
        continue;
      }

      if (inCodeBlock && line.trim() === "```") {
        inCodeBlock = false;
        const index = codeBlocks.length;
        codeBlocks.push({
          lang: codeLang,
          code: codeContent.join("\n"),
        });
        processedLines.push(`%%CODE_BLOCK_${index}%%`);
        continue;
      }

      if (inCodeBlock) {
        codeContent.push(line);
      } else {
        processedLines.push(line);
      }
    }

    // Pass 2: Extract Tables
    const afterTableLines = [];
    let inTable = false;
    let tableRows = [];

    for (let i = 0; i < processedLines.length; i++) {
      const line = processedLines[i];
      const isTableRow = /^\|(.+)\|$/.test(line.trim());

      if (isTableRow) {
        inTable = true;
        tableRows.push(line.trim());
        continue;
      }

      if (inTable && !isTableRow) {
        inTable = false;
        const index = tables.length;
        tables.push(tableRows);
        afterTableLines.push(`%%TABLE_${index}%%`);
        tableRows = [];
      }

      afterTableLines.push(line);
    }

    if (inTable && tableRows.length > 0) {
      const index = tables.length;
      tables.push(tableRows);
      afterTableLines.push(`%%TABLE_${index}%%`);
    }

    // Pass 3: Process Blocks (Headings, Lists, Quotes, Paragraphs)
    const blocksHtml = [];
    let inList = false;
    let listType = "ul";
    let inQuote = false;
    let quoteLines = [];
    let currentParagraph = [];

    function flushParagraph() {
      if (currentParagraph.length > 0) {
        const text = currentParagraph.join(" ").trim();
        if (text) {
          blocksHtml.push(`<p>${renderInline(text)}</p>`);
        }
        currentParagraph = [];
      }
    }

    function flushList() {
      if (inList) {
        blocksHtml.push(`</${listType}>`);
        inList = false;
      }
    }

    function flushQuote() {
      if (inQuote) {
        const fullQuote = quoteLines.join("\n");
        const alertMatch = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\s*\n)?([\s\S]*)/i.exec(
          fullQuote,
        );

        if (alertMatch) {
          const type = alertMatch[1].toLowerCase();
          const alertBody = alertMatch[2];
          const calloutClass =
            type === "warning" || type === "caution"
              ? "callout-warning"
              : type === "important"
                ? "callout-important"
                : "callout-note";

          const calloutIcon =
            type === "warning" || type === "caution"
              ? '<svg class="callout-icon" viewBox="0 0 24 24"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>'
              : '<svg class="callout-icon" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>';

          blocksHtml.push(
            `<div class="callout ${calloutClass}">${calloutIcon}<div class="callout-body"><strong>${alertMatch[1].toUpperCase()}</strong>${renderInline(alertBody)}</div></div>`,
          );
        } else {
          blocksHtml.push(`<blockquote><p>${renderInline(fullQuote)}</p></blockquote>`);
        }

        quoteLines = [];
        inQuote = false;
      }
    }

    for (let i = 0; i < afterTableLines.length; i++) {
      const line = afterTableLines[i];
      const trimmed = line.trim();

      // Empty line
      if (!trimmed) {
        flushParagraph();
        flushList();
        flushQuote();
        continue;
      }

      // Code Block Placeholder
      const codeMatch = /^%%CODE_BLOCK_(\d+)%%$/.exec(trimmed);
      if (codeMatch) {
        flushParagraph();
        flushList();
        flushQuote();
        const block = codeBlocks[Number(codeMatch[1])];
        const lang = block.lang || "text";
        const escaped = escapeHtml(block.code);
        blocksHtml.push(
          `<div class="code-block-wrapper"><div class="code-block-header"><span class="code-block-lang">${escapeHtml(lang)}</span><button class="code-copy-btn" type="button" aria-label="Copy code block" title="Copy code"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg><span>Copy</span></button></div><pre><code class="language-${escapeHtml(lang)}">${escaped}</code></pre></div>`,
        );
        continue;
      }

      // Table Placeholder
      const tableMatch = /^%%TABLE_(\d+)%%$/.exec(trimmed);
      if (tableMatch) {
        flushParagraph();
        flushList();
        flushQuote();
        const rows = tables[Number(tableMatch[1])];
        if (rows.length >= 2) {
          const headerCells = rows[0]
            .slice(1, -1)
            .split("|")
            .map((c) => c.trim());
          const bodyRows = rows.slice(2);

          let tableHtml = '<div class="table-wrapper"><table><thead><tr>';
          headerCells.forEach((c) => {
            tableHtml += `<th>${renderInline(c)}</th>`;
          });
          tableHtml += "</tr></thead><tbody>";

          bodyRows.forEach((r) => {
            const cells = r
              .slice(1, -1)
              .split("|")
              .map((c) => c.trim());
            tableHtml += "<tr>";
            cells.forEach((c) => {
              tableHtml += `<td>${renderInline(c)}</td>`;
            });
            tableHtml += "</tr>";
          });

          tableHtml += "</tbody></table></div>";
          blocksHtml.push(tableHtml);
        }
        continue;
      }

      // Horizontal Rule
      if (/^(\*\*\*|---|___)$/.test(trimmed)) {
        flushParagraph();
        flushList();
        flushQuote();
        blocksHtml.push("<hr />");
        continue;
      }

      // Headings
      const headingMatch = /^(#{1,6})\s+(.*)$/.exec(trimmed);
      if (headingMatch) {
        flushParagraph();
        flushList();
        flushQuote();
        const level = headingMatch[1].length;
        const titleText = headingMatch[2].trim();
        let slug = slugify(titleText) || `heading-${toc.length + 1}`;

        if (usedSlugs.has(slug)) {
          let count = 1;
          while (usedSlugs.has(`${slug}-${count}`)) {
            count++;
          }
          slug = `${slug}-${count}`;
        }
        usedSlugs.add(slug);

        toc.push({
          id: slug,
          text: titleText.replace(/`([^`]+)`/g, "$1"),
          level,
        });

        blocksHtml.push(
          `<h${level} id="${slug}"><a class="heading-anchor" href="#${slug}" aria-label="Direct link to section">#</a>${renderInline(titleText)}</h${level}>`,
        );
        continue;
      }

      // Blockquotes
      if (trimmed.startsWith(">")) {
        flushParagraph();
        flushList();
        inQuote = true;
        quoteLines.push(trimmed.replace(/^>\s?/, ""));
        continue;
      }

      // Task Checklists
      const taskMatch = /^[-*]\s+\[([ xX])\]\s+(.*)$/.exec(trimmed);
      if (taskMatch) {
        flushParagraph();
        flushQuote();
        if (!inList || listType !== "ul") {
          flushList();
          inList = true;
          listType = "ul";
          blocksHtml.push('<ul class="task-list">');
        }
        const checked = taskMatch[1].toLowerCase() === "x";
        const taskText = taskMatch[2];
        blocksHtml.push(
          `<li class="task-list-item"><input type="checkbox" class="task-checkbox"${checked ? " checked" : ""} disabled aria-label="Task item" /><span class="task-text">${renderInline(taskText)}</span></li>`,
        );
        continue;
      }

      // Unordered Lists
      const ulMatch = /^[-*]\s+(.*)$/.exec(trimmed);
      if (ulMatch) {
        flushParagraph();
        flushQuote();
        if (!inList || listType !== "ul") {
          flushList();
          inList = true;
          listType = "ul";
          blocksHtml.push("<ul>");
        }
        blocksHtml.push(`<li>${renderInline(ulMatch[1])}</li>`);
        continue;
      }

      // Ordered Lists
      const olMatch = /^\d+\.\s+(.*)$/.exec(trimmed);
      if (olMatch) {
        flushParagraph();
        flushQuote();
        if (!inList || listType !== "ol") {
          flushList();
          inList = true;
          listType = "ol";
          blocksHtml.push("<ol>");
        }
        blocksHtml.push(`<li>${renderInline(olMatch[1])}</li>`);
        continue;
      }

      // Regular paragraph line
      currentParagraph.push(trimmed);
    }

    flushParagraph();
    flushList();
    flushQuote();

    const wordCount = rawMarkdown.trim().split(/\s+/).filter(Boolean).length;
    const readingTimeMinutes = Math.max(1, Math.ceil(wordCount / 220));

    return {
      metadata,
      html: blocksHtml.join("\n"),
      toc,
      stats: {
        wordCount,
        readingTimeMinutes,
        lineCount: lines.length,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // 2. UI Component Wiring
  // ---------------------------------------------------------------------------

  let currentRawMarkdown = "";
  let searchMatches = [];
  let currentSearchIndex = -1;

  function showToast(message) {
    const toast = document.querySelector("#skills-toast");
    if (!toast) return;

    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(() => {
      toast.hidden = true;
    }, 2800);
  }

  function setupReadingProgress() {
    const bar = document.querySelector("#reading-progress");
    if (!bar) return;

    function updateProgress() {
      const scrollY = window.scrollY || document.documentElement.scrollTop;
      const totalHeight = document.documentElement.scrollHeight - window.innerHeight;
      const percent = totalHeight > 0 ? Math.min(100, Math.max(0, (scrollY / totalHeight) * 100)) : 0;
      bar.style.width = `${percent}%`;
    }

    window.addEventListener("scroll", updateProgress, { passive: true });
    updateProgress();
  }

  function setupTOC(tocEntries) {
    const list = document.querySelector("#toc-list");
    const toggle = document.querySelector("#toc-collapse-toggle");
    const nav = document.querySelector("#toc-nav");

    if (!list) return;
    list.innerHTML = "";

    tocEntries.forEach((entry) => {
      // Include h1, h2, h3
      if (entry.level > 3) return;

      const item = document.createElement("li");
      item.className = `toc-item level-${entry.level}`;
      item.dataset.headingId = entry.id;

      const link = document.createElement("a");
      link.className = "toc-link";
      link.href = `#${entry.id}`;
      link.textContent = entry.text;

      link.addEventListener("click", (event) => {
        event.preventDefault();
        const target = document.getElementById(entry.id);
        if (target) {
          target.scrollIntoView({ behavior: "smooth", block: "start" });
          history.pushState(null, "", `#${entry.id}`);
        }
      });

      item.append(link);
      list.append(item);
    });

    if (toggle && nav) {
      toggle.addEventListener("click", () => {
        const expanded = toggle.getAttribute("aria-expanded") === "true";
        toggle.setAttribute("aria-expanded", String(!expanded));
        nav.hidden = expanded;
      });
    }

    // Scroll spy
    const headings = tocEntries
      .map((e) => document.getElementById(e.id))
      .filter(Boolean);

    if ("IntersectionObserver" in window && headings.length > 0) {
      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              const id = entry.target.id;
              document.querySelectorAll(".toc-item").forEach((item) => {
                item.classList.toggle("is-active", item.dataset.headingId === id);
              });
            }
          });
        },
        { rootMargin: "-80px 0px -70% 0px" },
      );

      headings.forEach((h) => observer.observe(h));
    }
  }

  function setupCodeBlockCopy() {
    document.querySelectorAll(".code-copy-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const wrapper = btn.closest(".code-block-wrapper");
        const codeElement = wrapper?.querySelector("code");
        if (!codeElement) return;

        try {
          await navigator.clipboard.writeText(codeElement.textContent || "");
          btn.classList.add("is-copied");
          const originalText = btn.querySelector("span")?.textContent || "Copy";
          if (btn.querySelector("span")) btn.querySelector("span").textContent = "Copied!";
          setTimeout(() => {
            btn.classList.remove("is-copied");
            if (btn.querySelector("span")) btn.querySelector("span").textContent = originalText;
          }, 2000);
          showToast("✓ Copied code snippet to clipboard");
        } catch {
          showToast("Failed to copy code snippet");
        }
      });
    });
  }

  function setupViewToggle() {
    const btnRendered = document.querySelector("#btn-view-rendered");
    const btnRaw = document.querySelector("#btn-view-raw");
    const renderedDoc = document.querySelector("#skills-rendered-doc");
    const rawDoc = document.querySelector("#skills-raw-doc");

    if (!btnRendered || !btnRaw || !renderedDoc || !rawDoc) return;

    function setView(mode) {
      const isRendered = mode === "rendered";
      btnRendered.classList.toggle("is-active", isRendered);
      btnRendered.setAttribute("aria-pressed", String(isRendered));
      btnRaw.classList.toggle("is-active", !isRendered);
      btnRaw.setAttribute("aria-pressed", String(!isRendered));

      renderedDoc.hidden = !isRendered;
      rawDoc.hidden = isRendered;
    }

    btnRendered.addEventListener("click", () => setView("rendered"));
    btnRaw.addEventListener("click", () => setView("raw"));
  }

  function setupSearch() {
    const input = document.querySelector("#skills-search-input");
    const clearBtn = document.querySelector("#search-clear-btn");
    const controls = document.querySelector("#search-nav-controls");
    const countLabel = document.querySelector("#search-match-count");
    const btnPrev = document.querySelector("#search-btn-prev");
    const btnNext = document.querySelector("#search-btn-next");
    const container = document.querySelector("#skills-rendered-doc");

    if (!input || !container) return;

    function clearHighlights() {
      container.querySelectorAll("mark.skills-highlight").forEach((mark) => {
        const parent = mark.parentNode;
        parent.replaceChild(document.createTextNode(mark.textContent || ""), mark);
        parent.normalize();
      });
      searchMatches = [];
      currentSearchIndex = -1;
      if (controls) controls.hidden = true;
      if (clearBtn) clearBtn.hidden = true;
    }

    function highlightText(query) {
      clearHighlights();
      if (!query || query.length < 2) return;

      const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
      const textNodes = [];

      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (
          node.parentElement &&
          !node.parentElement.closest("pre") &&
          !node.parentElement.closest(".code-block-wrapper") &&
          regex.test(node.textContent || "")
        ) {
          textNodes.push(node);
        }
      }

      textNodes.forEach((node) => {
        const text = node.textContent || "";
        const span = document.createElement("span");
        span.innerHTML = text.replace(regex, '<mark class="skills-highlight">$1</mark>');
        node.parentNode?.replaceChild(span, node);
      });

      searchMatches = Array.from(container.querySelectorAll("mark.skills-highlight"));

      if (controls && countLabel) {
        controls.hidden = searchMatches.length === 0;
        countLabel.textContent = `${searchMatches.length} match${searchMatches.length === 1 ? "" : "es"}`;
      }
      if (clearBtn) clearBtn.hidden = false;

      if (searchMatches.length > 0) {
        goToMatch(0);
      }
    }

    function goToMatch(index) {
      if (searchMatches.length === 0) return;
      currentSearchIndex = (index + searchMatches.length) % searchMatches.length;

      searchMatches.forEach((m, idx) => {
        m.classList.toggle("is-current", idx === currentSearchIndex);
      });

      const current = searchMatches[currentSearchIndex];
      if (current) {
        current.scrollIntoView({ behavior: "smooth", block: "center" });
      }

      if (countLabel) {
        countLabel.textContent = `${currentSearchIndex + 1} of ${searchMatches.length}`;
      }
    }

    input.addEventListener("input", () => {
      highlightText(input.value.trim());
    });

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        goToMatch(event.shiftKey ? currentSearchIndex - 1 : currentSearchIndex + 1);
      } else if (event.key === "Escape") {
        input.value = "";
        clearHighlights();
      }
    });

    clearBtn?.addEventListener("click", () => {
      input.value = "";
      clearHighlights();
      input.focus();
    });

    btnNext?.addEventListener("click", () => goToMatch(currentSearchIndex + 1));
    btnPrev?.addEventListener("click", () => goToMatch(currentSearchIndex - 1));

    // Global keyboard shortcut: '/' focuses search
    document.addEventListener("keydown", (event) => {
      if (
        event.key === "/" &&
        document.activeElement?.tagName !== "INPUT" &&
        document.activeElement?.tagName !== "TEXTAREA"
      ) {
        event.preventDefault();
        input.focus();
        input.select();
      }
    });
  }

  function setupThemeToggle() {
    const themeToggle = document.querySelector("#theme-toggle");
    const themeIcon = document.querySelector("#theme-toggle-icon");
    const themeLabel = document.querySelector("#theme-toggle-label");
    const darkScheme = window.matchMedia?.("(prefers-color-scheme: dark)");

    function isDark() {
      const pinned = document.documentElement.dataset.theme;
      if (pinned === "dark") return true;
      if (pinned === "light") return false;
      return darkScheme?.matches || false;
    }

    function syncThemeUI() {
      const dark = isDark();
      themeToggle?.setAttribute("aria-pressed", String(dark));
      themeToggle?.setAttribute("title", dark ? "Switch to light theme" : "Switch to dark theme");
      if (themeIcon) themeIcon.textContent = dark ? "☀" : "☾";
      if (themeLabel) themeLabel.textContent = dark ? "Light" : "Dark";
    }

    function toggle() {
      const next = isDark() ? "light" : "dark";
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {}
      document.documentElement.dataset.theme = next;
      syncThemeUI();
    }

    themeToggle?.addEventListener("click", toggle);
    darkScheme?.addEventListener?.("change", syncThemeUI);
    syncThemeUI();
  }

  function setupActions() {
    // Download Action (via Blob or fallback)
    function downloadMarkdownFile() {
      if (!currentRawMarkdown) return;
      const blob = new Blob([currentRawMarkdown], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "skills.md";
      document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast("✓ Downloaded skills.md");
    }

    document.querySelectorAll("#hero-download-btn, #btn-download-header").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        if (currentRawMarkdown) {
          event.preventDefault();
          downloadMarkdownFile();
        }
      });
    });

    // Copy Raw Markdown
    async function copyRawMarkdown() {
      if (!currentRawMarkdown) return;
      try {
        await navigator.clipboard.writeText(currentRawMarkdown);
        showToast("✓ Copied skills.md to clipboard");
      } catch {
        showToast("Clipboard write permission denied");
      }
    }

    document.querySelectorAll("#hero-copy-btn, #btn-copy-header, #raw-doc-copy-btn").forEach((btn) => {
      btn.addEventListener("click", copyRawMarkdown);
    });

    // Print / Export
    document.querySelector("#hero-print-btn")?.addEventListener("click", () => {
      window.print();
    });
  }

  async function loadAndRender() {
    const renderedDoc = document.querySelector("#skills-rendered-doc");
    const rawCode = document.querySelector("#raw-doc-code");
    const rawLines = document.querySelector("#raw-doc-line-count");
    const metaWords = document.querySelector("#meta-words");
    const metaReadTime = document.querySelector("#meta-read-time");
    const metaName = document.querySelector("#meta-name");

    try {
      const response = await fetch("skills.md");
      if (!response.ok) {
        throw new Error(`Failed to load skills.md (${response.status} ${response.statusText})`);
      }
      currentRawMarkdown = await response.text();

      const parsed = parseMarkdown(currentRawMarkdown);

      if (renderedDoc) {
        renderedDoc.innerHTML = parsed.html;
      }

      if (rawCode) {
        rawCode.textContent = currentRawMarkdown;
      }

      if (rawLines) {
        rawLines.textContent = `${parsed.stats.lineCount.toLocaleString()} lines`;
      }

      if (metaWords) {
        metaWords.textContent = `~${parsed.stats.wordCount.toLocaleString()} words`;
      }

      if (metaReadTime) {
        metaReadTime.textContent = `~${parsed.stats.readingTimeMinutes} min read`;
      }

      if (metaName && parsed.metadata.name) {
        metaName.textContent = parsed.metadata.name;
      }

      setupTOC(parsed.toc);
      setupCodeBlockCopy();
    } catch (error) {
      if (renderedDoc) {
        renderedDoc.innerHTML = `
          <div class="callout callout-important">
            <svg class="callout-icon" viewBox="0 0 24 24"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>
            <div class="callout-body">
              <strong>Unable to load skills.md</strong>
              <p>${escapeHtml(error.message || "Network error loading skills.md")}</p>
              <button class="button button-primary" id="btn-skills-retry" style="margin-top:12px;">Retry Loading</button>
            </div>
          </div>
        `;
        document.querySelector("#btn-skills-retry")?.addEventListener("click", loadAndRender);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 3. Execution on Page Load
  // ---------------------------------------------------------------------------

  function init() {
    setupReadingProgress();
    setupViewToggle();
    setupSearch();
    setupThemeToggle();
    setupActions();
    loadAndRender();
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }
  }

  // Export for testing
  globalScope.StampNoteSkills = Object.freeze({
    parseMarkdown,
    parseFrontmatter,
    renderInline,
    slugify,
  });
})(typeof globalThis !== "undefined" ? globalThis : this);

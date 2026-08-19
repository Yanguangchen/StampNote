// The drawer that carries the app's pages. It is built here rather than written
// into each page so the list of destinations exists once: a page opts in by
// loading this file and marking where its toggle belongs.
(function initializeAppSidebar() {
  "use strict";

  const GROUPS = [
    {
      heading: "Worker workspace",
      access: "worker",
      pages: [
        {
          file: "index.html", label: "Recording",
          icon: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z"/></svg>',
        },
        {
          file: "worker-photos.html", label: "Worker photos",
          icon: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2H4zm16 12H4l4.5-6 3.5 4.5 2.5-3 5.5 6.5zM8.5 9a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/></svg>',
        },
      ],
    },
    {
      heading: "Admin workspace",
      access: "admin",
      pages: [
        {
          file: "onboarding.html", label: "Worker onboarding",
          icon: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm-6 14a6 6 0 0 1 12 0H6z"/></svg>',
        },
        {
          file: "coordinates.html", label: "Geographic Surveillence",
          icon: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/></svg>',
        },
        {
          file: "agent-coordinates.html", label: "Coordinate entry",
          icon: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4" stroke="currentColor" stroke-width="2"/></svg>',
        },
        {
          file: "ai-dashboard.html", label: "Operations AI",
          icon: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 2l2.4 5.6L20 10l-5.6 2.4L12 18l-2.4-5.6L4 10l5.6-2.4L12 2zm6.5 13.5l1.2 2.8 2.8 1.2-2.8 1.2-1.2 2.8-1.2-2.8-2.8-1.2 2.8-1.2 1.2-2.8zM4.5 15.5l1 2.2 2.2 1-2.2 1-1 2.2-1-2.2-2.2-1 2.2-1 1-2.2z"/></svg>',
        },
        {
          file: "admin.html", label: "Photos & attendance",
          icon: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M19 3h-4.18C14.4 1.84 13.3 1 12 1c-1.3 0-2.4.84-2.82 2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm-7 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2zm-5 6h10v2H7V9zm0 4h10v2H7v-2zm0 4h7v2H7v-2z"/></svg>',
        },
        {
          file: "live-tunnel.html", label: "Live tunnel",
          icon: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z"/><circle cx="8" cy="12" r="1.6" fill="currentColor" stroke="none"/></svg>',
        },
        {
          file: "metrics.html", label: "Metrics",
          icon: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 19h16v2H2V3h2v16zm4-3H6v-5h2v5zm4 0h-2V7h2v9zm4 0h-2v-8h2v8zm4 0h-2V4h2v12z"/></svg>',
        },
      ],
    },
  ];

  // `cleanUrls` serves /admin as well as /admin.html, and a bare directory is
  // the capture screen, so pages are compared by name without their extension.
  function pageName(path) {
    const last = String(path || "").split("/").pop() || "";
    const name = last.replace(/\.html$/i, "");
    return name || "index";
  }

  const mount = document.querySelector("[data-sidebar-mount]");
  if (!mount) return;

  const current = pageName(window.location.pathname);

  const toggle = document.createElement("button");
  toggle.className = "sidebar-toggle";
  toggle.id = "sidebar-toggle";
  toggle.type = "button";
  toggle.setAttribute("aria-controls", "app-sidebar");
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-label", "Open page menu");
  const bars = document.createElement("span");
  bars.className = "sidebar-toggle-bars";
  bars.setAttribute("aria-hidden", "true");
  bars.append(
    document.createElement("span"),
    document.createElement("span"),
    document.createElement("span"),
  );
  toggle.append(bars);

  const scrim = document.createElement("div");
  scrim.className = "sidebar-scrim";
  scrim.dataset.open = "false";

  const sidebar = document.createElement("aside");
  sidebar.className = "app-sidebar";
  sidebar.id = "app-sidebar";
  sidebar.dataset.open = "false";
  sidebar.setAttribute("aria-label", "Pages");

  const nav = document.createElement("nav");
  const links = [];
  const renderedGroups = [];
  let accessGate = null;

  GROUPS.forEach((group) => {
    const heading = document.createElement("p");
    heading.className = "sidebar-heading";
    heading.textContent = group.heading;
    nav.append(heading);

    const groupLinks = [];
    group.pages.forEach((page) => {
      const link = document.createElement("a");
      link.className = "sidebar-link";
      link.href = page.file;

      const icon = document.createElement("span");
      icon.className = "sidebar-link-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.innerHTML = page.icon;

      const label = document.createElement("span");
      label.className = "sidebar-link-label";
      label.textContent = page.label;

      link.append(icon, label);
      if (pageName(page.file) === current) link.setAttribute("aria-current", "page");
      nav.append(link);
      links.push(link);
      groupLinks.push(link);
    });
    renderedGroups.push({ access: group.access, heading, links: groupLinks });
  });

  sidebar.append(nav);

  // Appearance belongs with the app-level navigation rather than the account
  // controls. Reusing the existing button keeps the dashboard's theme state,
  // telemetry and click handler intact when it is moved into the drawer.
  const themeToggle = document.querySelector("#theme-toggle");
  if (themeToggle) {
    const tools = document.createElement("div");
    const toolsHeading = document.createElement("p");
    tools.className = "sidebar-tools";
    toolsHeading.className = "sidebar-heading";
    toolsHeading.textContent = "Appearance";
    tools.append(toolsHeading, themeToggle);
    sidebar.append(tools);
  }

  const footer = document.createElement("div");
  footer.className = "sidebar-footer";
  const skillsButton = document.createElement("a");
  skillsButton.className = "sidebar-skills-button";
  skillsButton.href = "skills.html";
  skillsButton.setAttribute("title", "Skills Playbook (skills.md)");
  skillsButton.setAttribute("aria-label", "Skills Playbook");
  if (current === "skills") {
    skillsButton.setAttribute("aria-current", "page");
  }

  const skillsIcon = document.createElement("span");
  skillsIcon.className = "sidebar-skills-icon";
  skillsIcon.setAttribute("aria-hidden", "true");
  skillsIcon.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>';

  const skillsLabel = document.createElement("span");
  skillsLabel.className = "sidebar-skills-label";
  skillsLabel.textContent = "skills.md";

  skillsButton.append(skillsIcon, skillsLabel);
  footer.append(skillsButton);
  sidebar.append(footer);

  function setOpen(open) {
    sidebar.dataset.open = String(open);
    scrim.dataset.open = String(open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close page menu" : "Open page menu");
    // A shut drawer is out of the tab order as well as out of sight.
    sidebar.inert = !open;

    if (open) {
      // Focus lands on somewhere you can actually go, not the page already open.
      const available = links.filter((link) => !link.hidden);
      (available.find((link) => !link.hasAttribute("aria-current")) || available[0])?.focus();
      return;
    }

    // Closing hands focus back to the button that opened it, unless the reader
    // has already moved on to something else in the page.
    const active = document.activeElement;
    if (!active || active === document.body || sidebar.contains(active)) toggle.focus();
  }

  toggle.addEventListener("click", () => {
    setOpen(sidebar.dataset.open !== "true");
  });

  scrim.addEventListener("click", () => setOpen(false));

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && sidebar.dataset.open === "true") setOpen(false);
  });

  function currentPageRequiresAdmin() {
    return renderedGroups.some(
      (group) =>
        group.access === "admin" &&
        group.links.some((link) => link.hasAttribute("aria-current")),
    );
  }

  function ensureAccessGate() {
    if (accessGate) return accessGate;
    accessGate = document.createElement("div");
    accessGate.className = "access-gate";
    accessGate.setAttribute("role", "alertdialog");
    accessGate.setAttribute("aria-labelledby", "access-gate-title");
    accessGate.hidden = true;

    const title = document.createElement("h1");
    title.id = "access-gate-title";
    title.textContent = "This page is for administrators";
    const copy = document.createElement("p");
    copy.textContent = "Your account can open Recording and Worker photos.";
    const recording = document.createElement("a");
    recording.className = "access-gate-link";
    recording.href = "index.html";
    recording.textContent = "Go to Recording";
    const photos = document.createElement("a");
    photos.className = "access-gate-link";
    photos.href = "worker-photos.html";
    photos.textContent = "Go to Worker photos";
    accessGate.append(title, copy, recording, photos);
    document.body.append(accessGate);
    return accessGate;
  }

  function applyRole(role) {
    const currentRole = role === "admin" || role === "worker" ? role : "signed_out";
    renderedGroups.forEach((group) => {
      const hidden = currentRole === "worker" && group.access === "admin";
      group.heading.hidden = hidden;
      group.links.forEach((link) => {
        link.hidden = hidden;
      });
    });

    const blocked = currentRole === "worker" && currentPageRequiresAdmin();
    const gate = ensureAccessGate();
    gate.hidden = !blocked;
    if (document.documentElement?.dataset) {
      document.documentElement.dataset.pageAccess = blocked ? "denied" : "allowed";
    }
    if (blocked && sidebar.dataset.open === "true") setOpen(false);
  }

  function bindCloudAccess(cloud) {
    if (!cloud?.subscribeAuth) return;
    cloud.subscribeAuth(async (user, error) => {
      if (error || !user) {
        applyRole("signed_out");
        return;
      }
      if (typeof cloud.getAccess !== "function") {
        applyRole("signed_out");
        return;
      }
      try {
        const access = await cloud.getAccess(user);
        applyRole(access.role === "admin" ? "admin" : "worker");
      } catch {
        applyRole("worker");
      }
    });
  }

  if (window.StampNoteFirebase) {
    bindCloudAccess(window.StampNoteFirebase);
  } else {
    let currentFirebase;
    Object.defineProperty(window, "StampNoteFirebase", {
      configurable: true,
      enumerable: true,
      get() {
        return currentFirebase;
      },
      set(value) {
        currentFirebase = value;
        bindCloudAccess(value);
      },
    });
  }

  window.StampNoteSidebar = Object.freeze({
    setRole: applyRole,
    pageName,
  });

  mount.prepend(toggle);
  document.body.append(scrim, sidebar);
  sidebar.inert = true;
  applyRole("signed_out");
})();

// The drawer that carries the app's pages. It is built here rather than written
// into each page so the list of destinations exists once: a page opts in by
// loading this file and marking where its toggle belongs.
(function initializeAppSidebar() {
  "use strict";

  const PAGES = [
    { file: "index.html", label: "Recording", hint: "Camera and auto capture" },
    { file: "worker-photos.html", label: "Worker photos", hint: "Take or choose a photo" },
    { file: "onboarding.html", label: "Worker onboarding", hint: "Enroll and remove faces" },
    {
      file: "coordinates.html",
      label: "Geographic Surveillence",
      hint: "Compare GPS and truck positions",
    },
    { file: "admin.html", label: "Photos & attendance", hint: "Review a day's sessions" },
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

  const heading = document.createElement("p");
  heading.className = "sidebar-heading";
  heading.textContent = "Go to";

  const nav = document.createElement("nav");
  const links = PAGES.map((page) => {
    const link = document.createElement("a");
    link.className = "sidebar-link";
    link.href = page.file;
    link.textContent = page.label;
    const hint = document.createElement("span");
    hint.textContent = page.hint;
    link.append(hint);
    if (pageName(page.file) === current) link.setAttribute("aria-current", "page");
    return link;
  });
  nav.append(...links);
  sidebar.append(heading, nav);

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

  function setOpen(open) {
    sidebar.dataset.open = String(open);
    scrim.dataset.open = String(open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close page menu" : "Open page menu");
    // A shut drawer is out of the tab order as well as out of sight.
    sidebar.inert = !open;

    if (open) {
      // Focus lands on somewhere you can actually go, not the page already open.
      (links.find((link) => !link.hasAttribute("aria-current")) || links[0])?.focus();
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

  mount.prepend(toggle);
  document.body.append(scrim, sidebar);
  sidebar.inert = true;
})();

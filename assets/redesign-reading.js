(() => {
  "use strict";

  const targets = new Map();
  let active = null;

  function clearSelection() {
    if (!active) return;
    active.item.classList.remove("is-active");
    active.link.removeAttribute("aria-current");
    active.target.classList.remove("is-highlighted");
    active.callout.hidden = true;
    active.activeText.replaceChildren();
    active = null;
  }

  function select(entry, { scroll = true, updateHash = true } = {}) {
    const { item, link, target, callout, activeText } = entry;
    if (active !== entry) {
      clearSelection();
      active = entry;
      item.classList.add("is-active");
      link.setAttribute("aria-current", "location");
      target.classList.add("is-highlighted");
      const label = document.createElement("strong");
      label.textContent = link.textContent;
      callout.hidden = false;
      activeText.replaceChildren(label, item.querySelector("p").textContent);
    }
    if (updateHash) history.replaceState(history.state, "", "#" + target.id);
    if (scroll) target.scrollIntoView({ block: "center", inline: "center" });
  }

  for (const exhibit of document.querySelectorAll(".redesigned-exhibit")) {
    const callout = exhibit.querySelector(".diagram-selected");
    const activeText = callout.querySelector(".diagram-selection");
    callout.querySelector(".diagram-clear").addEventListener("click", () => {
      const { link } = active;
      clearSelection();
      history.replaceState(history.state, "", "#" + exhibit.id);
      link.focus();
    });

    for (const link of exhibit.querySelectorAll(".figure-reading a[data-reading-target]")) {
      const target = document.getElementById(link.dataset.readingTarget);
      const entry = { link, target, item: link.closest("li"), callout, activeText };
      targets.set(target.id, entry);
      link.addEventListener("click", event => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        select(entry);
      });
      if (target instanceof SVGElement) {
        target.classList.add("svg-interactive");
        target.addEventListener("click", () => select(entry, { scroll: false }));
      }
    }
  }

  document.documentElement.classList.add("has-reading-controls");
  function syncFromHash() {
    const entry = targets.get(location.hash.slice(1));
    if (entry) select(entry, { updateHash: false });
    else clearSelection();
  }
  window.addEventListener("hashchange", syncFromHash);
  syncFromHash();

  const sections = Array.from(document.querySelectorAll(".desktop-jump a"), link => ({
    link,
    section: document.getElementById(link.hash.slice(1)),
  }));
  let current;
  function updateContents() {
    const next = sections.findLast(({ section }) => section.getBoundingClientRect().top <= window.innerHeight * 0.22) || sections[0];
    if (next === current) return;
    current?.link.classList.remove("is-current");
    current?.link.removeAttribute("aria-current");
    next.link.classList.add("is-current");
    next.link.setAttribute("aria-current", "location");
    current = next;
  }
  window.addEventListener("scroll", updateContents, { passive: true });
  window.addEventListener("resize", updateContents);
  updateContents();
})();

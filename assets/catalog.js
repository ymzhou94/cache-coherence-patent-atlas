(() => {
  const list = document.getElementById("patent-list");
  const buttons = Array.from(document.querySelectorAll("[data-filter]"));
  const cards = Array.from(list.children);
  const search = document.getElementById("search");
  const year = document.getElementById("priority-year");
  const status = document.getElementById("result-count");
  const empty = document.getElementById("empty-results");
  const initial = new URLSearchParams(window.location.search).get("topic");
  let category = buttons.some(button => button.dataset.filter === initial) ? initial : "all";

  function matchesYear(card) {
    if (year.value === "recent-publication") return card.dataset.published >= year.selectedOptions[0].dataset.from;
    const number = Number(card.dataset.year);
    if (year.value === "since-2020") return number >= 2020;
    if (year.value === "since-2024") return number >= 2024;
    if (year.value === "before-2020") return number < 2020;
    return true;
  }

  function render() {
    for (const button of buttons) {
      button.setAttribute("aria-pressed", String(button.dataset.filter === category));
    }
    const words = search.value.toLowerCase().trim().split(/\s+/u);
    let count = 0;
    for (const card of cards) {
      const subject = card.dataset.search.toLowerCase();
      const visible = (category === "all" || card.dataset.category === category) &&
        matchesYear(card) && words.every(word => subject.includes(word));
      card.hidden = !visible;
      if (visible) count += 1;
    }
    status.textContent = count + " 件";
    empty.hidden = count > 0;
  }

  for (const button of buttons) {
    button.addEventListener("click", () => {
      category = button.dataset.filter;
      render();
    });
  }
  search.addEventListener("input", render);
  year.addEventListener("change", render);
  render();
})();

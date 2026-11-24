(() => {
  const graph = document.getElementById("knowledge");
  const nodes = graph.querySelectorAll("[data-knowledge-node]");
  const edges = graph.querySelectorAll(".knowledge-edge");
  const panels = graph.querySelectorAll("[data-knowledge-panel]");

  for (const node of nodes) {
    node.addEventListener("click", () => {
      const selected = node.dataset.knowledgeNode;
      for (const button of nodes) button.setAttribute("aria-pressed", String(button === node));
      for (const panel of panels) panel.hidden = panel.dataset.knowledgePanel !== selected;
      for (const edge of edges) {
        edge.classList.toggle("is-active", edge.dataset.from === selected || edge.dataset.to === selected);
      }
    });
  }
})();

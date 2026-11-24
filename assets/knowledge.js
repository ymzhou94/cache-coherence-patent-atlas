(() => {
  const {patents, edges, start, kinds} = JSON.parse(document.getElementById("knowledge-data").textContent);
  const network = document.getElementById("knowledge-network");
  const inspector = document.getElementById("knowledge-inspector");
  const form = document.getElementById("knowledge-search");
  const query = document.getElementById("knowledge-query");
  const status = document.getElementById("knowledge-search-result");

  function element(tag, name, text) {
    const node = document.createElement(tag);
    node.className = name;
    if (text) node.textContent = text;
    return node;
  }

  function link(text, url) {
    const node = element("a", "", text);
    node.href = url;
    return node;
  }

  function patentUrl(id) {
    return "patents/" + id + ".html";
  }

  function patentCard(id, headingLevel) {
    const card = element("div", "knowledge-patent");
    card.append(element("code", "", id));
    const heading = element(headingLevel, "");
    if (headingLevel === "h3") {
      heading.textContent = patents[id].title;
    } else {
      const focus = element("button", "knowledge-patent-name", patents[id].title);
      focus.type = "button";
      focus.addEventListener("click", () => show(id, true));
      heading.append(focus);
    }
    card.append(heading);
    return card;
  }

  function inspect(id, edge, neighbor) {
    const patent = patents[id];
    if (!edge) {
      inspector.replaceChildren(
        element("h3", "knowledge-inspect-title", patent.title),
        element("p", "", patent.question),
        link("阅读专利分析", patentUrl(id)),
      );
      return;
    }

    const badge = element("span", "knowledge-kind kind-" + edge.kind, kinds[edge.kind]);
    const heading = element("h3", "knowledge-inspect-title", edge.label);
    heading.tabIndex = -1;
    const explanation = element("p", "knowledge-explanation", edge.summary);
    const proof = element("ul", "knowledge-proof");
    const ends = [edge.from, edge.to];
    ends.forEach((pid, index) => {
      const record = patents[pid];
      const item = element("li", "knowledge-proof-item");
      item.append(element("code", "", pid), link(record.title, patentUrl(pid)));
      if (edge.evidence) {
        const [claim, figure] = edge.evidence[index];
        const claimAnchor = record.claims[claim];
        const refs = element("div", "knowledge-proof-links");
        const claimUrl = claimAnchor ? record.source + "#" + claimAnchor : record.source;
        const claimLabel = "权利要求 " + claim + (claimAnchor ? "" : "（全文）");
        const label = record.tables.includes(figure) ? "查看对照表" : "查看工程图解";
        refs.append(link(claimLabel, claimUrl), link(label, patentUrl(pid) + "#fig-" + figure));
        item.append(refs);
      }
      proof.append(item);
    });
    const actions = element("div", "knowledge-actions");
    if (edge.source) actions.append(link(edge.source[1], edge.source[0]));
    const recenter = element("button", "knowledge-recenter", "沿 " + neighbor + " 继续");
    recenter.type = "button";
    recenter.addEventListener("click", () => show(neighbor, true));
    inspector.replaceChildren(badge, heading, explanation, proof, actions, recenter);
  }

  function show(id, focus = false) {
    const byNeighbor = new Map();
    for (const edge of edges) {
      if (edge.from !== id && edge.to !== id) continue;
      const target = edge.from === id ? edge.to : edge.from;
      if (!byNeighbor.has(target)) byNeighbor.set(target, []);
      byNeighbor.get(target).push(edge);
    }

    const root = patentCard(id, "h3");
    root.classList.add("knowledge-root");
    root.tabIndex = -1;
    root.append(link("阅读专利分析", patentUrl(id)));
    const branches = element("ul", "knowledge-branches");
    network.replaceChildren(root);
    if (byNeighbor.size === 0) {
      network.append(element("p", "knowledge-empty", "这件专利暂未收录已核对的关系。"));
      inspect(id);
      if (focus) root.focus();
      return;
    }
    network.append(branches);

    let first;
    function select(button, edge, target) {
      const previous = branches.querySelector("[aria-pressed=true]");
      if (previous) previous.setAttribute("aria-pressed", "false");
      button.setAttribute("aria-pressed", "true");
      inspect(id, edge, target);
    }
    for (const [target, relations] of byNeighbor) {
      const branch = element("li", "knowledge-branch");
      const card = patentCard(target, "h4");
      const buttons = element("div", "knowledge-relations");
      for (const edge of relations) {
        const directed = edge.kind === "citation" || (edge.kind === "family" && !edge.bidirectional);
        const direction = directed ? (edge.from === id ? "→ " : "← ") : "";
        const button = element("button", "knowledge-kind kind-" + edge.kind, direction + edge.label);
        button.type = "button";
        button.title = edge.label;
        button.setAttribute("aria-label", edge.label + "，" + kinds[edge.kind] + "，" + patents[target].title);
        button.setAttribute("aria-pressed", "false");
        button.setAttribute("aria-controls", "knowledge-inspector");
        button.addEventListener("click", () => {
          select(button, edge, target);
          if (matchMedia("(max-width: 920px)").matches) {
            inspector.querySelector("h3").focus({preventScroll: true});
            inspector.scrollIntoView({block: "start"});
          }
        });
        if (!first) first = [button, edge, target];
        buttons.append(button);
      }
      card.append(buttons);
      branch.append(card);
      branches.append(branch);
    }
    select(...first);
    if (focus) root.focus();
  }

  form.addEventListener("submit", event => {
    event.preventDefault();
    const entered = query.value.trim().toUpperCase();
    const publication = entered.replace(/[\s,/.-]/gu, "");
    const matches = Object.entries(patents).filter(([id, record]) =>
      id.includes(publication) || record.title.toUpperCase().includes(entered) || record.english.toUpperCase().includes(entered));
    const id = Object.hasOwn(patents, publication) ? publication : matches.length === 1 ? matches[0][0] : "";
    status.hidden = Boolean(id);
    if (id) {
      query.value = id;
      show(id, true);
    } else {
      status.textContent = matches.length ? "找到 " + matches.length + " 件。请补全公开号或标题，或从建议列表选取。"
        : "没有匹配的专利。";
    }
  });
  query.addEventListener("input", () => { status.hidden = true; });
  show(start);
})();


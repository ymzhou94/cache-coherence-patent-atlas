(() => {
  const {patents, edges, start, kinds, points, width, height} = JSON.parse(document.getElementById("knowledge-data").textContent);
  const network = document.getElementById("knowledge-network");
  const inspector = document.getElementById("knowledge-inspector");
  const overview = document.getElementById("knowledge-overview");
  const current = document.getElementById("knowledge-map-current");
  const form = document.getElementById("knowledge-search");
  const query = document.getElementById("knowledge-query");
  const status = document.getElementById("knowledge-search-result");
  const adjacency = new Map(Object.keys(patents).map(id => [id, []]));
  const groups = new Map();
  const mapNodes = new Map();
  const mapEdges = [];
  let selected = start;
  let focused = start;
  let activeEdge;
  let highlighted = false;
  let camera = {x: 0, y: 0, scale: 1};

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

  function svg(tag, attributes) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    return node;
  }

  function setCamera(x, y, scale) {
    const w = width / scale, h = height / scale;
    camera = {x: Math.max(0, Math.min(width - w, x)), y: Math.max(0, Math.min(height - h, y)), scale};
    overview.setAttribute("viewBox", `${camera.x} ${camera.y} ${w} ${h}`);
    overview.classList.toggle("is-zoomed", scale > 1);
  }

  function centerMap(x, y, scale) {
    setCamera(x - width / (2 * scale), y - height / (2 * scale), scale);
  }

  function focusNode(id) {
    mapNodes.get(focused).setAttribute("tabindex", "-1");
    focused = id;
    const node = mapNodes.get(id);
    node.setAttribute("tabindex", "0");
    node.focus({preventScroll: true});
  }

  function describe(id) {
    current.textContent = id + " · " + patents[id].title + " · " + adjacency.get(id).length + " 条关系";
  }

  function updateOverview(id, selectedEdge) {
    activeEdge = selectedEdge;
    const neighbors = new Set(adjacency.get(id).map(index => {
      const edge = edges[index];
      return edge.from === id ? edge.to : edge.from;
    }));
    overview.classList.toggle("is-exploring", highlighted);
    for (const [pid, node] of mapNodes) {
      node.setAttribute("aria-pressed", String(pid === id));
      node.classList.toggle("is-neighbor", neighbors.has(pid));
    }
    for (const [index, line] of mapEdges.entries()) {
      const edge = edges[index];
      line.classList.toggle("is-active", edge.from === id || edge.to === id);
      line.classList.toggle("is-selected", index === selectedEdge);
    }
    describe(id);
  }

  function mapKey(event, id) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      show(id);
      return;
    }
    const direction = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]}[event.key];
    if (!direction) return;
    event.preventDefault();
    const [x, y] = points[id];
    const [dx, dy] = direction;
    let next = id, best = Infinity;
    for (const [pid, [px, py]] of Object.entries(points)) {
      const forward = (px - x) * dx + (py - y) * dy;
      if (forward <= 0) continue;
      const sideways = (px - x) * dy - (py - y) * dx;
      const score = forward + (sideways * sideways) / forward;
      if (score < best) { next = pid; best = score; }
    }
    const [nx, ny] = points[next];
    if (nx < camera.x || nx > camera.x + width / camera.scale ||
        ny < camera.y || ny > camera.y + height / camera.scale) centerMap(nx, ny, camera.scale);
    focusNode(next);
  }

  function createOverview() {
    const lines = overview.querySelector(".map-edges");
    const nodes = overview.querySelector(".map-nodes");
    edges.forEach(({from, to}, index) => {
      adjacency.get(from).push(index);
      adjacency.get(to).push(index);
      const key = [from, to].sort().join("/");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(index);
    });
    edges.forEach(({from, to, kind, label, bidirectional}, index) => {
      const [x, y] = points[from], [tx, ty] = points[to];
      const dx = tx - x, dy = ty - y;
      const length = Math.hypot(dx, dy);
      const ux = dx / length, uy = dy / length;
      const siblings = groups.get([from, to].sort().join("/"));
      const curve = 14 * (siblings.indexOf(index) - (siblings.length - 1) / 2) * (from < to ? 1 : -1);
      const path = `M${x + ux * 6} ${y + uy * 6} Q${(x + tx) / 2 - uy * curve} ${(y + ty) / 2 + ux * curve} ${tx - ux * 7} ${ty - uy * 7}`;
      const group = svg("g", {class: "map-edge kind-" + kind, "data-edge": index, "data-from": from, "data-to": to});
      const stroke = svg("path", {d: path, class: "map-edge-line"});
      if (kind === "citation" || (kind === "family" && !bidirectional)) {
        stroke.setAttribute("marker-end", "url(#map-arrow-" + kind + ")");
      }
      const title = svg("title", {});
      title.textContent = from + " · " + label + " · " + to;
      group.append(stroke, svg("path", {d: path, class: "map-edge-hit"}), title);
      group.addEventListener("click", () => show(selected === to ? to : from, {edgeIndex: index}));
      lines.append(group);
      mapEdges.push(group);
    });
    for (const [id, [x, y]] of Object.entries(points)) {
      const title = svg("title", {});
      title.textContent = id + " · " + patents[id].title;
      const node = svg("g", {class: "map-node topic-" + patents[id].category, transform: `translate(${x} ${y})`,
        role: "button", tabindex: id === start ? 0 : -1, "data-patent": id, "aria-label": title.textContent});
      node.classList.toggle("is-isolated", adjacency.get(id).length === 0);
      node.append(title, svg("circle", {r: 11, class: "map-node-hit"}), svg("circle", {r: 6, class: "map-node-dot"}));
      node.addEventListener("click", () => { show(id); focusNode(id); });
      node.addEventListener("pointerenter", () => describe(id));
      node.addEventListener("pointerleave", () => describe(selected));
      node.addEventListener("focus", () => describe(id));
      node.addEventListener("keydown", event => mapKey(event, id));
      nodes.append(node);
      mapNodes.set(id, node);
    }
  }

  for (const button of document.querySelectorAll("[data-map-zoom]")) {
    button.addEventListener("click", () => {
      const mode = button.dataset.mapZoom;
      if (mode === "fit") {
        setCamera(0, 0, 1);
        show(selected, {edgeIndex: activeEdge, spotlight: false});
      } else {
        const scale = Math.max(1, Math.min(4, camera.scale * (mode === "in" ? 1.4 : 1 / 1.4)));
        centerMap(camera.x + width / (2 * camera.scale), camera.y + height / (2 * camera.scale), scale);
      }
    });
  }

  let drag, dragged = false;
  overview.addEventListener("pointerdown", event => {
    dragged = false;
    if (!event.isPrimary || event.button !== 0 || camera.scale === 1) return;
    drag = {id: event.pointerId, x: event.clientX, y: event.clientY, origin: camera};
  });
  overview.addEventListener("pointermove", event => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!dragged && Math.hypot(dx, dy) < 4) return;
    if (!dragged) overview.setPointerCapture(event.pointerId);
    dragged = true;
    const transform = overview.getScreenCTM();
    setCamera(drag.origin.x - dx / transform.a, drag.origin.y - dy / transform.d, drag.origin.scale);
  });
  for (const action of ["pointerup", "pointercancel"]) {
    overview.addEventListener(action, () => { drag = undefined; });
  }
  overview.addEventListener("pointerleave", () => { if (!dragged) drag = undefined; });
  overview.addEventListener("click", event => {
    if (!dragged) return;
    event.stopPropagation();
    dragged = false;
  }, true);

  function patentCard(id, headingLevel) {
    const card = element("div", "knowledge-patent");
    card.append(element("code", "", id));
    const heading = element(headingLevel, "");
    if (headingLevel === "h3") {
      heading.textContent = patents[id].title;
    } else {
      const focus = element("button", "knowledge-patent-name", patents[id].title);
      focus.type = "button";
      focus.addEventListener("click", () => show(id, {focus: true}));
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
    recenter.addEventListener("click", () => show(neighbor, {focus: true}));
    inspector.replaceChildren(badge, heading, explanation, proof, actions, recenter);
  }

  function show(id, {focus = false, edgeIndex, spotlight = true, zoomTo = false} = {}) {
    selected = id;
    highlighted = spotlight;
    const byNeighbor = new Map();
    for (const index of adjacency.get(id)) {
      const edge = edges[index];
      const target = edge.from === id ? edge.to : edge.from;
      if (!byNeighbor.has(target)) byNeighbor.set(target, []);
      byNeighbor.get(target).push(index);
    }

    const [x, y] = points[id];
    if (zoomTo || (focus && camera.scale > 1)) centerMap(x, y, zoomTo ? Math.max(1.85, camera.scale) : camera.scale);

    const root = patentCard(id, "h3");
    root.classList.add("knowledge-root");
    root.tabIndex = -1;
    root.append(link("阅读专利分析", patentUrl(id)));
    const branches = element("ul", "knowledge-branches");
    network.replaceChildren(root);
    if (byNeighbor.size === 0) {
      network.append(element("p", "knowledge-empty", "这件专利暂未收录已核对的关系。"));
      updateOverview(id);
      inspect(id);
      if (focus) root.focus();
      return;
    }
    network.append(branches);

    let first, chosen;
    function select(button, index, target) {
      const previous = branches.querySelector("[aria-pressed=true]");
      if (previous) previous.setAttribute("aria-pressed", "false");
      button.setAttribute("aria-pressed", "true");
      updateOverview(id, index);
      inspect(id, edges[index], target);
    }
    for (const [target, relations] of byNeighbor) {
      const branch = element("li", "knowledge-branch");
      const card = patentCard(target, "h4");
      const buttons = element("div", "knowledge-relations");
      for (const index of relations) {
        const edge = edges[index];
        const directed = edge.kind === "citation" || (edge.kind === "family" && !edge.bidirectional);
        const direction = directed ? (edge.from === id ? "→ " : "← ") : "";
        const button = element("button", "knowledge-kind kind-" + edge.kind, direction + edge.label);
        button.type = "button";
        button.title = edge.label;
        button.setAttribute("aria-label", edge.label + "，" + kinds[edge.kind] + "，" + patents[target].title);
        button.setAttribute("aria-pressed", "false");
        button.setAttribute("aria-controls", "knowledge-inspector");
        button.addEventListener("click", () => {
          select(button, index, target);
          if (matchMedia("(max-width: 920px)").matches) {
            inspector.querySelector("h3").focus({preventScroll: true});
            inspector.scrollIntoView({block: "start"});
          }
        });
        if (!first) first = [button, index, target];
        if (index === edgeIndex) chosen = [button, index, target];
        buttons.append(button);
      }
      card.append(buttons);
      branch.append(card);
      branches.append(branch);
    }
    select(...(chosen || first));
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
      show(id, {zoomTo: true});
      focusNode(id);
    } else {
      status.textContent = matches.length ? "找到 " + matches.length + " 件。请补全公开号或标题，或从建议列表选取。"
        : "没有匹配的专利。";
    }
  });
  query.addEventListener("input", () => { status.hidden = true; });
  createOverview();
  show(start, {spotlight: false});
})();


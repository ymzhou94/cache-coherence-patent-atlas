(() => {
  "use strict";
  const m = window.PatentModels;
  const num = (name, label, initial, min, max) => ({ name, label, initial, min, max });
  const select = (name, label, initial, values) => ({ name, label, initial, values });
  const yesNo = (name, label, value) => select(name, label, value, [[true, "是"], [false, "否"]]);
  const ticks = value => value === null ? "未返回" : "第 " + value + " 拍";
  const words = values => values.map(value => value === null ? "无效" : String(value)).join(" · ");

  const experiments = [
    {
      id: "hit-arbiter", title: "远组与近组同拍到达",
      patents: ["US11893241B1"],
      note: "返回端口每拍只接受一路。两组同时就绪时，端口先接收远组，近组暂存一拍。模型假定下一拍没有第三路竞争。",
      fields: [num("tick", "当前拍", 4, 0, 30), yesNo("farReady", "远组就绪", true), yesNo("nearReady", "近组就绪", true)],
      run(values) {
        const r = m.hitArbiter(values);
        return [r.buffered ? "远组先返回，近组暂存" : "无同拍竞争", ["远组 " + ticks(r.far), "近组 " + ticks(r.near)]];
      },
    },
    {
      id: "snoop-limit", title: "限制敏感 snoop 前的普通请求数",
      patents: ["US10795818B1"],
      note: "敏感 snoop 到达时，前面只有普通请求。假设这些请求用时相同，下游还能继续接收。默认参数对应 US10795818B1 的示例。",
      fields: [num("backlog", "已排队普通请求数", 5, 0, 64), num("limit", "前置数量上限", 2, 0, 64), num("ticksPerRequest", "每个普通请求占用拍数", 4, 1, 30)],
      run(values) {
        const r = m.snoopLimit(values);
        return ["设上限后，前面还有 " + r.after + " 个普通请求", ["FIFO 等待 " + r.fifoWait + " 拍", "设上限后等待 " + r.limitedWait + " 拍"]];
      },
    },
    {
      id: "bypass", title: "跨簇回填旁路",
      patents: ["US11016913B1", "US11537538B2"],
      note: "计时从脏副本持有者发出响应开始。每跳耗时相同，链路无排队。默认参数取自 US11016913B1 页的示例。控制器收到原响应的时刻单独计算。",
      fields: [num("sourceHops", "持有者到汇聚节点跳数", 2, 0, 16), num("controllerHops", "汇聚节点到控制器跳数", 5, 0, 16),
        num("requesterHops", "汇聚节点到请求者跳数", 2, 0, 16), num("ticksPerHop", "每跳拍数", 1, 1, 20),
        num("controllerWork", "控制器生成回填拍数", 1, 0, 20), num("mergeWork", "汇聚点转换响应拍数", 1, 0, 20)],
      run(values) {
        const r = m.bypass(values);
        const difference = r.viaController - r.viaMerge;
        const title = difference === 0 ? "两条路径都在同一拍返回数据" :
          "请求者" + (difference > 0 ? "提前 " : "延后 ") + Math.abs(difference) + " 拍拿到数据";
        return [title, [
          "经控制器回填 " + r.viaController + " 拍",
          "汇聚点直接回填 " + r.viaMerge + " 拍",
          "原响应若并行送往控制器，控制器在第 " + r.controllerCopy + " 拍收到",
        ]];
      },
    },
    {
      id: "partial-line", title: "部分有效行的读取与写入",
      patents: ["US11586552B2", "US12007901B2"],
      note: "每行用四个字表示。有效掩码的最低位对应字 0，有效字都视为已修改。读和写分别从同一初始状态计算。",
      fields: [num("validMask", "初始有效掩码（十进制）", 3, 1, 14),
        num("writeIndex", "写入项（0–3）", 2, 0, 3), num("writeValue", "新值", 99, 0, 255)],
      run(values) {
        const r = m.partialLine(values);
        return ["读取时保留已修改的字，写入时更新指定的字", [
          "初始缓存 " + words(r.cachedBefore) + "，初始内存 " + words(r.memory),
          "读合并 " + words(r.read),
          "写后缓存 " + words(r.writeCache) + "，掩码 " + r.nextMask.toString(2).padStart(4, "0"),
          "写请求完成后的内存 " + words(r.writeMemory),
        ]];
      },
    },
    {
      id: "probe-ahead", title: "查标签时先准备缺失队列",
      patents: ["US9201796B2"],
      note: "顺序方案在确认缺失后准备队列。提前准备的方案把这一步移到标签查询启动后一拍。标签确认缺失且队列已准备好，才能发出外存读请求。",
      fields: [num("lookup", "标签查询拍数", 5, 2, 40), num("prepare", "队列准备拍数", 3, 1, 30),
        yesNo("spareSlot", "可提前占用条目", true), yesNo("miss", "最终标签缺失", true)],
      run(values) {
        const r = m.probeAhead(values);
        if (r.serial === null) {
          return ["标签命中，外存读未发出", [r.speculativeSlot ? "提前占用的条目可释放" : "未提前占用条目"]];
        }
        return ["两条路径最早可发的时刻相差 " + (r.serial - r.overlapped) + " 拍", [
          "顺序准备 " + ticks(r.serial), "可提前准备 " + ticks(r.overlapped),
        ]];
      },
    },
    {
      id: "admission", title: "不同标签结果需要哪些资源",
      patents: ["US12619558B2", "US20250103520A1"],
      note: "缓存先取得第一组条目，再启动标签查询。查到结果后，按请求类型申请额外条目。模型假定需要等待额外资源的请求已有重试条目。",
      fields: [
        select("request", "标签结果", "hit", [["hit", "命中，且无需 snoop"], ["snoop", "命中，但需要 snoop"], ["miss", "缺失"]]),
        yesNo("firstReady", "第一组条目可用", true), yesNo("nextReady", "额外条目可用", false),
      ],
      run(values) {
        const r = m.admission(values);
        return [r.state, [r.launched ? "已进入标签流水线" : "等待进入标签流水线", r.added]];
      },
    },
    {
      id: "read-turn", title: "关键读何时可以打断写轮次",
      patents: ["US12730763B2"],
      note: "假设读请求恰好在两个写请求之间的切换点到达。模型根据处理器标记、写队列空位和其他切换条件，算出有多少写请求要推迟。",
      fields: [yesNo("critical", "处理器标记为关键读", true), num("free", "指定优先级写队列剩余空位", 6, 0, 60),
        num("minimum", "空位门槛", 4, 0, 60), yesNo("otherCriteria", "其余激活条件满足", true),
        num("remainingWrites", "本轮剩余写请求", 5, 0, 60)],
      run(values) {
        const r = m.readTurn(values);
        return [r.switched ? "提前切换到读轮次" : "按当前写轮次继续", [
          "读前还要服务的写请求 " + r.writesBeforeRead,
          "推迟到后续轮次的写请求 " + r.writesDeferred,
        ]];
      },
    },
    {
      id: "quota", title: "SLC 配额总和超过物理容量",
      patents: ["US9043570B2"],
      note: "两个组的配额都已启用。模型先按各自配额截断需求，再检查缓存能否同时容纳这两部分。假设每个缓存行位置都能分给任意一组。",
      fields: [num("capacity", "SLC 物理行数", 100, 1, 300), num("quotaA", "A 组配额", 75, 0, 300),
        num("quotaB", "B 组配额", 65, 0, 300), num("demandA", "A 组需求", 65, 0, 300), num("demandB", "B 组需求", 58, 0, 300)],
      run(values) {
        const r = m.quota(values);
        return [r.shortfall ? "缓存容不下两组配额内的需求" : "缓存能容纳两组配额内的需求", [
          "配额总和 " + r.totalQuota + "，物理容量 " + values.capacity,
          "配额内需求 A " + r.targetA + " / B " + r.targetB,
          "同时满足还缺 " + r.shortfall + " 行",
        ]];
      },
    },
    {
      id: "deny-list", title: "未使用的预取行逐出后会怎样",
      patents: ["US12306762B1"],
      note: "限制表起初没有记录。模型检查逐出后同一地址的下一次推测预取，结果取决于逐出时是否建了条目，以及预取到来时该条目是否仍有效。",
      fields: [yesNo("prefetched", "被逐出行来自预取", true), yesNo("touched", "逐出前曾被触及", false), yesNo("live", "后续请求到来时条目仍有效", true)],
      run(values) {
        const r = m.denyList(values);
        return [r.denied ? "限制表阻止这次预取" : "这次预取可以通过本项检查", [
          r.inserted ? "逐出事件为该地址建条目" : "未为该次逐出建条目",
          "该地址的正常按需读取仍可继续",
        ]];
      },
    },
  ];

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function link(text, target) {
    const node = element("a", text);
    node.href = target;
    return node;
  }

  function addField(container, field) {
    const label = element("label");
    const control = element(field.values ? "select" : "input");
    label.append(element("span", field.label), control);
    control.name = field.name;
    if (field.values) {
      for (const [value, title] of field.values) {
        const option = element("option", title);
        option.value = String(value);
        control.append(option);
      }
    } else {
      control.type = "number";
      control.min = String(field.min);
      control.max = String(field.max);
      control.step = "1";
      control.required = true;
    }
    control.value = String(field.initial);
    container.append(label);
    return () => {
      if (field.values) return field.values.find(([value]) => String(value) === control.value)[0];
      return control.validity.valid ? control.valueAsNumber : undefined;
    };
  }

  const nav = document.getElementById("lab-nav");
  const lab = document.getElementById("lab");
  for (const experiment of experiments) {
    nav.append(link(experiment.title, "#" + experiment.id));
    const card = element("article", undefined, "lab-model");
    card.id = experiment.id;
    const controls = element("div", undefined, "model-controls");
    const results = element("div", undefined, "model-result");
    results.setAttribute("aria-live", "polite");
    const state = experiment.fields.map(field => [field.name, addField(controls, field)]);
    const sources = element("p", undefined, "model-sources");
    sources.append("对应专利 ");
    for (const [index, patent] of experiment.patents.entries()) {
      if (index) sources.append(" · ");
      sources.append(link(patent, "patents/" + patent + ".html"));
    }
    card.append(element("h2", experiment.title), element("p", experiment.note), controls, results, sources);

    function recompute() {
      const values = Object.fromEntries(state.map(([name, read]) => [name, read()]));
      if (Object.values(values).includes(undefined)) {
        results.replaceChildren(element("p", "请填写输入框允许范围内的整数。"));
        return;
      }
      const [title, lines] = experiment.run(values);
      const list = element("ul");
      list.append(...lines.map(text => element("li", text)));
      results.replaceChildren(element("p", title), list);
    }

    controls.addEventListener("input", recompute);
    controls.addEventListener("change", recompute);
    lab.append(card);
    recompute();
  }
  const activeId = location.hash.slice(1);
  if (activeId && experiments.some(item => item.id === activeId)) {
    document.getElementById(activeId).scrollIntoView();
  }
})();

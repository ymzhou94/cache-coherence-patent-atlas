(() => {
  "use strict";
  const m = window.PatentModels;
  const t = window.PatentTraces;
  const num = (name, label, initial, min, max) => ({ name, label, initial, min, max });
  const select = (name, label, initial, values) => ({ name, label, initial, values });
  const yn = (name, label, initial) => select(name, label, initial, [[true, "是"], [false, "否"]]);
  const cycle = value => value === null ? "—" : "t" + value;
  const plus = value => value > 0 ? "+" + value : String(value);
  const quotaBurst = "A0 A1 A2 A0 A1 A2 B0 B1 B2 B3 B4 A0 A1 A2";
  const segment = (label, from, to, tone = "work") => ({ label, from, to, tone });
  const lane = (name, spans, mark = null) => ({ name, spans, mark });
  const table = (title, columns, rows) => ({ title, columns, rows });

  const experiments = [
    {
      id: "hit-arbiter", name: "可变命中延迟", title: "近组命中什么时候能提前返回？",
      patents: [["US11893241B1", 2, "权 1，图 2–3"]],
      setup: "每拍最多发出一次读。先发一串远组请求，再发一个近组请求 N。远组 4 拍就绪，近组 1 拍就绪，合流出口每拍只接收一路。基线把每次命中的返回固定在发出后第 4 拍。",
      fields: [num("farBurst", "连续远组请求", 1, 0, 4), num("nearGap", "远组之后的空拍数", 2, 0, 6)],
      cases: [["同拍碰撞", {}], ["近组独行", { farBurst: 0, nearGap: 0 }], ["三个远组在前", { farBurst: 3, nearGap: 0 }]],
      run(values) {
        const { far, near } = t.returnTrace(values);
        const wait = near.variable - near.ready;
        return {
          metrics: [["N 的延迟 · 固定 / 可变", (near.fixed - near.issue) + " / " + (near.variable - near.issue) + " 拍"],
            ["N 在 skid buffer 等待", wait + " 拍"], ["远组返回时刻变化", "0 拍"]],
          explanation: wait
            ? "N 已就绪时合流端口仍在处理远组。它在第一个空闲拍返回。图中的等待发生在阵列读完之后。"
            : "N 就绪时合流出口空闲，可直接返回。改用统一的 4 拍延迟会让它多等 3 拍。",
          lanes: [
            lane("远组占用出口", far.map(row => segment(row.id, row.variable, row.variable + 1))),
            lane("N · 固定延迟", [segment("读阵列", near.issue, near.ready), segment("固定延迟等待", near.ready, near.fixed, "wait")], near.fixed),
            lane("N · 可变延迟", [segment("读阵列", near.issue, near.ready), segment("skid buffer", near.ready, near.variable, "wait")], near.variable),
          ],
          data: table("逐请求时刻", ["请求", "发出", "就绪", "固定返回", "可变返回"], [...far, near].map(row =>
            [row.id, cycle(row.issue), cycle(row.ready), cycle(row.fixed), cycle(row.variable)])),
        };
      },
    },
    {
      id: "snoop-limit", name: "实时 snoop", title: "限制普通 snoop 能把哪段等待压下来？",
      patents: [["US10795818B1", 5, "权 1，图 4–7"]],
      setup: "目标敏感请求在 t0 到达。一个服务端口，服务中途不可打断。已有敏感请求排在普通请求前，每笔占 3 拍。限额方案在目标前保留至多 N 笔普通请求，其余普通请求随后继续服务。",
      fields: [num("backlog", "已排队普通请求", 5, 0, 12), num("limit", "目标之前的普通请求上限", 2, 0, 12),
        num("ticksPerRequest", "每笔普通请求占用拍数", 4, 1, 10), num("busy", "在途事务剩余占用拍数", 0, 0, 20),
        num("olderSensitive", "已排队敏感请求", 0, 0, 4)],
      cases: [["目录中的默认算例", {}], ["已有事务占用端口", { busy: 11, olderSensitive: 2 }], ["队列低于上限", { backlog: 2 }]],
      run(values) {
        const { baseline, limited, target } = t.snoopTrace(values);
        const saved = baseline.targetStart - limited.targetStart;
        const floor = values.busy + values.olderSensitive * 3;
        const normalDelay = limited.ordinaryMax - baseline.ordinaryMax;
        const tracks = schedule => schedule.rows.map(job =>
          segment(job.id, job.start, job.end, job.kind === "target" ? "focus" : job.kind === "normal" ? "work" : "wait"));
        const order = baseline.rows.map(job => {
          const after = limited.rows.find(row => row.id === job.id);
          return [job.id, cycle(job.start), cycle(after.start), plus(after.start - job.start) + " 拍"];
        });
        return {
          metrics: [["目标开始服务 · FIFO / 限额", baseline.targetStart + " / " + limited.targetStart + " 拍"],
            ["FIFO 到限额减少", saved + " 拍"], ["最晚普通请求开始时间变化", plus(normalDelay) + " 拍"]],
          explanation: "在途事务和旧敏感请求占 " + floor + " 拍，限额无法缩短这段。两种策略分别在前面留 " +
            values.backlog + " 和 " + Math.min(values.backlog, values.limit) + " 笔普通请求。这里所有请求都服务完，共用 " + baseline.finish + " 拍。",
          lanes: [lane("FIFO · " + target, tracks(baseline), baseline.targetStart),
            lane("普通请求限额 · " + target, tracks(limited), limited.targetStart)],
          data: table("请求何时开始服务", ["请求", "FIFO", "限额", "限额 − FIFO"], order),
        };
      },
    },
    {
      id: "bypass", name: "跨簇回填旁路", title: "跨簇回填旁路何时会被转换队列拖慢？",
      patents: [["US11016913B1", 5, "权 1–3、10，图 2–4"], ["US11537538B2", 2, "同族对照"]],
      setup: "B 连续发出不同缓存行的携数据响应。B 到汇聚点和汇聚点到 A 各需 2 拍。PoC 每跳 1 拍，生成回填用 1 拍。旁路转换单元按 FIFO 串行服务。两种方案各用同样的下行发射间隔。模型为原响应上行预留独立路径。",
      fields: [num("controllerHops", "汇聚点到 PoC 的单程跳数", 5, 0, 16),
        num("mergeWork", "节点转换用时", 1, 0, 20), num("controllerWait", "发往 PoC 前的等待", 0, 0, 20),
        num("mergeWait", "转换前固定等待", 0, 0, 25), num("sharedWait", "下行前固定等待", 0, 0, 25),
        num("count", "连续响应数", 1, 1, 16), num("gap", "原响应到达间隔", 1, 1, 12),
        num("downlinkInterval", "下行发射间隔", 1, 1, 12)],
      cases: [["单笔基线", {}], ["转换队列积压", { count: 8, mergeWork: 3 }, "converter-queue"],
        ["下行端口受限", { count: 8, downlinkInterval: 3 }]],
      run(v) {
        const { rows } = t.fillTrace(v);
        const last = rows.at(-1);
        const firstDiff = rows[0].baseline - rows[0].bypass;
        const lastDiff = last.baseline - last.bypass;
        const start = segment("B 到节点", last.sent, last.toMerge);
        const uplink = [segment("上行等待", last.toMerge, last.toMerge + v.controllerWait, "wait"),
          segment("节点到 PoC", last.toMerge + v.controllerWait, last.toController)];
        const toA = (ready, launch, end) => [
          segment("等下行", ready, launch, "wait"), segment("节点到 A", launch, end),
        ];
        return {
          metrics: [["末笔回填延迟 · 经 PoC / 旁路", (last.baseline - last.sent) + " / " + (last.bypass - last.sent) + " 拍"],
            ["首笔节省", plus(firstDiff) + " 拍"], ["末笔节省", plus(lastDiff) + " 拍"]],
          explanation: "同轴轨迹显示末笔事务。转换单元在前一笔结束后才开始处理下一笔，末笔因此多等 " +
            (last.conversionStart - last.toMerge - v.mergeWait) + " 拍。表中回填延迟和 PoC 到达延迟均从各笔原响应发出计时。",
          lanes: [
            lane("经 PoC 回填", [start, ...uplink, segment("PoC 生成回填", last.toController, last.toController + 1),
              segment("PoC 返回节点", last.toController + 1, last.fillAtMerge),
              ...toA(last.fillAtMerge, last.baselineSend, last.baseline)], last.baseline),
            lane("汇聚点旁路", [start, segment("等转换资源", last.toMerge, last.conversionStart, "wait"),
              segment("节点转换", last.conversionStart, last.localFill), ...toA(last.localFill, last.bypassSend, last.bypass)], last.bypass),
            lane("并行原响应", [start, ...uplink], last.toController),
          ],
          data: table("逐笔对照（拍）", ["事务", "发出时刻", "转换排队", "经 PoC 回填", "旁路回填", "原响应到 PoC"], rows.map((row, index) => [
            "R" + (index + 1), cycle(row.sent), row.conversionStart - row.toMerge - v.mergeWait,
            row.baseline - row.sent, row.bypass - row.sent, row.toController - row.sent,
          ])),
        };
      },
    },
    {
      id: "partial-line", name: "部分有效行", title: "补齐一行时，为什么不能直接覆盖缓存？",
      patents: [["US11586552B2", 4, "权 1、9，图 3"], ["US12007901B2", 2, "写入路径"]],
      setup: "缓存行有四个字。开启有效位代表该字已修改，仍有效的最新值来自缓存。模型用整行返回的下层值对照覆盖与合并。读、写从同一个初始快照独立执行。",
      fields: [yn("v0", "字 0 有效", true), yn("v1", "字 1 有效", false), yn("v2", "字 2 有效", true), yn("v3", "字 3 有效", false),
        num("writeIndex", "写入第几个字（0–3）", 1, 0, 3), num("writeValue", "写入值", 99, 0, 255)],
      cases: [["部分有效行", {}], ["四个字都要取下层", { v0: false, v2: false }], ["写完全部有效", { v3: true }]],
      run(v) {
        const validMask = [v.v0, v.v1, v.v2, v.v3].reduce((mask, bit, i) => mask | (Number(bit) << i), 0);
        const r = m.partialLine({ ...v, validMask });
        const cached = r.cachedBefore.filter(value => value !== null).length;
        return {
          metrics: [["直接覆盖会弄错", cached + " 个字"], ["逐字合并从缓存取", cached + " 个字"],
            ["写后有效位 · 字 3 到字 0", r.nextMask.toString(2).padStart(4, "0")]],
          explanation: "有效位逐字决定返回值的来源。这个例子请求到了整行下层数据，因此从下层采用 " + (4 - cached) +
            " 个字只改变合并器的选择。写分支只改字 " + v.writeIndex + " 和该字的有效位。",
          data: table("每个字的读写结果", ["字", "初始缓存", "下层返回 / 盲覆盖", "合并后返回", "结果来源", "写后缓存", "写后内存"],
            r.read.map((word, i) => [i, r.cachedBefore[i] ?? "无效", r.memory[i], word,
              r.cachedBefore[i] === null ? "下层" : "缓存", r.writeCache[i] ?? "无效", r.writeMemory[i]])),
        };
      },
    },
    {
      id: "probe-ahead", name: "提前准备缺失队列", title: "提前入队何时缩短缺失请求的等待？",
      patents: [["US9201796B2", 2, "权 1、7，图 6–8"]],
      setup: "H 是标签命中，M 是缺失。请求按固定间隔到达，标签查询相互独立。提前方案仅在到达后一拍尝试占槽，失败则等缺失确认。队列先释放再接纳，确认的缺失优先。外存接口可立即接收就绪的读。",
      fields: [select("pattern", "请求序列", "MHHM", [["MHHM", "M H H M"], ["HHHM", "H H H M"], ["MMMM", "M M M M"], ["MMHH", "M M H H"]]),
        num("gap", "相邻请求到达间隔", 2, 1, 10), num("lookup", "标签查询用时", 4, 2, 20),
        num("prepare", "入队后准备时长", 2, 1, 20), num("slots", "缺失队列条目数", 2, 1, 6)],
      cases: [["混合命中和缺失", {}], ["命中也占槽", { pattern: "HHHM", gap: 1, lookup: 6, slots: 2 }], ["单槽连续缺失", { pattern: "MMMM", gap: 1, slots: 1 }]],
      run(v) {
        const serial = t.missQueueTrace(v, false);
        const early = t.missQueueTrace(v, true);
        const cancelled = early.requests.filter(row => !row.miss && row.enter !== null).length;
        const changes = serial.requests.map((row, i) => row.miss ? early.requests[i].issue - row.issue : null);
        const totalSaved = -changes.reduce((sum, value) => sum + (value ?? 0), 0);
        const delayed = early.requests.filter((_, i) => changes[i] > 0).map(row => row.id);
        const first = serial.requests[0];
        const alt = early.requests[0];
        const queue = row => row.enter === null ? [] : [segment("占用队列条目", row.enter, row.released, "wait")];
        const status = row => row.miss ? "发读 " + cycle(row.issue) : row.enter !== null ? "撤销 " + cycle(row.released) : "命中，未入队";
        return {
          metrics: [["缺失请求合计节省", plus(totalSaved) + " 拍"], ["发出变慢的缺失", delayed.length + " 笔"],
            ["队列占用 · 顺序 / 提前", serial.occupiedCycles + " / " + early.occupiedCycles + " 槽·拍"], ["命中后撤销", cancelled + " 项"]],
          explanation: "标签确认和队列准备都结束后，缺失才发外存读。占用量按每项从入队到释放累加。" + (delayed.length
            ? delayed.join("、") + " 发出得更晚。已确认的缺失在分配时优先，但要等已分配的条目释放。"
            : "提前占槽可重叠两段等待，命中后仍要释放条目。"),
          lanes: [lane("Q1 标签查询", [segment("查标签", first.arrive, first.tag)], first.tag),
            lane("Q1 顺序队列", queue(first), first.released), lane("Q1 提前队列", queue(alt), alt.released)],
          data: table("每条请求的队列结果", ["请求", "标签结果时刻", "顺序占槽", "顺序结果", "提前占槽", "提前结果", "发出时间变化"],
            serial.requests.map((row, i) => [row.id + (row.miss ? " · 缺失" : " · 命中"), cycle(row.tag),
              cycle(row.enter), status(row), cycle(early.requests[i].enter), status(early.requests[i]),
              row.miss ? plus(changes[i]) + " 拍" : "—"])),
        };
      },
    },
    {
      id: "admission", name: "分阶段预留", title: "缺失组满了，为什么命中还可以启动？",
      patents: [["US12619558B2", 3, "权 1、9–14，图 7、11–12"], ["US20250103520A1", 3, "公开申请"]],
      setup: "一笔请求在 t0 到达。三个资源组在指定时刻各开放一个条目，标签查询耗时 2 拍。分阶段方案的第一组含一项已预留的 retry 条目。基线要求三个资源组同时可用才启动标签。",
      fields: [select("request", "实际标签结果", "hit", [["hit", "直接命中"], ["snoop", "命中，需要 snoop"], ["miss", "缺失"]]),
        num("firstFree", "第一组何时可用", 0, 0, 30), num("missFree", "缺失组何时可用", 8, 0, 30),
        num("snoopFree", "snoop 组何时可用", 4, 0, 30)],
      cases: [["命中碰上满缺失组", {}], ["缺失等待重试", { request: "miss" }], ["入口资源才是瓶颈", { firstFree: 12 }]],
      run(v) {
        const r = t.admissionTrace(v);
        const next = { hit: "第一组", miss: "缺失组", snoop: "snoop 组" }[v.request];
        const retry = r.stagedReady - r.known;
        return {
          metrics: [["分阶段提前启动标签", (r.allTag - r.stagedTag) + " 拍"], ["分阶段等待后续资源", retry + " 拍"],
            ["可继续处理 · 一次预留 / 分阶段", cycle(r.allReady) + " / " + cycle(r.stagedReady)]],
          explanation: v.request === "hit" ? "直接命中只用第一组。基线中的等待来自为其他分支预留资源。"
            : "标签结果确定要用 " + next + "。分阶段查得更早时，若这一组还没空位，请求用保留的重试条目等待。图的终点是资源齐备，后续数据服务另计。",
          lanes: [lane("入口一次预留", [segment("等所有组", 0, r.allTag, "wait"), segment("查标签", r.allTag, r.allReady)], r.allReady),
            lane("分阶段预留", [segment("等第一组", 0, r.stagedTag, "wait"), segment("查标签", r.stagedTag, r.known),
              segment("重试条目等待", r.known, r.stagedReady, "wait")], r.stagedReady)],
          data: table("两次资源检查", ["阶段", "入口一次预留", "分阶段预留"], [
            ["查标签前", "三个资源组", "第一组"],
            ["查到结果后", "使用已预留的 " + next, "需要 " + next + (retry ? "，先入重试条目" : "，当时已有可用条目")],
            ["可继续处理", cycle(r.allReady), cycle(r.stagedReady)],
          ]),
        };
      },
    },
    {
      id: "read-turn", name: "关键读切换轮次", title: "让关键读插进写轮次，会推迟多少写？",
      patents: [["US12730763B2", 2, "权 1、4，图 5–7"]],
      setup: "一拍服务一笔写，关键读在写请求之间到达，占用 2 拍。两个方向的切换代价都设为同样的拍数。模型在到达时判定门槛一次，读后可以继续服务剩余写。",
      fields: [num("written", "读到达前已服务的写", 2, 0, 12), num("remainingWrites", "本轮剩余写", 6, 0, 20),
        yn("critical", "处理器标记为关键读", true), num("free", "指定写队列空位", 4, 0, 20),
        num("minimum", "空位下限", 3, 0, 20), yn("otherCriteria", "其他门槛已满足", true),
        num("turnDelay", "每次总线切换代价", 2, 0, 12)],
      cases: [["有空位，提前切换", {}], ["空位不足", { free: 1 }], ["写轮次已经结束", { remainingWrites: 0 }]],
      run(v) {
        const base = t.writeTurnTrace({ ...v, critical: false }, m.readTurn);
        const r = t.writeTurnTrace(v, m.readTurn);
        function route(result) {
          const switchAt = result.switched ? v.written : result.planned;
          const spans = [segment("已完成的写", 0, v.written),
            segment("剩余写", v.written, switchAt), segment("写转读", switchAt, result.firstRead, "wait"),
            segment("服务读", result.firstRead, result.readDone, "focus")];
          if (result.switched) spans.push(segment("读转写", result.readDone, result.resume, "wait"),
            segment("恢复剩余写", result.resume, result.finishWrites));
          return spans;
        }
        return {
          metrics: [["读服务提前", (base.firstRead - r.firstRead) + " 拍"],
            ["延后的写请求", (r.switched ? v.remainingWrites : 0) + " 笔"], ["这批写全部完成的时刻变化", plus(r.finishWrites - base.finishWrites) + " 拍"]],
          explanation: r.switched ? "空位和其他门槛允许在当前边界切换。读之后，剩余写要等读服务和回切，继续时仍有原来的写工作量。"
            : "当前边界按原写轮次推进。检查下面哪项门槛没有通过，或是否已经没有写要延后。",
          lanes: [lane("完成当前写轮次再读", route(base), base.firstRead), lane("允许提前切换", route(r), r.firstRead)],
          data: table("到达时的切换条件", ["门槛", "当前值", "通过"], [
            ["处理器标记", v.critical ? "关键" : "普通", v.critical ? "是" : "否"],
            ["指定队列空位", v.free + "，下限 " + v.minimum, v.free >= v.minimum ? "是" : "否"],
            ["其他条件", "由场景设定", v.otherCriteria ? "是" : "否"],
            ["本轮还有写", v.remainingWrites + " 笔", v.remainingWrites > 0 ? "是" : "否"],
          ]),
        };
      },
    },
    {
      id: "quota", name: "SLC 配额共享", title: "配额总和超出容量，会帮谁、挤走谁？",
      patents: [["US9043570B2", 4, "权 1、5，图 6、8–9"]],
      setup: "缓存从空开始，用一个全相联 set 模拟。固定划分把容量平分给 A、B。共享方案按组限制上限，组满时只在组内选候选。以下用 LRU 决定候选，地址的首字母是归属组。",
      fields: [num("capacity", "物理行数", 6, 2, 10), num("quotaA", "A 组上限", 5, 1, 12), num("quotaB", "B 组上限", 5, 1, 12),
        select("pattern", "地址序列", "A0 A1 A2 A3 A4 A0 A1 A2 A3 A4 B0 B1 B2 B3 B4 B0 B1 B2 B3 B4", [
          ["A0 A1 A2 A3 A4 A0 A1 A2 A3 A4 B0 B1 B2 B3 B4 B0 B1 B2 B3 B4", "A 先热、B 后热"],
          ["A0 B0 A1 B1 A2 B2 A3 B3 A0 B0 A1 B1 A2 B2 A3 B3", "两组同时争用"],
          [quotaBurst, "B 的突发冲掉 A 的热行"],
        ])],
      cases: [["错峰工作集", {}], ["同时争用", { pattern: "A0 B0 A1 B1 A2 B2 A3 B3 A0 B0 A1 B1 A2 B2 A3 B3" }],
        ["B 的突发冲掉 A 的热行", { pattern: quotaBurst }], ["本组配额先耗尽", { quotaA: 2 }]],
      run(v) {
        const split = Math.floor(v.capacity / 2);
        const fixed = t.quotaTrace({ ...v, split }, false);
        const shared = t.quotaTrace({ ...v, split }, true);
        const change = shared.hits - fixed.hits;
        const verdict = row => row.hit ? "命中" : row.victim ? "逐出 " + row.victim : "填空位";
        return {
          metrics: [["命中数 · 固定 / 共享", fixed.hits + " / " + shared.hits], ["共享跨组逐出", shared.cross + " 次"],
            ["共享方案命中变化", plus(change) + " 次"]],
          explanation: "固定区给 A " + split + " 行，给 B " + (v.capacity - split) + " 行。共享上限总计 " +
            (v.quotaA + v.quotaB) + " 行，物理容量 " + v.capacity + " 行。逐次查看谁被逐出，以及重复访问时还在不在。",
          data: table("每次访问后的分配和驻留", ["次序 / 地址", "固定划分", "共享配额", "共享候选规则", "共享驻留行 · LRU → MRU"],
            shared.rows.map((row, i) => [(i + 1) + " · " + row.key, verdict(fixed.rows[i]), verdict(row), row.reason, row.cache.join(" ")])),
        };
      },
    },
    {
      id: "deny-list", name: "预取限制表", title: "过去没用的预取，下一次也该拦吗？",
      patents: [["US12306762B1", 3, "权 1、2，图 6–8"]],
      setup: "逐事件跟踪地址 X。P 是预取候选，E 是压力导致的逐出，D 是需求读。预取行被需求读命中过，逐出时计数清零。未使用的预取行逐出时计数加一，达到门槛后才拦预取。",
      fields: [select("pattern", "访问序列", "PEPEPE", [["PEPEPE", "反复预取后逐出"],
        ["PEPD", "下一次预取会被需求命中"], ["PDEPD", "逐出前已被需求命中"], ["PEPEPD", "第三次才出现需求"]]),
        num("threshold", "激活所需的未使用逐出次数", 1, 1, 5)],
      cases: [["反复浪费下层读", {}], ["错拦有用预取", { pattern: "PEPD" }], ["提高门槛保留机会", { pattern: "PEPD", threshold: 2 }]],
      run(v) {
        const base = t.prefetchTrace(v, false);
        const limited = t.prefetchTrace(v, true);
        const extra = limited.misses - base.misses;
        return {
          metrics: [["下层读 · 直接预取 / 查表", base.reads + " / " + limited.reads],
            ["限制表拦下的预取", limited.blocked + " 次"], ["需求缺失变化", plus(extra) + " 次"]],
          explanation: extra > 0 ? "旧记录拦下了一次后来确实有用的预取。D 到来时 X 尚未驻留，原本可提前发出的下层读挪到了需求路径。"
            : "跟踪计数与逐出事件。限制表只检查 P，需求读 D 可以访问下层。这里直接统计读次数和需求命中，未给内存传输设固定延迟。",
          data: table("逐事件状态", ["事件", "直接预取", "查限制表", "未使用逐出计数", "启用限制表后 X 驻留"],
            limited.rows.map((row, i) => [(i + 1) + " · " + row.event, base.rows[i].action, row.action, row.score, row.present ? "是" : "否"])),
        };
      },
    },
    {
      id: "clpc-frame", name: "CLPC 工作窗口", title: "降低性能状态后，突发负载是否还能按期完成？",
      patents: [["US11579934B2", 2, "图 3，工作间隔利用率"]],
      setup: "每个工作窗口有独立的截止时间。超期后丢弃该窗口的剩余工作。模型中三个性能状态每拍处理 1、2 或 4 个工作单位。基线始终请求最高性能状态。反馈控制器用当前窗口的执行时间占比选择下一窗口的性能状态，目标附近保留 ±12 个百分点的容差。最后四个窗口受系统性能上限约束。",
      fields: [select("pattern", "每窗工作量", "3,3,3,3,18,18,18,18", [
        ["3,3,3,3,18,18,18,18", "低负载后突发"], ["3,3,4,4,3,4,4,3", "持续轻载"],
        ["4,6,8,10,14,17,18,18", "逐渐上升"],
      ]), num("deadline", "工作窗期限（拍）", 6, 3, 12), num("target", "目标使用时间占比（%）", 75, 45, 85),
      num("cap", "后四个窗口的最高性能状态", 3, 1, 3)],
      cases: [["突发负载", {}], ["持续轻载", { pattern: "3,3,4,4,3,4,4,3" }], ["最高性能状态为 2", { cap: 2 }]],
      run(v) {
        const fixed = t.framePolicyTrace(v, false);
        const loop = t.framePolicyTrace(v, true);
        const misses = rows => rows.filter(row => !row.completed).length;
        const high = rows => rows.filter(row => row.gear === 3).length;
        const clipped = loop.filter(row => row.requested > row.limit).length;
        const status = row => row.completed ? "完成" : "超期";
        const spans = rows => rows.map((row, i) => segment("窗口 " + (i + 1) + " / 状态 " + row.gear,
          i * v.deadline, (i + 1) * v.deadline, row.completed ? "work" : "wait"));
        return {
          metrics: [["超期工作窗 · 固定 / 反馈", misses(fixed) + " / " + misses(loop)],
            ["最高性能状态的窗口数 · 基线 / 反馈", high(fixed) + " / " + high(loop)], ["系统上限约束的请求", clipped + " 个窗口"]],
          explanation: "控制器请求的性能状态受系统上限约束。超期时，模型将当前窗口的执行时间占比截断为 100%，再用它计算下一窗口的请求。突发负载到来前，控制器只能根据此前的工作量作出决定。",
          lanes: [lane("固定请求最高性能状态", spans(fixed)), lane("按工作窗口反馈", spans(loop))],
          data: table("工作量及请求与实际性能状态", ["工作窗口", "工作量", "基线状态与结果", "请求状态 → 实际状态", "完成时间 / 截止时间", "反馈结果", "下一窗口的请求"],
            loop.map((row, i) => [i + 1, row.work, fixed[i].gear + " · " + status(fixed[i]), row.requested + " → " + row.gear,
              row.needed + " / " + v.deadline + " 拍", status(row), row.next])),
        };
      },
    },
    {
      id: "battery-window", name: "供电预测窗", title: "为什么同样的短脉冲连续出现时会触及截止电压？",
      patents: [["US12573870B2", 4, "权 1、12，图 6–8"]],
      setup: "模型电池初始开路 4 V，截止 3.4 V，欧姆电阻 100 mΩ。脉冲内恒流，脉冲间零负载。单笔比较瞬时限流与按窗限流。连续脉冲比较每次从零极化估计和持续追踪极化两种策略。",
      fields: [num("horizon", "供电持续时长（ms）", 1000, 50, 5000), num("tau", "极化时间常数（ms）", 1000, 100, 5000),
        num("polarization", "极化电阻（mΩ）", 200, 0, 350), num("demand", "请求电流（mA）", 4000, 0, 6000),
        num("count", "脉冲数", 1, 1, 16), num("idle", "脉冲之间的恢复时间（ms）", 50, 0, 10000)],
      cases: [["单个 200 ms 脉冲", { horizon: 200 }], ["3 s 持续负载", { horizon: 3000 }],
        ["短脉冲连续到来", { horizon: 200, count: 8 }, "pulse-train"], ["脉冲间充分恢复", { horizon: 200, count: 8, idle: 4000 }]],
      run(v) {
        const r = t.batteryPulseTrace(v);
        const voltage = value => value.toFixed(3) + " V";
        if (v.count > 1) {
          const resetMin = Math.min(...r.pulses.map(row => row.reset.minimum));
          const trackedMin = Math.min(...r.pulses.map(row => row.tracked.minimum));
          const misses = r.pulses.filter(row => row.reset.minimum < r.cut - 1e-9).length;
          return {
            metrics: [["最低端电压 · 按零估计 / 追踪状态", voltage(resetMin) + " / " + voltage(trackedMin)],
              ["按零估计的欠压脉冲", misses + " / " + v.count]],
            explanation: "每次脉冲先承担欧姆压降，再随 RC 状态变化。剩余极化衰减需要时间。追踪状态的预测器用本次起始极化估算限流，表中的实际供电电流给出为守住截止电压付出的代价。",
            data: table("逐脉冲比较", ["序号", "起始极化（mV）· 按零估计 / 追踪", "实际供电（A）· 按零估计 / 追踪", "最低端电压 · 按零估计 / 追踪"],
              r.pulses.map(({ reset, tracked }, index) => [index + 1,
                Math.round(reset.residual * 1000) + " / " + Math.round(tracked.residual * 1000),
                reset.current.toFixed(2) + " / " + tracked.current.toFixed(2),
                voltage(reset.minimum) + " / " + voltage(tracked.minimum)])),
          };
        }
        const last = r.rows.at(-1);
        const violated = last.staticVoltage < r.cut - 1e-9;
        return {
          metrics: [["末端电压 · 瞬时 / 按窗限流", voltage(last.staticVoltage) + " / " + voltage(last.windowVoltage)],
            ["实际供电电流 · 瞬时 / 按窗限流", r.currentStatic.toFixed(2) + " / " + r.currentWindow.toFixed(2) + " A"],
            ["该时窗的最大电流", r.limit.toFixed(2) + " A"]],
          explanation: (violated ? "只按欧姆压降放行会跌穿 3.4 V。较长窗口采用更高的等效阻抗，会提前收紧可用电流。"
            : "本例的瞬时限流在窗口末仍守住截止线。逐点查看极化压降，对照长脉冲场景。") + " 每个采样点都保留了两条路径的电压。",
          data: table("相同电池模型下的端电压轨迹", ["时刻（ms）", "等效阻抗（mΩ）", "瞬时限流", "瞬时裕量（mV）", "按窗限流"],
            r.rows.map(row => [row.ms, (row.resistance * 1000).toFixed(1), voltage(row.staticVoltage),
              plus(Math.round((row.staticVoltage - r.cut) * 1000)), voltage(row.windowVoltage)])),
        };
      },
    },
    {
      id: "memory-pause", name: "跨裸片暂停握手", title: "内存暂停前，读缓冲和写缓冲各要准备多少？",
      patents: [["US12332723B2", 2, "权 1–4，专利图 5"]],
      setup: "两个裸片各有发起访存的代理。主裸片计划暂停内存服务，读端继续取数据，写端继续产生数据。读缓冲和写缓冲各有 12 项容量。内存可用时，读端预取数据、写端排出待写数据，两端并行按每拍 2 项的净速率准备，到各自门槛后维持余量。容量和准备速率由模型设定，确认传播延迟设为零。",
      fields: [num("pause", "内存暂停长度（拍）", 4, 1, 10), num("readRate", "每拍读取（项）", 2, 1, 4),
        num("writeRate", "每拍写入（项）", 1, 1, 4), num("readStock", "初始读缓冲有效数据（项）", 6, 0, 12),
        num("writeFree", "初始写缓冲空闲项", 6, 0, 12)],
      cases: [["只需预填读缓冲", {}], ["读写两端并行准备", { readStock: 2, writeFree: 4, writeRate: 2 }],
        ["任一端容量不足", { pause: 7 }], ["余量足够，立即确认", { readStock: 8 }]],
      run(v) {
        const r = t.memoryPauseTrace(v);
        const last = r.rows.at(-1);
        const firstLost = r.rows.find(row => row.baseline.missed || row.baseline.overflow);
        const safeUntil = firstLost ? firstLost.time - 1 : v.pause;
        const levels = state => state.read + " / " + state.free;
        const losses = state => state.missed + " / " + state.overflow;
        return {
          metrics: [["读缓冲所需数据 / 写缓冲所需空闲项", r.readNeed + " / " + r.writeNeed + " 项"],
            ["确认并启动暂停", r.start === null ? "持续等待" : cycle(r.start)],
            ["读欠供 / 写溢出 · 立即 → 等确认", losses(last.baseline) + " → " + (r.start === null ? "未暂停" : losses(last.guarded))]],
          explanation: r.start === null
            ? "至少一端的需求超过 12 项。主裸片未收到正向确认，内存继续提供服务。有限窗口里的持续等待表示这组固定条件无法放行。"
            : "读端要在暂停期间持续供数，写端要吸收同一时段的新数据。两端可以并行准备，较晚达到门槛的一端决定确认时刻。暂停结束时，读缓冲可用数据或写缓冲空闲项恰好归零也能完成。",
          lanes: [lane("立即启动暂停", [segment("内存暂停", 0, safeUntil), segment("欠供或溢出", safeUntil, v.pause, "wait")]),
            lane("等两端确认后暂停", r.start === null ? [segment("继续服务，等待确认", 0, last.time, "wait")] : [
              segment("准备读写余量", 0, r.start, "wait"), segment("内存暂停", r.start, last.time),
            ], r.start)],
          data: table("各拍边界的缓冲余量与累计损失", ["时刻", "基线读数据 / 写空闲项", "基线欠供 / 溢出",
            "握手状态", "握手读数据 / 写空闲项", "握手欠供 / 溢出"], r.rows.map(row => [cycle(row.time),
            row.time <= v.pause ? levels(row.baseline) : "—", row.time <= v.pause ? losses(row.baseline) : "—",
            row.time === r.start ? "确认 / 开始暂停" : r.start === null || row.time < r.start ? "等待确认" :
              row.time === last.time ? "恢复内存服务" : "暂停中",
            levels(row.guarded), losses(row.guarded)])),
        };
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
    label.append(element("span", field.label), control);
    container.append(label);
    return control;
  }

  function scrollRegion(label, className) {
    const region = element("div", undefined, className);
    region.tabIndex = 0;
    region.setAttribute("role", "region");
    region.setAttribute("aria-label", label);
    return region;
  }

  function renderTable(data) {
    const region = scrollRegion(data.title, "lab-table-scroll");
    const matrix = element("table", undefined, "lab-table");
    const head = matrix.createTHead().insertRow();
    for (const label of data.columns) {
      const cell = element("th", label);
      cell.scope = "col";
      head.append(cell);
    }
    const body = matrix.createTBody();
    for (const values of data.rows) {
      const row = body.insertRow();
      const label = element("th", values[0]);
      label.scope = "row";
      row.append(label);
      for (const value of values.slice(1)) row.append(element("td", value));
    }
    matrix.prepend(element("caption", data.title));
    region.append(matrix);
    return region;
  }

  function renderTrace(lanes) {
    const end = Math.max(1, ...lanes.flatMap(row => [row.mark ?? 0, ...row.spans.map(span => span.to)]));
    const ticks = [...new Set(Array.from({ length: 6 }, (_, i) => Math.round(end * i / 5)))];
    const region = scrollRegion("同轴事件图，单位为模型拍", "lab-trace-scroll");
    const chart = element("div", undefined, "lab-trace");
    const axis = element("div", undefined, "lab-trace-axis");
    for (const tick of ticks) {
      const mark = element("span", tick);
      mark.style.left = tick * 100 / end + "%";
      axis.append(mark);
    }
    chart.append(element("span", "模型拍 · ◆ 观测时刻"), axis);
    for (const row of lanes) {
      const track = element("div", undefined, "lab-track");
      for (const tick of ticks.slice(1, -1)) {
        const guide = element("i", undefined, "lab-track-guide");
        guide.style.left = tick * 100 / end + "%";
        track.append(guide);
      }
      for (const span of row.spans) {
        if (span.to <= span.from) continue;
        const part = element("span", span.label, "lab-segment " + span.tone);
        part.title = span.label + " · " + cycle(span.from) + "–" + cycle(span.to);
        part.style.left = span.from * 100 / end + "%";
        part.style.width = (span.to - span.from) * 100 / end + "%";
        track.append(part);
      }
      if (row.mark !== null) {
        const event = element("span", undefined, "lab-track-event");
        event.title = "观测时刻 " + cycle(row.mark);
        event.setAttribute("aria-label", event.title);
        event.style.left = row.mark * 100 / end + "%";
        track.append(event);
      }
      chart.append(element("div", row.name, "lab-track-name"), track);
    }
    region.append(chart);
    return region;
  }

  const nav = document.getElementById("lab-nav");
  const lab = document.getElementById("lab");
  const activeId = location.hash.slice(1);
  const scenario = new URLSearchParams(location.search).get("scenario");
  for (const experiment of experiments) {
    nav.append(link(experiment.name, "#" + experiment.id));
    const card = element("article", undefined, "lab-model");
    card.id = experiment.id;
    const controls = element("div", undefined, "model-controls");
    const fields = experiment.fields.map(field => ({ ...field, control: addField(controls, field) }));
    const presets = element("div", undefined, "lab-presets");
    presets.setAttribute("role", "group");
    presets.setAttribute("aria-label", "实验场景");
    const buttons = experiment.cases.map(([label, changes, id]) => {
      const button = element("button", label);
      button.type = "button";
      button.addEventListener("click", () => {
        for (const field of fields) field.control.value = String(changes[field.name] ?? field.initial);
        recompute();
      });
      presets.append(button);
      return { button, changes, id };
    });
    const results = element("div", undefined, "model-result");
    results.setAttribute("aria-live", "polite");
    const diagram = element("div", undefined, "lab-output");
    const sources = element("p", "专利依据 ", "model-sources");
    for (const [i, [id, figure, description]] of experiment.patents.entries()) {
      if (i) sources.append(" · ");
      sources.append(link(id + " · " + description, "patents/" + id + ".html#fig-" + figure));
    }
    card.append(element("h2", experiment.title), element("p", experiment.setup, "lab-setup"),
      presets, controls, results, diagram, sources);

    function recompute() {
      const values = Object.fromEntries(fields.map(field => [field.name, field.values
        ? field.values.find(([value]) => String(value) === field.control.value)[0]
        : field.control.validity.valid ? field.control.valueAsNumber : undefined]));
      for (const { button, changes } of buttons) {
        button.setAttribute("aria-pressed", String(fields.every(field => values[field.name] === (changes[field.name] ?? field.initial))));
      }
      if (Object.values(values).includes(undefined)) {
        results.replaceChildren(element("p", "请填写输入框允许范围内的整数。"));
        diagram.replaceChildren();
        return;
      }
      const data = experiment.run(values);
      const summary = element("dl", undefined, "lab-metrics");
      for (const [name, value] of data.metrics) {
        const metric = element("div");
        metric.append(element("dt", name), element("dd", value));
        summary.append(metric);
      }
      results.replaceChildren(summary, element("p", data.explanation));
      diagram.replaceChildren(...(data.lanes ? [renderTrace(data.lanes)] : []), renderTable(data.data));
    }

    controls.addEventListener("input", recompute);
    controls.addEventListener("change", recompute);
    lab.append(card);
    const initial = experiment.id === activeId && buttons.find(item => item.id === scenario);
    if (initial) initial.button.click();
    else recompute();
  }
  if (activeId && experiments.some(item => item.id === activeId)) {
    document.getElementById(activeId).scrollIntoView();
  }
})();

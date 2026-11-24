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
      id: "bypass", name: "跨簇回填旁路", title: "跨簇旁路省下哪段回程？",
      patents: [["US11016913B1", 5, "权 1–3、10，图 2–4"], ["US11537538B2", 2, "同族对照"]],
      setup: "B 发出携数据响应时记 t0。B 到汇聚点、汇聚点到 A 各需 2 拍，PoC 每跳 1 拍、生成回填用 1 拍。原响应可并行送 PoC。模型为几条链路分别设置一次等待。",
      fields: [num("controllerHops", "汇聚点到 PoC 的单程跳数", 5, 0, 16),
        num("mergeWork", "节点转换用时", 1, 0, 20), num("controllerWait", "发往 PoC 前的等待", 0, 0, 20),
        num("mergeWait", "汇聚点转换前的等待", 0, 0, 25), num("sharedWait", "两路径共用的下行等待", 0, 0, 25)],
      cases: [["专利图谱算例", {}], ["两条路一样快", { controllerHops: 0 }], ["旁路转换排队", { mergeWait: 12 }], ["共用下行堵塞", { sharedWait: 15 }]],
      run(v) {
        const r = t.fillTrace(v);
        const diff = r.baseline - r.bypass;
        const foot = diff === 0 ? "两条路径都在同一拍返回数据。" : "采用旁路后，A " + (diff > 0 ? "提前 " : "延后 ") + Math.abs(diff) + " 拍收到数据。";
        const start = segment("B 到节点", 0, 2);
        const uplink = [segment("上行等待", 2, 2 + v.controllerWait, "wait"),
          segment("节点到 PoC", 2 + v.controllerWait, r.toController)];
        const toA = end => [segment("共用下行等待", end - 2 - v.sharedWait, end - 2, "wait"), segment("节点到 A", end - 2, end)];
        return {
          metrics: [["A 收到数据 · 经 PoC / 旁路", r.baseline + " / " + r.bypass + " 拍"],
            ["原响应抵达 PoC", cycle(r.toController)], ["省下的时间", plus(diff) + " 拍"]],
          explanation: foot + " PoC 往返链路、上行等待和控制器生成回填共 " +
            (r.fillAtMerge - 2) + " 拍。旁路改为在节点等待和转换，共 " + (r.localFill - 2) +
            " 拍。共用下行等待同时推迟两条路径，时间差由前两项决定。",
          lanes: [
            lane("经 PoC 回填", [start, ...uplink, segment("PoC 生成回填", r.toController, r.toController + 1),
              segment("PoC 返回节点", r.toController + 1, r.fillAtMerge), ...toA(r.baseline)], r.baseline),
            lane("汇聚点旁路", [start, segment("等转换资源", 2, 2 + v.mergeWait, "wait"),
              segment("节点转换", 2 + v.mergeWait, r.localFill), ...toA(r.bypass)], r.bypass),
            lane("并行原响应", [start, ...uplink], r.toController),
          ],
          data: table("关键位置的到达时刻", ["事件", "经 PoC", "旁路"], [
            ["B 的响应到汇聚点", cycle(r.toMerge), cycle(r.toMerge)],
            ["回填可从节点下行", cycle(r.fillAtMerge), cycle(r.localFill)],
            ["A 收到数据", cycle(r.baseline), cycle(r.bypass)],
          ]),
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
  for (const experiment of experiments) {
    nav.append(link(experiment.name, "#" + experiment.id));
    const card = element("article", undefined, "lab-model");
    card.id = experiment.id;
    const controls = element("div", undefined, "model-controls");
    const fields = experiment.fields.map(field => ({ ...field, control: addField(controls, field) }));
    const presets = element("div", undefined, "lab-presets");
    presets.setAttribute("role", "group");
    presets.setAttribute("aria-label", "实验场景");
    const buttons = experiment.cases.map(([label, changes]) => {
      const button = element("button", label);
      button.type = "button";
      button.addEventListener("click", () => {
        for (const field of fields) field.control.value = String(changes[field.name] ?? field.initial);
        recompute();
      });
      presets.append(button);
      return { button, changes };
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
    recompute();
  }
  const activeId = location.hash.slice(1);
  if (activeId && experiments.some(item => item.id === activeId)) {
    document.getElementById(activeId).scrollIntoView();
  }
})();

(() => {
  "use strict";

  function returnTrace({ farBurst, nearGap }) {
    const far = Array.from({ length: farBurst }, (_, tick) => ({
      id: "F" + (tick + 1), issue: tick, ready: tick + 4, fixed: tick + 4, variable: tick + 4,
    }));
    const issue = farBurst + nearGap;
    const near = { id: "N", issue, ready: issue + 1, fixed: issue + 4 };
    near.variable = near.ready;
    const reserved = new Set(far.map(row => row.variable));
    while (reserved.has(near.variable)) near.variable++;
    return { far, near };
  }

  function snoopTrace({ backlog, limit, ticksPerRequest, busy, olderSensitive }) {
    const normal = Array.from({ length: backlog }, (_, i) => ({
      id: "O" + (i + 1), duration: ticksPerRequest, kind: "normal",
    }));
    const earlier = Array.from({ length: olderSensitive }, (_, i) => ({
      id: "R" + (i + 1), duration: 3, kind: "earlier",
    }));
    const target = { id: "R" + (olderSensitive + 1), duration: 3, kind: "target" };
    function schedule(ahead) {
      let time = busy;
      const rows = busy ? [{ id: "已在途", kind: "active", start: 0, end: busy }] : [];
      for (const job of [...earlier, ...normal.slice(0, ahead), target, ...normal.slice(ahead)]) {
        rows.push({ ...job, start: time, end: time + job.duration });
        time += job.duration;
      }
      return {
        rows, targetStart: rows.find(row => row.kind === "target").start, finish: time,
        ordinaryMax: Math.max(0, ...rows.filter(row => row.kind === "normal").map(row => row.start)),
      };
    }
    return { baseline: schedule(backlog), limited: schedule(Math.min(backlog, limit)), target: target.id };
  }

  function fillTrace({ controllerHops, mergeWork, controllerWait, mergeWait, sharedWait, count = 1, gap = 1, downlinkInterval = 1 }) {
    let converterFreeAt = 0;
    let baselineLinkFreeAt = 0;
    let bypassLinkFreeAt = 0;
    const rows = Array.from({ length: count }, (_, index) => {
      const sent = index * gap;
      const toMerge = sent + 2;
      const toController = toMerge + controllerWait + controllerHops;
      const fillAtMerge = toController + 1 + controllerHops;
      const conversionStart = Math.max(toMerge + mergeWait, converterFreeAt);
      const localFill = conversionStart + mergeWork;
      converterFreeAt = localFill;
      const baselineSend = Math.max(fillAtMerge + sharedWait, baselineLinkFreeAt);
      const bypassSend = Math.max(localFill + sharedWait, bypassLinkFreeAt);
      baselineLinkFreeAt = baselineSend + downlinkInterval;
      bypassLinkFreeAt = bypassSend + downlinkInterval;
      return {
        sent, toMerge, toController, fillAtMerge, conversionStart, localFill, baselineSend, bypassSend,
        baseline: baselineSend + 2,
        bypass: bypassSend + 2,
      };
    });
    return { ...rows[0], rows };
  }

  function missQueueTrace({ pattern, gap, lookup, prepare, slots }, speculate) {
    const requests = [...pattern].map((outcome, index) => ({
      id: "Q" + (index + 1), arrive: index * gap, miss: outcome === "M",
      tag: index * gap + lookup, enter: null, released: null, issue: null, early: false,
    }));
    let tick = 0;
    let occupiedCycles = 0;
    let peak = 0;
    const workLeft = row => row.released === null && (row.miss || tick < row.tag || row.enter !== null);
    while (requests.some(workLeft)) {
      let active = requests.filter(row => row.enter !== null && row.released === null);
      for (const row of active) {
        if (tick < row.tag || (row.miss && tick < row.enter + prepare)) continue;
        row.released = tick;
        if (row.miss) row.issue = tick;
      }
      active = active.filter(row => row.released === null);
      const knownMisses = requests.filter(row => row.miss && row.tag <= tick && row.enter === null);
      const guesses = speculate ? requests.filter(row => row.arrive + 1 === tick) : [];
      for (const row of [...knownMisses, ...guesses]) {
        if (active.length === slots) break;
        row.enter = tick;
        row.early = tick < row.tag;
        active.push(row);
      }
      peak = Math.max(peak, active.length);
      occupiedCycles += active.length;
      tick++;
    }
    return { requests, occupiedCycles, peak };
  }

  function admissionTrace({ firstFree, missFree, snoopFree, request }) {
    const allTag = Math.max(firstFree, missFree, snoopFree);
    const stagedTag = firstFree;
    const known = stagedTag + 2;
    const available = { hit: known, miss: missFree, snoop: snoopFree }[request];
    return { allTag, allReady: allTag + 2, stagedTag, known, stagedReady: Math.max(known, available) };
  }

  function writeTurnTrace({ written, remainingWrites, turnDelay, ...criteria }, readTurn) {
    const { switched } = readTurn({ remainingWrites, ...criteria });
    const planned = written + remainingWrites;
    const service = 2;
    const firstRead = (switched ? written : planned) + turnDelay;
    return {
      switched, planned, service,
      firstRead, readDone: firstRead + service,
      resume: switched ? firstRead + service + turnDelay : null,
      finishWrites: switched ? firstRead + service + turnDelay + remainingWrites : planned,
    };
  }

  function quotaTrace({ capacity, quotaA, quotaB, split, pattern }, shared) {
    const limits = shared ? { A: quotaA, B: quotaB } : { A: split, B: capacity - split };
    const cache = [];
    const rows = [];
    let hits = 0;
    let cross = 0;
    for (const key of pattern.trim().split(/\s+/)) {
      const group = key[0];
      const hit = cache.indexOf(key);
      let victim = null;
      let reason;
      if (hit >= 0) {
        hits++;
        cache.splice(hit, 1);
        reason = "命中，移到 MRU";
      } else {
        const inGroup = cache.filter(line => line[0] === group);
        const capped = inGroup.length >= limits[group];
        if (capped) {
          victim = inGroup[0];
          reason = "本组达到上限，组内替换";
        } else if (cache.length === capacity) {
          victim = cache[0];
          reason = "缓存已满，可跨组找最旧行";
        } else {
          reason = "有空位，直接分配";
        }
        if (victim) {
          cache.splice(cache.indexOf(victim), 1);
          if (victim[0] !== group) cross++;
        }
      }
      cache.push(key);
      rows.push({
        key, hit: hit >= 0, victim, reason, cache: [...cache],
        countA: cache.filter(line => line[0] === "A").length,
      });
    }
    return { hits, cross, rows };
  }

  function prefetchTrace({ pattern, threshold }, filter) {
    let resident = null;
    let used = false;
    let score = 0;
    let reads = 0;
    let misses = 0;
    let blocked = 0;
    const rows = [...pattern].map(event => {
      let action;
      if (event === "E") {
        if (resident === "prefetch") score = used ? 0 : score + 1;
        action = resident ? (resident === "prefetch" && !used ? "逐出未使用预取" : "逐出已使用行") : "X 不在缓存";
        resident = null;
      } else if (event === "P") {
        if (resident) {
          action = "X 已驻留";
        } else if (filter && score >= threshold) {
          blocked++;
          action = "限制表拒绝预取";
        } else {
          reads++;
          resident = "prefetch";
          used = false;
          action = "发下层读，预取填入 X";
        }
      } else if (resident) {
        used = true;
        action = "需求命中";
      } else {
        reads++;
        misses++;
        resident = "demand";
        used = true;
        action = "需求缺失，发下层读";
      }
      return { event, action, score, present: Boolean(resident) };
    });
    return { rows, reads, misses, blocked };
  }

  function framePolicyTrace({ pattern, deadline, target, cap }, feedback) {
    const rates = [0, 1, 2, 4];
    let requested = 3;
    return pattern.split(",").map(Number).map((work, i) => {
      const limit = i < 4 ? 3 : cap;
      const gear = Math.min(requested, limit);
      const needed = work / rates[gear];
      const completed = needed <= deadline;
      const utilization = Math.min(needed, deadline) / deadline;
      let next = requested;
      if (feedback) {
        if (!completed || utilization > target / 100 + 0.12) next = Math.min(3, gear + 1);
        else if (utilization < target / 100 - 0.12) next = Math.max(1, gear - 1);
        else next = gear;
      }
      const row = { work, gear, needed, completed, utilization, requested, limit, next };
      requested = next;
      return row;
    });
  }

  function batteryPulseTrace({ horizon, tau, polarization, demand, count = 1, idle = 0 }) {
    const open = 4;
    const cut = 3.4;
    const ohmic = 0.1;
    const rc = polarization / 1000;
    const impedance = ms => ohmic + rc * (1 - Math.exp(-ms / tau));
    const decay = Math.exp(-horizon / tau);
    const rest = Math.exp(-idle / tau);
    const endResistance = impedance(horizon);
    const currentLimit = residual => Math.min(
      (open - cut - residual) / ohmic,
      (open - cut - residual * decay) / endResistance,
    );
    const limit = currentLimit(0);
    const currentStatic = Math.min(demand / 1000, (open - cut) / ohmic);
    const currentWindow = Math.min(demand / 1000, limit);
    const rows = Array.from({ length: 5 }, (_, index) => {
      const ms = horizon * index / 4;
      const resistance = impedance(ms);
      return { ms, resistance, staticVoltage: open - currentStatic * resistance, windowVoltage: open - currentWindow * resistance };
    });
    let resetResidual = 0;
    let trackedResidual = 0;
    function pulse(residual, current) {
      const after = residual * decay + current * rc * (1 - decay);
      return {
        residual, current,
        minimum: open - current * ohmic - Math.max(residual, after),
        nextResidual: after * rest,
      };
    }
    const pulses = Array.from({ length: count }, () => {
      const reset = pulse(resetResidual, currentWindow);
      const tracked = pulse(trackedResidual, Math.min(demand / 1000, currentLimit(trackedResidual)));
      resetResidual = reset.nextResidual;
      trackedResidual = tracked.nextResidual;
      return { reset, tracked };
    });
    return { cut, limit, currentStatic, currentWindow, rows, pulses };
  }

  function memoryPauseTrace({ pause, readRate, writeRate, readStock, writeFree }) {
    const capacity = 12;
    const prepRate = 2;
    const readNeed = pause * readRate;
    const writeNeed = pause * writeRate;
    const readTarget = Math.min(readNeed, capacity);
    const writeTarget = Math.min(writeNeed, capacity);
    const prep = Math.max(0, Math.ceil((readTarget - readStock) / prepRate),
      Math.ceil((writeTarget - writeFree) / prepRate));
    const start = readNeed <= capacity && writeNeed <= capacity ? prep : null;
    const baseline = { read: readStock, free: writeFree, missed: 0, overflow: 0 };
    const guarded = { ...baseline };

    function useBuffers(state) {
      state.missed += Math.max(0, readRate - state.read);
      state.overflow += Math.max(0, writeRate - state.free);
      state.read = Math.max(0, state.read - readRate);
      state.free = Math.max(0, state.free - writeRate);
    }

    const rows = Array.from({ length: 1 + (start === null ? Math.max(pause, prep) : start + pause) }, (_, time) => {
      const tick = time - 1;
      if (time > 0 && tick < pause) useBuffers(baseline);
      if (time > 0 && (start === null || tick < start)) {
        guarded.read = Math.max(guarded.read, Math.min(readTarget, guarded.read + prepRate));
        guarded.free = Math.max(guarded.free, Math.min(writeTarget, guarded.free + prepRate));
      } else if (time > 0) {
        useBuffers(guarded);
      }
      return { time, baseline: { ...baseline }, guarded: { ...guarded } };
    });
    return { capacity, readNeed, writeNeed, start, rows };
  }

  const traces = {
    returnTrace, snoopTrace, fillTrace, missQueueTrace, admissionTrace, writeTurnTrace, quotaTrace, prefetchTrace,
    framePolicyTrace, batteryPulseTrace, memoryPauseTrace,
  };
  if (typeof module === "object" && module.exports) module.exports = traces;
  else window.PatentTraces = traces;
})();

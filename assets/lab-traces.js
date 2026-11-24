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

  function fillTrace({ controllerHops, mergeWork, controllerWait, mergeWait, sharedWait }) {
    const toMerge = 2;
    const toController = toMerge + controllerWait + controllerHops;
    const fillAtMerge = toController + 1 + controllerHops;
    const localFill = toMerge + mergeWait + mergeWork;
    return {
      toMerge, toController, fillAtMerge, localFill,
      baseline: fillAtMerge + sharedWait + 2,
      bypass: localFill + sharedWait + 2,
    };
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

  const traces = {
    returnTrace, snoopTrace, fillTrace, missQueueTrace, admissionTrace, writeTurnTrace, quotaTrace, prefetchTrace,
  };
  if (typeof module === "object" && module.exports) module.exports = traces;
  else window.PatentTraces = traces;
})();

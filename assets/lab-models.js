(() => {
  "use strict";

  function hitArbiter({ tick, farReady, nearReady }) {
    if (farReady && nearReady) return { far: tick, near: tick + 1, buffered: "近组" };
    return { far: farReady ? tick : null, near: nearReady ? tick : null, buffered: null };
  }

  function snoopLimit({ backlog, limit, ticksPerRequest }) {
    const ahead = Math.min(backlog, limit);
    return { before: backlog, after: ahead, fifoWait: backlog * ticksPerRequest, limitedWait: ahead * ticksPerRequest };
  }

  function bypass({ sourceHops, controllerHops, requesterHops, ticksPerHop, controllerWork = 0, mergeWork = 0 }) {
    const sourceToMerge = sourceHops * ticksPerHop;
    const mergeToController = controllerHops * ticksPerHop;
    const mergeToRequester = requesterHops * ticksPerHop;
    return {
      viaController: sourceToMerge + 2 * mergeToController + controllerWork + mergeToRequester,
      viaMerge: sourceToMerge + mergeWork + mergeToRequester,
      controllerCopy: sourceToMerge + mergeToController,
    };
  }

  function partialLine({ validMask, writeIndex, writeValue }) {
    const cache = [91, 82, 73, 64];
    const memory = [11, 22, 33, 44];
    const isValid = (index) => Boolean(validMask & (1 << index));
    const cachedBefore = cache.map((value, index) => isValid(index) ? value : null);
    const read = cache.map((value, index) => isValid(index) ? value : memory[index]);
    const writeCache = cachedBefore.slice();
    const writeMemory = memory.slice();
    writeCache[writeIndex] = writeValue;
    writeMemory[writeIndex] = writeValue;
    return { cachedBefore, memory, read, writeCache, writeMemory, nextMask: validMask | (1 << writeIndex) };
  }

  function probeAhead({ lookup, prepare, spareSlot, miss }) {
    if (!miss) return { serial: null, overlapped: null, speculativeSlot: spareSlot };
    const serial = lookup + prepare;
    return { serial, overlapped: spareSlot ? Math.max(lookup, 1 + prepare) : serial, speculativeSlot: spareSlot };
  }

  function admission({ request, firstReady, nextReady }) {
    if (!firstReady) return { launched: false, state: "等待第一组条目", added: "第一组条目可用后才能查询标签" };
    if (request === "hit") return { launched: true, state: "命中完成", added: "第一组条目已足够" };
    const group = request === "snoop" ? "snoop 条目" : "缺失条目";
    return {
      launched: true,
      state: nextReady ? "推进后续阶段" : "等待后续分支资源",
      added: nextReady ? `标签结果确定后取得 ${group}` : `${group}无空位。若已预留重试条目，请求可在本地等待。`,
    };
  }

  function readTurn({ critical, free, minimum, otherCriteria, remainingWrites }) {
    const switched = critical && free >= minimum && otherCriteria && remainingWrites > 0;
    return { switched, writesBeforeRead: switched ? 0 : remainingWrites, writesDeferred: switched ? remainingWrites : 0 };
  }

  function quota({ capacity, quotaA, quotaB, demandA, demandB }) {
    const targetA = Math.min(quotaA, demandA);
    const targetB = Math.min(quotaB, demandB);
    return {
      targetA,
      targetB,
      totalQuota: quotaA + quotaB,
      shortfall: Math.max(0, targetA + targetB - capacity),
    };
  }

  function denyList({ prefetched, touched, live }) {
    const inserted = prefetched && !touched;
    return { inserted, denied: inserted && live };
  }

  const models = { hitArbiter, snoopLimit, bypass, partialLine, probeAhead, admission, readTurn, quota, denyList };
  if (typeof module === "object" && module.exports) module.exports = models;
  else window.PatentModels = models;
})();

"use strict";

// Shared WebHID transaction handling for the two documented AJ179 protocols.
const AJ179HID = (() => {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const bytes = view => new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const color = rgb => "#" + Array.from(rgb, n => n.toString(16).padStart(2, "0")).join("");
  function rgb(value) {
    if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error("燈色格式錯誤。");
    return [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16));
  }
  function number(value, min, max, step = 1) {
    if (!Number.isInteger(value) || value < min || value > max || (value - min) % step) {
      throw new Error("數值超出這款滑鼠的設定範圍。");
    }
    return value;
  }
  function hasReport(collection, direction, id, size) {
    return collection[direction]?.some(report => report.reportId === id &&
      report.items.reduce((bits, item) => bits + item.reportSize * item.reportCount, 0) === size * 8);
  }
  function findInterface(devices, predicate) {
    const visit = (device, c) => predicate(device, c) || c.children?.some(child => visit(device, child));
    const matches = devices.filter(d => d.collections.some(c => visit(d, c)));
    if (matches.length !== 1) throw new Error("無法辨識設定介面。請只選取一隻滑鼠或一個接收器。");
    return {command: matches[0], input: matches[0]};
  }
  // Settle exactly once, including on a disconnect while waiting for a reply.
  function exchange(link, reportId, request, accept) {
    link.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const device = link.command;
      const finish = (fn, result) => {
        clearTimeout(timer);
        device.removeEventListener("inputreport", receive);
        link.signal.removeEventListener("abort", abort);
        fn(result);
      };
      const abort = () => finish(reject, link.signal.reason);
      const receive = event => {
        if (event.reportId !== reportId) return;
        try {
          const answer = accept(bytes(event.data));
          if (answer) finish(resolve, answer);
        } catch (error) { finish(reject, error); }
      };
      const timer = setTimeout(() => finish(reject, new Error("滑鼠未回覆。請喚醒滑鼠後重新讀取。")), 2000);
      device.addEventListener("inputreport", receive);
      link.signal.addEventListener("abort", abort, {once:true});
      device.sendReport(reportId, request).catch(e => finish(reject, e));
    });
  }
  function decodeKey(table, record) {
    return Object.keys(table).find(label => table[label].every((n, i) => record[i] === n)) ?? null;
  }
  function plan(base, target, now, verifyKeys) {
    const conflict = () => { throw new Error("滑鼠設定已變更，請依最新讀值再調整。"); };
    if (target.count !== base.count || now.count !== base.count ||
        now.slots.length !== base.slots.length || target.slots.length !== base.slots.length) conflict();
    function changed(a, b, c) {
      if (a === b) return false;
      if (a == null || (c !== a && c !== b)) conflict();
      return c !== b;
    }
    const settings = {};
    for (const k of ["rate","lod","snap","ripple","debounce","mode","brightness","speed","sensorSync"]) {
      if (changed(base[k], target[k], now[k])) settings[k] = target[k];
    }
    const slots = [];
    for (const [i, slot] of target.slots.entries()) {
      const edits = {};
      for (const k of ["x","y","color"]) {
        if (changed(base.slots[i][k], slot[k], now.slots[i][k])) edits[k] = slot[k];
      }
      if (Object.keys(edits).length) {
        if (i >= now.count) conflict();
        slots.push([i, edits]);
      }
    }
    const keys = [];
    for (const [i, value] of target.keys.entries()) {
      if (verifyKeys && base.keys[i] === value && now.keys[i] !== value) conflict();
      if (changed(base.keys[i], value, now.keys[i])) keys.push([i, value]);
    }
    if (keys.length) {
      const next = [...now.keys];
      for (const [i, value] of keys) next[i] = value;
      if (!next.includes("左鍵點擊")) throw new Error("請至少保留一個左鍵點擊。");
      keys.sort((a, b) => Number(b[1] === "左鍵點擊") - Number(a[1] === "左鍵點擊"));
    }
    return {settings, slots, keys};
  }
  function driver(id, filters, interfaces, read, write, activeStage) {
    const locked = (link, fn) => navigator.locks.request("ajazz.hid." + id, {signal: link.signal}, () => {
      link.signal.throwIfAborted();
      return fn();
    });
    return {filters, interfaces, readActive: link => locked(link, () => activeStage(link)), readFull: link => locked(link, () => read(link)),
      saveFull: (link, base, target, verifyKeys) => locked(link, async () => {
        const now = await read(link);
        await write(link, now, plan(base, target, now, verifyKeys));
        let actual = await read(link);
        if (matchesModelEdits(base, target, actual, verifyKeys)) return actual;
        // Driver (X) can acknowledge before the new polling interval is readable.
        await wait(450);
        actual = await read(link);
        if (!matchesModelEdits(base, target, actual, verifyKeys)) throw new Error("寫入值與滑鼠讀回值不同。");
        return actual;
      })};
  }
  return {wait, bytes, rgb, color, number, hasReport, findInterface, exchange, decodeKey, driver};
})();

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = readFileSync(path.join(__dirname, "..", "aj199.js"), "utf8");
const AJ199 = vm.runInNewContext(source + "\nAJ199", {
  setTimeout, clearTimeout, navigator: { locks: { request: (_key, _options, run) => run() } }
});

test("AJ179 PRO rejects Bluetooth rate edits and USB rates above 1 kHz before sending", async () => {
  const proSource = readFileSync(path.join(__dirname, "..", "aj179-pro.js"), "utf8");
  const pro = vm.runInNewContext(proSource + "\nAJ179Pro", {
    AJ179HID: {driver: (_id, _filters, _interfaces, _read, write) => ({write}), wait: async () => {}}
  });
  const sent = [];
  const device = {
    productId: 0x402c,
    sendReport: async (_id, packet) => sent.push(packet),
    sendFeatureReport: async (_id, packet) => sent.push(packet)
  };
  const option = new Uint8Array(64);
  option[9] = 129; // The shared profile can still contain the 8 kHz receiver setting on Bluetooth.
  const link = {command: device, signal: new AbortController().signal};
  const write = settings => pro.write(link, {raw: {option}}, {settings, slots: [], keys: []});
  await assert.rejects(write({rate: 8000}), /不支援這個回報率/);
  await assert.rejects(write({rate: 125}), /不支援這個回報率/);
  device.productId = 0x4026;
  await assert.rejects(write({rate: 2000}), /不支援這個回報率/);
  assert.equal(sent.length, 0);
  await write({rate: 1000});
  assert.equal(sent[0][9], 1);
  device.productId = 0x402c;
  await write({snap: true});
  assert.equal(sent[1][10], 129); // Bluetooth wraps the settings packet with a one-byte prefix.
});

function receiver({ dropAck = false, ignoreRate = false, power = [80, 1] } = {}) {
  const memory = new Uint8Array(0xb3);
  memory.set([2, 0x53, 1, 0x54, 1, 0x54]); // One enabled stage; hardware slot 1 is active.
  memory.set([15, 15, 0, 55], 0x0c);
  memory.set([0x29, 0x14, 0x10, 0x08], 0x10); // 2100 on both axes; Y uses the 100 DPI scale.
  memory.set([255, 0, 0, 86, 0, 0, 128, 213], 0x2c);
  memory.set([2, 83, 255, 86, 1, 84, 0, 85], 0x4c);
  const input = new EventTarget();
  const writes = [];
  const command = { async sendFeatureReport(id, request) {
    assert.equal(id, 8);
    assert.equal((id + request.reduce((s, b) => s + b)) & 255, 0x55);
    const [op, , high, address, size] = request;
    assert.equal(high, 0);
    const reply = new Uint8Array(16);
    reply[0] = op;
    switch (op) {
      case 1: reply.set([8, 0, 0, 0, 0, 0x40, 1], 4); break;
      case 2: break;
      case 3: reply.set([1, 1], 4); break;
      case 4: reply.set([2, ...power], 4); break;
      case 14: reply.set([1, 0], 4); break;
      case 7:
        writes.push(address);
        if (!(ignoreRate && address === 0)) memory.set(request.slice(5, 5 + size), address);
        if (dropAck) return;
        break; // Receiver ACK with no address or payload.
      case 8:
        reply[3] = address;
        reply[4] = size;
        reply.set(memory.slice(address, address + size), 5);
        break;
      default: assert.fail("Unexpected command " + op);
    }
    reply[15] = 0x55 - 9 - reply.reduce((s, b) => s + b);
    input.dispatchEvent(Object.assign(new Event("inputreport"), { reportId: 9, data: new DataView(reply.buffer) }));
  } };
  return { link: { input, command, signal: new AbortController().signal }, memory, writes };
}

test("edits the chosen DPI record and rate, preserving the other axis encoding", async () => {
  const { link, memory, writes } = receiver();
  const before = memory.slice();
  const edits = [{ slot: 1, field: "x", from: 2100, to: 26000 }, { field: "rate", from: 500, to: 125 }];
  const actual = await AJ199.apply(link, edits);
  assert.deepEqual([actual.stages[1].x, actual.stages[1].y, actual.rate, actual.slot], [26000, 2100, 125, 1]);
  assert.deepEqual(writes, [0x10, 0]);
  assert.deepEqual([...memory.slice(0x10, 0x14)], [7, 0x14, 0x18, 0x22]);
  assert.deepEqual(memory.slice(2, 0x10), before.slice(2, 0x10));
  assert.deepEqual(memory.slice(0x14), before.slice(0x14));
  await AJ199.apply(link, edits);
  assert.equal(writes.length, 2);
});

test("a rate-only edit preserves every DPI byte", async () => {
  const { link, memory, writes } = receiver();
  const before = memory.slice(2);
  assert.equal((await AJ199.apply(link, [{ field: "rate", from: 500, to: 250 }])).rate, 250);
  assert.deepEqual(writes, [0]);
  assert.deepEqual(memory.slice(2), before);
});

test("invalid or conflicting edits cannot start a write", async () => {
  const { link, memory, writes } = receiver();
  for (const [field, to] of [["x", 0], ["y", 251], ["rate", 300], ["color", "oops"], ["lightMode", 7]]) {
    await assert.rejects(AJ199.apply(link, [{ field, to, slot: 0 }]), /確認/);
  }
  memory.set([0, 0x55], 4);
  memory.set([15, 15, 0, 55], 0x0c);
  await assert.rejects(AJ199.apply(link, [{ field: "rate", from: 500, to: 1000 },
    { field: "x", slot: 1, from: 2100, to: 500 }]), /更動/);
  assert.deepEqual(writes, []);
});

test("partial apply and missing acknowledgement never report success or retry a write", async () => {
  for (const options of [{ ignoreRate: true }, { dropAck: true }]) {
    const { link, writes } = receiver(options);
    await assert.rejects(AJ199.apply(link, [{ slot: 1, field: "y", from: 2100, to: 50 },
      { field: "rate", from: 500, to: 1000 }]), /未回覆|讀回/);
    const actual = await AJ199.read(link);
    assert.deepEqual([actual.stages[1].x, actual.stages[1].y, actual.rate], [2100, 50, 500]);
    assert.deepEqual(writes, options.dropAck ? [0x10] : [0x10, 0]);
  }
});

test("inactive stage editing, two-stage apply and lamp off only write the intended records", async () => {
  const { link, memory, writes } = receiver();
  memory.set([2, 83, 0, 85], 2); // Hardware selected slot 0 while editing slot 1.
  const before = memory.slice();
  const actual = await AJ199.apply(link, [
    { field: "x", slot: 1, from: 2100, to: 1600 }, { field: "color", slot: 0, from: "#ff0000", to: "#123456" },
    { field: "lightMode", from: 2, to: 0 }
  ]);
  assert.deepEqual(writes, [0x2c, 0x10, 0x4c]);
  assert.equal(actual.slot, 0);
  assert.deepEqual([actual.stages[0].x, actual.stages[1].x, actual.stages[1].color, actual.lightMode], [800, 1600, "#000080", 0]);
  assert.deepEqual(memory.slice(0x4e), before.slice(0x4e)); // brightness, speed and padding
  assert.deepEqual(memory.slice(0, 0x10), before.slice(0, 0x10));
  assert.equal(actual.stages[0].color, "#123456");
  assert.deepEqual([actual.battery.percent, actual.battery.charging], [80, true]);
});

test("unknown battery fields stay unavailable while settings remain readable", async () => {
  const { link } = receiver({ power: [255, 4] });
  const actual = await AJ199.read(link);
  assert.deepEqual([actual.battery.percent, actual.battery.charging, actual.stages.length], [null, null, 2]);
});

test("uninitialized lighting records leave DPI available and block unsafe lighting edits", async () => {
  const { link, memory, writes } = receiver();
  memory.fill(255, 0x2c, 0x30);
  memory.fill(255, 0x4c, 0x4e);
  const profile = await AJ199.read(link);
  assert.deepEqual([profile.stages[0].color, profile.lightMode, profile.stages[0].x], [null, null, 800]);
  await assert.rejects(AJ199.apply(link, [{ slot: 0, field: "color", from: null, to: "#112233" }]), /無法讀取/);
  assert.deepEqual(writes, []);
});

test("wireless physical DPI notification is recognized separately from command responses", () => {
  const packet = Uint8Array.from([9, 10, 0, 0, 0, 10, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 53]);
  const event = { reportId: packet[0], data: new DataView(packet.buffer, 1) };
  assert.equal(AJ199.notifiedSlot(event), 1);
  packet[6] = 0;
  assert.equal(AJ199.notifiedSlot(event), null);
});

test("a named key profile detects other binding changes before writing and at final readback", async () => {
  const { link, memory, writes } = receiver();
  // Left/right/middle, forward/back and DPI cycle.
  [0x101,0x201,0x401,0x801,0x1001,0x102].forEach((code, i) => {
    const lo = code & 255, hi = code >> 8;
    memory.set([lo, hi, 0, 0x55 - lo - hi], 0x60 + i * 4);
  });
  const base = await AJ199.readFull(link);
  const target = { ...base, keys: [...base.keys] };
  target.keys[3] = "提高 DPI";
  target.keys[4] = "降低 DPI";
  const dpiButton = memory.slice(0x74, 0x78);
  const changeDpiButton = () => memory.set([2, 2, 0, 81], 0x74);
  changeDpiButton();
  await assert.rejects(AJ199.saveFull(link, base, target, true), /已改變/);
  assert.deepEqual(writes, []);

  memory.set(dpiButton, 0x74);
  link.input.addEventListener("inputreport", e => {
    if (e.data.getUint8(0) === 7) changeDpiButton();
  });
  await assert.rejects(AJ199.saveFull(link, base, target, true), /已改變/);
  assert.deepEqual(writes, [0x6c, 0x70]);
  const actual = await AJ199.readFull(link);
  assert.equal(AJ199.matchesEdits(base, target, actual, true), false);
  assert.equal(actual.keys[5], "提高 DPI");
});

"use strict";

// Wire format: OpenMouse-Project/mouse-protocol, docs/ajazz-aj179-pro.md.
const AJ179Pro = (() => {
  const h = AJ179HID;
  const transport = device => ({0x402d:"radio", 0x4026:"usb", 0x402c:"ble"})[device.productId];
  const maxRates = {usb:1000, radio:8000, ble:125};
  const filters = [0x402d,0x4026,0x402c].map(productId => ({vendorId:0x3151, productId,
    usagePage:productId === 0x402c ? 0xff55 : 0xffff, usage:productId === 0x402c ? 0x202 : 2}));
  function interfaces(devices) {
    return h.findInterface(devices, (d,c) => {
      if (!filters.some(f => f.productId === d.productId && f.vendorId === d.vendorId &&
          f.usagePage === c.usagePage && f.usage === c.usage)) return false;
      return transport(d) === "ble" ? h.hasReport(c,"inputReports",6,65) && h.hasReport(c,"outputReports",6,65) :
        h.hasReport(c,"featureReports",0,64);
    });
  }
  const actions = {"左鍵點擊":[1,0,240,0],"右鍵點擊":[1,0,241,0],"中鍵點擊":[1,0,242,0],
    "上一頁":[1,0,243,0],"下一頁":[1,0,244,0],"循環 DPI":[20,0,0,0],
    "提高 DPI":[20,0,1,0],"降低 DPI":[0,2,0,20],"停用":[0,0,0,0]};
  const buttons = [0,1,2,4,3,5];
  const rates = {125:8,250:4,500:2,1000:1,2000:132,4000:130,8000:129};
  const word = (b,i) => b[i] + 256*b[i+1];
  function block(data) { const b = new Uint8Array(64); b.set(data); return b; }
  async function feature(link, data) {
    link.signal.throwIfAborted();
    await link.command.sendFeatureReport(0,block(data));
  }
  async function receive(link) {
    link.signal.throwIfAborted();
    const view = h.bytes(await link.command.receiveFeatureReport(0));
    // Some WebHID backends include byte 0 (unnumbered report ID).
    const response = view.length === 65 && view[0] === 0 ? view.subarray(1) : view;
    if (response.length !== 64) throw new Error("AJ179 PRO 回覆長度錯誤。");
    return response.slice();
  }
  async function ready(link, offset) {
    for (let i = 0; i < 8; i++) {
      await h.wait(100);
      await feature(link,[0xf7]);
      await h.wait(10);
      const status = await receive(link);
      if (status[4] !== 0) throw Object.assign(new Error("接收器回報滑鼠離線。"), {retryOnWake:true});
      link.battery = status[2] <= 100 ? {percent:status[2]} : null;
      if (status[offset] === 1) return;
    }
    throw new Error("AJ179 PRO 接收器尚未就緒。");
  }
  async function command(link, data, write = false) {
    const packet = block(data), id = packet[0], medium = transport(link.command);
    packet[7] = 255 - (packet.slice(0,7).reduce((sum,n) => sum+n,0) & 255);
    link.signal.throwIfAborted();
    let reply;
    if (medium === "ble") {
      const wrapped = new Uint8Array(65); wrapped[0] = 0x55; wrapped.set(packet,1);
      if (write) { await link.command.sendReport(6,wrapped); await h.wait(60); return; }
      reply = await h.exchange(link,6,wrapped,b => {
        if (b.length !== 65 || b[0] !== 0x55 || (id !== 0xd0 && b[1] !== id)) return;
        if (b.every((v,i) => v === wrapped[i])) return;
        return b.slice(1);
      });
    } else {
      if (medium === "radio") await ready(link,5);
      await feature(link,packet);
      if (write) { await h.wait(medium === "radio" ? 50 : 10); return; }
      if (medium === "radio") { await ready(link,0); await feature(link,[0xfc]); }
      await h.wait(10);
      reply = await receive(link);
    }
    if ((id === 0xd0 ? reply[0] >= 128 : reply[0] !== id) ||
        !reply.some(Boolean) || reply.every((v,i) => v === packet[i])) throw new Error("AJ179 PRO 的回覆無法辨識。");
    return reply;
  }
  async function read(link) {
    const medium = transport(link.command);
    if (medium === "radio") { await feature(link,[0xf6,5]); await h.wait(50); }
    const identity = await command(link,[0x8f]);
    if (word(identity,1) !== 1851 || word(identity,3) !== 0) throw new Error("裝置回報的型號不是 AJ179 PRO。");
    const option = await command(link,[0xd3]), dpi = await command(link,[0xd4]);
    const keys = await command(link,[0xd0]);
    const capacity = h.number(dpi[3],1,8);
    const slots = Array.from({length:capacity}, (_,i) => ({x:word(dpi,8+i*2), y:word(dpi,24+i*2),
      color:h.color(dpi.subarray(40+i*3,43+i*3))}));
    let count = capacity;
    while (count > 0 && slots[count-1].x === 0 && slots[count-1].y === 0) count--;
    const active = h.number(dpi[2],0,count-1);
    for (const s of slots.slice(0,count)) { h.number(s.x,50,26000,50); h.number(s.y,50,26000,50); }
    const rate = Number(Object.keys(rates).find(hz => rates[hz] === option[9]));
    if (!rate) throw new Error("回報率讀值無法辨識。");
    if (medium === "ble") {
      const request = new Uint8Array(65); request[0] = 0x77;
      try {
        const response = await h.exchange(link,6,request,b => b.length === 65 && b[0] === 0x77 &&
          b[1] <= 100 && b.some((v,i) => request[i] !== v) && b);
        link.battery = {percent:response[1]};
      } catch { link.signal.throwIfAborted(); link.battery = null; }
    }
    return {active, count, slots, rate, battery:link.battery, keys:buttons.map(i => h.decodeKey(actions,keys.slice(4*i,4*i+4))),
      lod:option[52] < 2 ? option[52]+1 : null, debounce:option[10] <= 10 ? option[10] : null,
      ripple:Boolean(option[12] & 4), snap:option[53] < 2 ? Boolean(option[53]) : null,
      mode:null,brightness:null,speed:null,raw:{option,dpi}};
  }
  async function write(link, now, {settings, slots, keys}) {
    if (Object.keys(settings).length) {
      const medium = transport(link.command);
      const packet = now.raw.option.slice();
      packet.fill(0,0,8); packet[0] = 0x53; packet[17] = 255; packet[18] = 8;
      for (const [k,v] of Object.entries(settings)) {
        switch (k) {
          case "rate":
            if (medium === "ble" || !Object.hasOwn(rates,v) || v > maxRates[medium]) throw new Error("此連線不支援這個回報率。");
            packet[9] = rates[v]; break;
          case "lod": packet[52] = h.number(v,1,2)-1; break;
          case "debounce": packet[10] = h.number(v,0,10); break;
          case "snap": packet[53] = Number(v); break;
          case "ripple": packet[12] = (packet[12] & ~4) | (v ? 4 : 0); break;
          default: throw new Error("AJ179 PRO 未提供此設定。");
        }
      }
      await command(link,packet,true);
    }
    if (slots.length) {
      const packet = await command(link,[0xd4]);
      if (packet[3] !== now.slots.length || packet.subarray(8).some((v,i) => v !== now.raw.dpi[i+8])) {
        throw new Error("DPI 檔位表已變更，請依最新讀值再調整。");
      }
      const active = h.number(packet[2],0,now.count-1);
      packet.fill(0,0,8); packet.set([0x54,0,active,now.slots.length]);
      for (const [i,s] of slots) {
        for (const [axis,start] of [["x",8],["y",24]]) if (axis in s) {
          const n = h.number(s[axis],50,26000,50);
          packet.set([n&255,n>>8],start+2*i);
        }
        if ("color" in s) packet.set(h.rgb(s.color),40+3*i);
      }
      await command(link,packet,true);
    }
    for (const [i,label] of keys) {
      if (!Object.hasOwn(actions,label)) throw new Error("AJ179 PRO 未提供此按鍵功能。");
      await command(link,[0x50,0,buttons[i],0,0,0,0,0,...actions[label]],true);
      // A profile may move primary-click to another button. Confirm each move
      // before the next write can remove the previous primary-click binding.
      const matrix = await command(link,[0xd0]);
      if (h.decodeKey(actions,matrix.subarray(4*buttons[i],4*buttons[i]+4)) !== label) {
        throw new Error("按鍵指派尚未讀回，已停止切換配置。");
      }
    }
  }
  async function activeStage(link) {
    if (transport(link.command) === "radio") { await feature(link,[0xf6,5]); await h.wait(50); }
    return h.number((await command(link,[0xd4]))[2],0,7);
  }
  return {...h.driver("aj179-pro",filters,interfaces,read,write,activeStage), transport, maxRates};
})();

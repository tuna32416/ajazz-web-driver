"use strict";

// AJAZZ Driver (X) wire format documented by Geovane2dd/Ajazzy.
const AJ179Max = (() => {
  const h = AJ179HID;
  const filters = [0x5c2e,0x5d2e,0x5e2e,0x5c2f].map(productId => ({vendorId:0x248a,productId}));
  filters.push({vendorId:0x249a,productId:0x5c2f});
  function interfaces(devices) {
    return h.findInterface(devices, (d,c) => filters.some(f => f.vendorId === d.vendorId && f.productId === d.productId) &&
      c.usagePage === 1 && c.usage === 0 && h.hasReport(c,"inputReports",0,32) && h.hasReport(c,"outputReports",0,32));
  }
  const actions = {"左鍵點擊":[16,1,0],"右鍵點擊":[16,2,0],"中鍵點擊":[16,4,0],
    "上一頁":[16,8,0],"下一頁":[16,16,0],"循環 DPI":[64,1,0],"提高 DPI":[64,2,0],
    "降低 DPI":[64,3,0],"靜音":[128,226,0],"播放／暫停":[128,205,0],"停用":[96,0,0]};
  const sum = data => data.subarray(4,31).reduce((total,n) => total+n,0) & 255;
  async function request(link, family, opcode = 0, payload = []) {
    const packet = new Uint8Array(32);
    packet.set([family,0,Number(opcode !== 0),opcode]); packet.set(payload,4); packet[31] = sum(packet);
    return h.exchange(link,0,packet,b => {
      if (b.length !== 32 || b[0] !== family || b[1] !== 0) return;
      if (b[31] !== sum(b)) throw new Error("AJ179 V2 MAX 回覆校驗失敗。");
      if (!opcode && (b[2] !== 1 || !b[3])) return;
      return {opcode:b[3], data:b.slice(4,31)};
    });
  }
  async function read(link) {
    const info = await request(link,0x10);
    const id = String.fromCharCode(...info.data.slice(0,4));
    if (id !== "N625") throw new Error("裝置回報的型號不是 AJ179 V2 MAX。");
    const keys = (await request(link,0x11)).data;
    const interval = (await request(link,0x12)).data[0];
    const dpi = (await request(link,0x13)).data;
    const colors = (await request(link,0x14)).data;
    const reliableColors = link.command.productId !== 0x5c2f || colors.subarray(0,18).some(Boolean);
    const light = await request(link,0x15);
    const sensor = (await request(link,0x16)).data, power = (await request(link,0x17)).data;
    if (![1,2,4,8].includes(interval)) throw new Error("回報率讀值無法辨識。");
    const active = h.number(dpi[0] >> 4,0,5);
    const slots = Array.from({length:6}, (_,i) => {
      const p = 1+4*i;
      const x = h.number(100*(dpi[p]+256*dpi[p+1]),100,12000,100);
      const y = h.number(100*(dpi[p+2]+256*dpi[p+3]),100,12000,100);
      return {x,y,color:reliableColors ? h.color(colors.slice(3*i,3*i+3)) : null};
    });
    const mode = light.opcode === 1 ? "off" : ({0:"off",2:"breathing",3:"steady"})[light.data[0]] ?? null;
    const brightness = light.data[1] >> 4, speed = light.data[1] & 15;
    if (mode === "steady") link.steadyColor = light.data.slice(2,5);
    if (mode === "breathing" && light.data[2] >= 1 && light.data[2] <= 7)
      link.breathingColors = light.data.slice(2,3 + light.data[2]*3);
    return {active, count:6, slots, keys:slots.map((_,i) => h.decodeKey(actions,keys.subarray(3*i,3*i+3))),
      rate:1000/interval, lod:[1,2].includes(sensor[0]) ? sensor[0] : null,
      snap:sensor[1] < 2 ? Boolean(sensor[1]) : null, ripple:sensor[2] < 2 ? Boolean(sensor[2]) : null,
      sensorSync:sensor[3] < 2 ? Boolean(sensor[3]) : null, debounce:power[3], mode,
      brightness:mode && mode !== "off" && brightness <= 4 ? brightness*25 : null,
      speed:mode && mode !== "off" && speed <= 4 ? speed : null,
      battery:info.opcode >= 10 && info.data[9] <= 100 ? {percent:info.data[9]} : null,
      raw:{keys,dpi,colors,sensor,power,light}};
  }
  async function write(link, now, {settings, slots, keys}) {
    if ("rate" in settings) {
      if (![125,250,500,1000].includes(settings.rate)) throw new Error("不支援這個回報率。");
      await request(link,2,1,[1000/settings.rate]);
    }
    if (slots.some(([,s]) => "x" in s || "y" in s)) {
      const table = (await request(link,0x13)).data;
      if ((table[0]&15) !== (now.raw.dpi[0]&15) || table.subarray(1).some((v,i) => v !== now.raw.dpi[i+1])) {
        throw new Error("DPI 檔位表已變更，請依最新讀值再調整。");
      }
      for (const [i,s] of slots) if ("x" in s || "y" in s) {
        const x = s.x ?? now.slots[i].x, y = s.y ?? now.slots[i].y;
        if (x !== y) throw new Error("這款滑鼠使用 X/Y 同步調整。");
        const n = h.number(x,100,12000,100)/100;
        table.set([n,0,n,0],1+4*i);
      }
      await request(link,3,0x25,table);
    }
    if (slots.some(([,s]) => "color" in s)) {
      if (link.command.productId === 0x5c2f) throw new Error("請使用 USB 資料線修改檔位燈色。");
      const colors = now.raw.colors.slice();
      for (const [i,s] of slots) if ("color" in s) colors.set(h.rgb(s.color),3*i);
      await request(link,4,18,colors);
    }
    if (["mode","brightness","speed"].some(k => k in settings)) {
      const mode = settings.mode ?? now.mode;
      const brightness = h.number(settings.brightness ?? now.brightness ?? 75,0,100,25)/25;
      const speed = h.number(settings.speed ?? now.speed ?? 2,0,4);
      const levels = brightness*16 + speed;
      if (mode === "off") await request(link,5,2,[0,0]);
      else if (mode === "steady") await request(link,5,5,[3,levels,...(link.steadyColor ?? h.rgb(now.slots[now.active].color ?? "#ffffff"))]);
      else if (mode === "breathing") {
        const palette = link.breathingColors ?? [7,255,0,0,0,255,0,0,0,255,0,255,255,255,255,0,255,0,255,255,255,255];
        await request(link,5,24,[2,levels,...palette]);
      } else throw new Error("無法辨識燈效模式。");
    }
    if (["lod","snap","ripple","sensorSync"].some(k => k in settings)) {
      const data = now.raw.sensor.slice();
      if ("lod" in settings) data[0] = h.number(settings.lod,1,2);
      for (const [i,k] of ["snap","ripple","sensorSync"].entries()) if (k in settings) data[i+1] = Number(settings[k]);
      await request(link,6,5,data);
    }
    if ("debounce" in settings) {
      const data = now.raw.power.slice(); data[3] = h.number(settings.debounce,0,255);
      await request(link,7,4,data);
    }
    if (keys.length) {
      const data = now.raw.keys.slice();
      for (const [i,label] of keys) {
        if (!Object.hasOwn(actions,label)) throw new Error("未知的按鍵功能。");
        data.set(actions[label],3*i);
      }
      await request(link,9,15,data);
    }
  }
  async function activeStage(link) {
    return h.number((await request(link,0x13)).data[0] >> 4,0,5);
  }
  return h.driver("aj179-v2-max",filters,interfaces,read,write,activeStage);
})();

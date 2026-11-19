"use strict";

// AJ199 PAW3395. WebHID passes the report ID separately from the 16-byte body.
// Protocol references: github.com/taylors42/OpenAjazz (docs/POC.md) and
// github.com/a32fred/ajazz-linux (docs/reference/HARDWARE_FINDINGS.md).
const AJ199 = (() => {
  const filters = [0xfa7b, 0xfa7c].map(productId => ({ vendorId: 0x25a7, productId }));
  const rates = [1000, 500, 250, 125];
  const timeOut = "滑鼠未回覆。請移動滑鼠後重新讀取，或改用 USB 資料線。";

  function hasReport(device, page, usage, direction, id) {
    return device.collections.some(collection =>
      collection.usagePage === page && collection.usage === usage &&
      collection[direction].some(report => report.reportId === id &&
        report.items.reduce((bits, item) => bits + item.reportSize * item.reportCount, 0) === 128));
  }

  function interfaces(devices) {
    const supported = devices.filter(d => filters.some(f => f.vendorId === d.vendorId && f.productId === d.productId));
    const commands = supported.filter(d => hasReport(d, 0xff02, 2, "featureReports", 8));
    const replies = supported.filter(d => hasReport(d, 0xff01, 0, "inputReports", 9));
    if (commands.length !== 1 || replies.length !== 1 || commands[0].productId !== replies[0].productId) {
      throw new Error("找不到 AJ199 的設定介面。請只選一個一般版 AJ199 裝置。");
    }
    return { command: commands[0], input: replies[0] };
  }

  function sum(bytes) {
    return bytes.reduce((total, value) => total + value, 0);
  }

  function wakeError(message) {
    return Object.assign(new Error(message), { retryOnWake: true });
  }

  // Each query owns its listener. Install it before sending because Windows can
  // deliver the input report before sendFeatureReport's promise resolves.
  function query(link, command, address, size, payload = []) {
    const request = new Uint8Array(16);
    request.set([command, 0, address >> 8, address & 255, size, ...payload]);
    request[15] = 0x55 - 8 - sum(request);
    return new Promise((resolve, reject) => {
      function finish(error, data) {
        clearTimeout(timer);
        link.input.removeEventListener("inputreport", onReport);
        link.signal.removeEventListener("abort", cancel);
        if (error) reject(error);
        else resolve(data);
      }
      function cancel() { finish(new Error("裝置已中斷連線。")); }
      function onReport(event) {
        if (event.reportId !== 9 || event.data.byteLength !== 16) return;
        const bytes = new Uint8Array(event.data.buffer, event.data.byteOffset, 16);
        if (bytes[0] !== command) return;
        // Some firmware returns a zero address on write ACKs. The subsequent
        // read must still echo the exact address and length and match the bytes.
        const addressMatches = bytes[2] === request[2] && bytes[3] === request[3];
        if (!addressMatches && !(command === 7 && bytes[2] === 0 && bytes[3] === 0)) return;
        if (((9 + sum(bytes)) & 255) !== 0x55) return;
        if (bytes[1] !== 0) return finish(Object.assign(new Error("滑鼠拒絕了這次設定要求。"), {deviceRejected:true}));
        if (bytes[4] > 10 || (command === 8 && bytes[4] !== size)) return;
        finish(null, bytes.slice(5, 5 + bytes[4]));
      }
      const timer = setTimeout(() => finish(wakeError(timeOut)), 1500);
      if (link.signal.aborted) return cancel();
      link.input.addEventListener("inputreport", onReport);
      link.signal.addEventListener("abort", cancel, { once: true });
      link.command.sendFeatureReport(8, request).catch(() => finish(new Error("無法傳送要求，請重新連接裝置。")));
    });
  }

  function verifyRecord(bytes) {
    if ((sum(bytes) & 255) !== 0x55) throw new Error("設定資料校驗失敗，請重新讀取。");
  }

  function decodeHeader(bytes) {
    for (let i = 0; i < 6; i += 2) verifyRecord(bytes.slice(i, i + 2));
    const rate = 1000 / bytes[0];
    // A receiver can have one enabled stage while the active hardware slot is 1 (the second slot).
    if (!rates.includes(rate) || bytes[2] < 1 || bytes[2] > 8 || bytes[4] > 7) {
      throw new Error("此裝置的回報率或 DPI 檔位格式尚未支援。");
    }
    return { rate, count: bytes[2], slot: bytes[4] };
  }

  function decodeDpi(bytes) {
    verifyRecord(bytes);
    const flags = bytes[2];
    const x = (1 + (bytes[0] | ((flags & 0x0c) << 6))) * (flags & 1 ? 100 : 50);
    const y = (1 + (bytes[1] | ((flags & 0xc0) << 2))) * (flags & 0x10 ? 100 : 50);
    if ((flags & 0x22) || x > 26000 || y > 26000) throw new Error("此裝置的 DPI 編碼尚未支援。");
    return { x, y };
  }

  async function readStage(link, slot) {
    const dpiRecord = await query(link, 8, 0x0c + slot * 4, 4);
    const rgb = await query(link, 8, 0x2c + slot * 4, 4);
    const color = (sum(rgb) & 255) === 0x55
      ? "#" + Array.from(rgb.slice(0, 3), b => b.toString(16).padStart(2, "0")).join("") : null;
    return { slot, ...decodeDpi(dpiRecord), dpiRecord, color };
  }

  async function readBattery(link) {
    try {
      const power = await query(link, 4, 0, 0);
      if (power.length === 2) return {
        percent: power[0] <= 100 ? power[0] : null,
        charging: power[1] <= 1 ? Boolean(power[1]) : null
      };
    } catch (error) {
      if (link.signal.aborted) throw error;
    }
    return { percent: null, charging: null };
  }

  async function readCurrent(link) {
    const header = decodeHeader(await query(link, 8, 0, 6));
    const stages = [];
    for (let slot = 0; slot < header.count; slot++) stages.push(await readStage(link, slot));
    const mode = await query(link, 8, 0x4c, 2);
    const lightMode = (sum(mode) & 255) === 0x55 ? mode[0] : null;
    const battery = await readBattery(link);
    const latest = decodeHeader(await query(link, 8, 0, 6));
    if (header.count !== latest.count) throw new Error("讀取期間檔位數量已改變，請重新讀取。");
    if (latest.slot >= latest.count) stages.push(await readStage(link, latest.slot));
    return { ...latest, stages, lightMode, battery };
  }

  function notifiedSlot(event) {
    if (event.reportId !== 9 || event.data.byteLength !== 16) return null;
    const b = new Uint8Array(event.data.buffer, event.data.byteOffset, 16);
    // The notification is a hint. Only display the result of a checked read.
    return b[0] === 0x0a && (b[5] & 1) && b[6] <= 7 ? b[6] : null;
  }

  async function withProfile(link, operation) {
    const identity = await query(link, 1, 0, 8, [17, 29, 43, 61]);
    if (identity.length !== 8 || identity[4] !== 0x40 || identity[5] !== 1) {
      throw new Error("裝置回報的型號不符一般版 AJ199（40:01）。");
    }
    const status = await query(link, 3, 0, 0);
    if (status.length !== 1 || status[0] !== 1) {
      throw wakeError("接收器尚未連到滑鼠，請移動滑鼠喚醒。");
    }
    // 0x02 opens/closes a temporary driver session on the receiver.
    let operationFailed = false;
    try {
      await query(link, 2, 0, 1, [1]);
      const profile = await query(link, 0x0e, 0, 0);
      if (profile.length !== 1 || profile[0] !== 0) throw new Error("此硬體設定檔尚未支援。");
      return await operation(link);
    } catch (error) {
      operationFailed = true;
      throw error;
    } finally {
      if (!link.signal.aborted) {
        try { await query(link, 2, 0, 1, [0]); }
        catch (error) { if (!operationFailed) throw error; }
      }
    }
  }

  // Input reports are shared. Serialize entire sessions across open tabs.
  function session(link, operation) {
    return navigator.locks.request("aj199-profile", { signal: link.signal }, () => withProfile(link, operation));
  }

  function read(link) {
    return session(link, readCurrent);
  }

  function dpiBytes(current, target) {
    const bytes = current.dpiRecord.slice();
    // Keep the other axis' original scale and high bits for a one-axis edit.
    if (current.x !== target.x) {
      const code = target.x / 50 - 1;
      bytes[0] = code & 255;
      bytes[2] = (bytes[2] & 0xf0) | ((code >> 8) << 2);
    }
    if (current.y !== target.y) {
      const code = target.y / 50 - 1;
      bytes[1] = code & 255;
      bytes[2] = (bytes[2] & 0x0f) | ((code >> 8) << 6);
    }
    bytes[3] = 0x55 - bytes[0] - bytes[1] - bytes[2];
    return bytes;
  }

  async function writeAndVerify(link, address, bytes) {
    await query(link, 7, address, bytes.length, bytes);
    const actual = await query(link, 8, address, bytes.length);
    if (!actual.every((value, i) => value === bytes[i])) throw new Error("滑鼠讀回的資料與寫入值不同。");
  }

  function valueAt(snapshot, field, slot) {
    if (field === "rate" || field === "lightMode") return snapshot[field];
    return snapshot.stages.find(stage => stage.slot === slot)?.[field];
  }

  function validEdit({ field, slot, to }) {
    if (field === "rate") return slot == null && rates.includes(to);
    if (field === "lightMode") return slot == null && [0, 1, 2].includes(to);
    if (!Number.isInteger(slot) || slot < 0 || slot > 7) return false;
    if (field === "color") return typeof to === "string" && /^#[0-9a-f]{6}$/.test(to);
    return (field === "x" || field === "y") && Number.isInteger(to) && to >= 50 && to <= 26000 && to % 50 === 0;
  }

  function checked(bytes) {
    return Uint8Array.from([...bytes, 0x55 - sum(bytes)]);
  }

  function colorBytes(color) {
    return checked(color.slice(1).match(/../g).map(pair => parseInt(pair, 16)));
  }

  async function apply(link, edits) {
    if (!edits.length || !edits.every(validEdit)) throw new Error("請確認各檔的 DPI、顏色與全域設定。");
    const keys = edits.map(edit => edit.field + "/" + edit.slot);
    if (new Set(keys).size !== edits.length) throw new Error("設定項目重複。");
    return session(link, async () => {
      const current = await readCurrent(link);
      // Target physical register addresses by the chosen slot, even when the
      // user presses the DPI button between editing and applying.
      const changes = edits.filter(e => valueAt(current, e.field, e.slot) !== e.to);
      for (const e of changes) {
        const value = valueAt(current, e.field, e.slot);
        if (value == null || value !== e.from) throw new Error("滑鼠設定已被更動或無法讀取，請比對最新讀值後重新編輯。");
      }
      const records = [];
      for (const stage of current.stages) {
        const local = changes.filter(e => e.slot === stage.slot);
        const target = { ...stage };
        for (const e of local) target[e.field] = e.to;
        if (target.x !== stage.x || target.y !== stage.y) {
          records.push([0x0c + stage.slot * 4, stage.dpiRecord, dpiBytes(stage, target), stage.slot]);
        }
        if (target.color !== stage.color) {
          records.push([0x2c + stage.slot * 4, colorBytes(stage.color), colorBytes(target.color), stage.slot]);
        }
      }
      for (const e of changes.filter(e => e.slot == null)) {
        if (e.field === "rate") records.push([0, checked([1000 / current.rate]), checked([1000 / e.to])]);
        if (e.field === "lightMode") records.push([0x4c, checked([current.lightMode]), checked([e.to])]);
      }
      for (const [address, before, after, slot] of records) {
        if (slot !== undefined) {
          const header = decodeHeader(await query(link, 8, 0, 6));
          if (slot >= header.count && slot !== header.slot) throw new Error("目標檔位已停用，請重新讀取。");
        }
        const existing = await query(link, 8, address, before.length);
        if (!existing.every((b, i) => b === before[i])) throw new Error("寫入前設定已改變，已停止後續寫入。");
        await writeAndVerify(link, address, after);
      }
      const actual = await readCurrent(link);
      if (!edits.every(e => valueAt(actual, e.field, e.slot) === e.to)) throw new Error("滑鼠讀回的設定與本次變更不同。");
      return actual;
    });
  }


  // General AJ199 (40:01), EEPROM value/checksum pairs. The two undocumented
  // sensor options are intentionally not mapped to writable device fields.
  const brightnessBytes = [0x10,0x1e,0x3c,0x5a,0x80,0x96,0xb4,0xd2,0xe6,0xff];
  const lightIdleTimes = [10,30,60,300,600,900,1200,1500,1800,2100,2400];
  const fields = {
    lod: [0x0a,[1,2]], mode: [0x4c,["off","steady","breathing"],[0,1,2]],
    brightness: [0x4e,brightnessBytes.map((_,i)=>(i+1)*10),brightnessBytes],
    speed: [0x50,[1,2,3,4,5,6,7,8]], debounce: [0xa9,Array.from({length:31},(_,i)=>i)],
    snap: [0xaf,[false,true],[0,1]], ripple: [0xb1,[false,true],[0,1]],
    rate: [0,rates,[1,2,4,8]]
  };
  const bindings = {"左鍵點擊":0x101,"右鍵點擊":0x201,"中鍵點擊":0x401,"上一頁":0x1001,"下一頁":0x801,
    "循環 DPI":0x102,"提高 DPI":0x202,"降低 DPI":0x302,"停用":0};
  const media = {"靜音":0xe2,"播放／暫停":0xcd};
  function mediaRecord(usage) { return checked([2,0x82,usage,0,0x42,usage,0]); }
  function sameBytes(a,b) { return a.length===b.length && a.every((n,i)=>n===b[i]); }

  async function readFull(link) {
    const raw = {};
    async function block(address,size) {
      const bytes = await query(link,8,address,size);
      for(let i=0;i<size;i++) raw[address+i]=bytes[i];
      return bytes;
    }
    async function optionalBlock(address,size) {
      try { return await block(address,size); }
      catch(error) {
        if(link.signal.aborted || (!error.deviceRejected && !error.retryOnWake)) throw error;
        return null;
      }
    }
    const header=decodeHeader(await block(0,6));
    const slots=[], keys=[];
    await optionalBlock(0x0a,2);
    // Read dormant slots too, so adding a stage can recover its saved settings.
    for(let i=0;i<8;i+=2) {
      const xy=await block(0x0c+i*4,8), rgb=await block(0x2c+i*4,8);
      for(let j=0;j<2;j++){
        const dpiRecord=xy.slice(j*4,j*4+4), color=rgb.slice(j*4,j*4+4);
        let axes={x:null,y:null};
        try {axes=decodeDpi(dpiRecord);} catch(error) {if(i+j<header.count||i+j===header.slot) throw error;}
        slots.push({...axes,color:(sum(color)&255)===0x55?"#"+Array.from(color.slice(0,3),v=>v.toString(16).padStart(2,"0")).join(""):null});
      }
    }
    // Keep the original two-byte wheel-mode read working independently of
    // firmware support for brightness, speed and the additional settings.
    await block(0x4c,2);
    await optionalBlock(0x4e,4);
    await optionalBlock(0xa9,10);
    for(let i=0;i<6;i+=2) await optionalBlock(0x60+i*4,8);
    for(let i=0;i<6;i++) {
      const record=bytesAt(raw,0x60+i*4,4), code=record[0]+256*record[1]+65536*record[2];
      let label=null;
      if((sum(record)&255)===0x55){
        label=Object.keys(bindings).find(name=>bindings[name]===code)??null;
        if(code===5) {
          const aux=await optionalBlock(0x100+32*i,8);
          label=aux ? Object.keys(media).find(name=>sameBytes(aux,mediaRecord(media[name])))??null : null;
        }
      }
      keys.push(label);
    }
    const values={};
    for(const [field,[address,choices,wire=choices]] of Object.entries(fields)){
      const value=raw[address], check=raw[address+1];
      values[field]=((value+check)&255)===0x55 ? choices[wire.indexOf(value)]??null : null;
    }
    // Some units report 05 for the same visible steady wheel effect.
    if(raw[0x4c]===5 && raw[0x4d]===0x50) values.mode="steady";
    // The lighting idle timer is in ten-second units and is read-only here.
    const idleSeconds=raw[0xad]*10;
    const lightIdleSeconds=((raw[0xad]+raw[0xae])&255)===0x55 && lightIdleTimes.includes(idleSeconds)
      ? idleSeconds : null;
    const battery=await readBattery(link);
    const latest=decodeHeader(await block(0,6));
    if(latest.count!==header.count||slots[latest.slot].x==null) throw new Error("讀取期間檔位改變，請重新讀取。");
    return {...values,slots,keys,count:latest.count,active:latest.slot,rate:latest.rate,battery,lightIdleSeconds,raw};
  }
  function bytesAt(raw,address,length) {
    return Uint8Array.from({length},(_,i)=>raw[address+i]);
  }

  // Compare the user's edits, allowing unrelated settings and the physical
  // DPI button to change independently during readback.
  function matchesEdits(base,target,actual,verifyAllKeys=false) {
    const resized=base.count!==target.count;
    if(resized && (actual.count!==target.count || actual.active!==target.active)) return false;
    if(Object.keys(fields).some(k=>base[k]!==target[k] && actual[k]!==target[k])) return false;
    if(target.keys.some((v,i)=>(verifyAllKeys || v!==base.keys[i]) && actual.keys[i]!==v)) return false;
    return target.slots.every((s,i)=>{
      if(resized && i>=target.count) return true;
      return ["x","y","color"].every(k=>
        (!resized && s[k]===base.slots[i][k]) || s[k]===actual.slots[i][k]);
    });
  }

  async function saveFull(link,base,target,verifyAllKeys) {
    const now=await readFull(link);
    const records=[];
    const topology=base.count!==target.count;
    const conflict=()=>new Error("滑鼠的設定已改變，請依最新讀值再次調整。");
    function plan(address,after) {
      if(after.some((_,i)=>now.raw[address+i]===undefined)) throw conflict();
      const before=bytesAt(now.raw,address,after.length);
      if(!sameBytes(before,after)) records.push({address,before,after});
    }
    for(const [field,[address,choices,wire=choices]] of Object.entries(fields)){
      if(base[field]===target[field]) continue;
      const index=choices.indexOf(target[field]);
      if(index<0||base[field]==null||now[field]==null) throw new Error("滑鼠沒有提供有效的設定值。");
      if(now[field]!==base[field] && now[field]!==target[field]) throw conflict();
      plan(address,checked([wire[index]]));
    }
    if(topology) {
      if(!Number.isInteger(target.count)||target.count<1||target.count>6 ||
         Math.abs(base.count-target.count)!==1|| !Number.isInteger(target.active) ||
         target.active<0 || target.active>7 ||
         (target.active>=target.count && (target.count<base.count || target.active!==base.active))) throw new Error("檔位變更無效。");
      if(base.count!==now.count||base.active!==now.active) throw conflict();
      for(let i=0;i<Math.max(base.count,target.count);i++){
        for(const f of ["x","y","color"]) if(now.slots[i][f]!==base.slots[i][f]) throw conflict();
      }
    }
    for(let i=0;i<target.slots.length;i++){
      if(topology && i>=target.count) continue;
      const old=base.slots[i], next=target.slots[i], current=now.slots[i];
      if(!old||!current) throw conflict();
      const edited=["x","y","color"].filter(f=>old[f]!==next[f]);
      if(!edited.length) continue;
      if(now.count!==base.count) throw conflict();
      if(i>=now.count && i!==now.active && !(topology&&i<target.count)) throw conflict();
      for(const f of edited) if(current[f]!==old[f] && current[f]!==next[f]) throw conflict();
      const xy=0x0c+4*i, rgb=0x2c+4*i;
      if(edited.includes("x")||edited.includes("y")){
        const desired={...current};
        for(const f of edited.filter(f=>f!=="color")) desired[f]=next[f];
        if(!["x","y"].every(f=>validEdit({field:f,slot:i,to:desired[f]}))) throw new Error("DPI 數值不在支援範圍。");
        const dpiRecord=current.x==null ? new Uint8Array(4) : bytesAt(now.raw,xy,4);
        plan(xy,dpiBytes({...current,dpiRecord},desired));
      }
      if(edited.includes("color")){
        if(!validEdit({field:"color",slot:i,to:next.color})) throw new Error("燈色無效。");
        plan(rgb,colorBytes(next.color));
      }
    }
    const changedKeys=target.keys.map((v,i)=>v!==base.keys[i]?i:-1).filter(i=>i>=0);
    // A named preset represents all six bindings, including the unchanged ones.
    if(verifyAllKeys && base.keys.some((v,i)=>v===target.keys[i] && now.keys[i]!==v)) throw conflict();
    const nextKeys=[...now.keys];
    for(const i of changedKeys){
      if(now.keys[i]!==base.keys[i] && now.keys[i]!==target.keys[i]) throw conflict();
      if(now.keys[i]==null) throw new Error("這個按鍵使用未辨識的指派。");
      nextKeys[i]=target.keys[i];
    }
    if(changedKeys.length&&!nextKeys.includes("左鍵點擊")) throw new Error("至少要保留一個左鍵點擊。");
    // Install a new left-click binding before removing a previous one.
    changedKeys.sort((a,b)=>Number(nextKeys[b]==="左鍵點擊")-Number(nextKeys[a]==="左鍵點擊"));
    for(const i of changedKeys){
      const name=nextKeys[i], usage=media[name], code=usage?5:bindings[name];
      if(code===undefined) throw new Error("按鍵功能無法寫入。");
      if(usage){
        const address=0x100+32*i;
        if(now.raw[address]===undefined) {
          const aux=await query(link,8,address,8);
          aux.forEach((v,j)=>now.raw[address+j]=v);
        }
        plan(address,mediaRecord(usage));
      }
      plan(0x60+4*i,checked([code&255,(code>>8)&255,code>>16]));
    }
    if(topology){
      if(target.count>base.count) plan(2,checked([target.count]));
      if(target.active!==base.active) plan(4,checked([target.active]));
      if(target.count<base.count) plan(2,checked([target.count]));
    }
    let allowedCount=now.count, allowedActive=now.active;
    for(const {address,before,after} of records){
      if(topology || (address>=0x0c && address<0x4c)){
        const head=decodeHeader(await query(link,8,0,6));
        if(head.count!==allowedCount || (topology && head.slot!==allowedActive)) throw conflict();
        if(!topology){
          const index=Math.floor((address-(address>=0x2c?0x2c:0x0c))/4);
          if(index>=head.count && index!==head.slot) throw conflict();
        }
      }
      const actual=await query(link,8,address,before.length);
      if(!sameBytes(actual,before)) throw conflict();
      await writeAndVerify(link,address,after);
      if(address===2) allowedCount=after[0];
      if(address===4) allowedActive=after[0];
    }
    const result=await readFull(link);
    if(records.some(({address,after})=>!sameBytes(bytesAt(result.raw,address,after.length),after)) ||
       !matchesEdits(base,target,result,verifyAllKeys)) throw conflict();
    return result;
  }


  return { filters, interfaces, read, apply, valueAt, validEdit, notifiedSlot, matchesEdits,
    readFull: link => session(link,readFull),
    saveFull: (link,base,target,verifyAllKeys=false) => session(link,() => saveFull(link,base,target,verifyAllKeys))
  };
})();

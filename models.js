"use strict";

const mouseModels = {
  aj199:{name:"AJ199",sensor:"PAW3395",defaultShell:"white", photos:{
    white:{file:"aj199-white.jpg", url:"https://cdn.shopify.com/s/files/1/0726/8528/9780/files/9_a2300fdc-7486-48b1-a5f4-0f788a1109ca.jpg?v=1714017706&width=940"},
    black:{file:"aj199-black.jpg", url:"https://cdn.shopify.com/s/files/1/0726/8528/9780/files/10_5564463f-c005-4ecc-9ee0-027250d60b34.jpg?v=1714017706&width=1000"}
  },driver:AJ199,step:50,maxDpi:26000,
    stages:6,debounce:30,description:"雙模電競滑鼠"},
  "aj179-pro":{name:"AJ179 PRO",sensor:"PAW3395",defaultShell:"black", photos:{
    black:{file:"aj179-pro.png", url:"https://geardb.cn/api/v1/images/85c443a1-26b9-45e1-b274-58c2ad840c78.png"},
    white:{file:"aj179-pro-white.png", url:"https://ajazz.com.ua/sites/default/files/styles/product_image_l/public/products/3_82.png?itok=gRO6qqfw"}
  },driver:AJ179Pro,step:50,maxDpi:26000,
    stages:8,debounce:10,description:"三模電競滑鼠"},
  "aj179-v2-max":{name:"AJ179 V2 MAX",sensor:"PAW3311",defaultShell:"black", photos:{
    black:{file:"aj179-v2-max.png", url:"https://geardb.cn/api/v1/images/9b3ab62a-8a6f-466e-a0c3-9a0a9fc5970f.png"},
    white:{file:"aj179-v2-max-white.png", url:"https://ajazz.com.ua/sites/default/files/styles/product_image_l/public/products/AJ179-V2-MAX-W%201.png?itok=_irn9vlp"}
  },driver:AJ179Max,step:100,maxDpi:12000,
    stages:6,debounce:255,description:"電競滑鼠"}
};
const modelQuery = new URLSearchParams(location.search);
let modelId = modelQuery.get("mode") === "demo" && Object.hasOwn(mouseModels,modelQuery.get("model")) ?
  modelQuery.get("model") : "aj199";
const currentModel = () => mouseModels[modelId];

// Appearance is a browser preference shared by demo and device modes.
const shellChoices = new Map();
const shellKey = id => "ajazz.shell-color.v1." + id;
function preferredShell(id) {
  if (shellChoices.has(id)) return shellChoices.get(id);
  let color;
  try { color = localStorage.getItem(shellKey(id)); } catch { /* Session-only storage. */ }
  const model = mouseModels[id];
  return Object.hasOwn(model.photos,color) ? color : model.defaultShell;
}

let pendingShellPhoto;
function showShellColor(color) {
  const model = currentModel(), photo = model.photos[color];
  const label = color === "white" ? "白色" : "黑色";
  const caption = document.querySelector(".model small");
  const images = list(".photo img,.map-inner img");
  for (const input of list("input[name=shell-color]")) input.checked = input.value === color;
  for (const img of images) if (img.dataset.model !== modelId) img.hidden = true;
  caption.textContent = model.sensor + " ／ " + label + "載入中";
  const load = new Image();
  pendingShellPhoto = load;
  load.referrerPolicy = "no-referrer";
  const localSrc = new URL("assets/" + photo.file, document.baseURI).href;
  load.onload = () => {
    if (pendingShellPhoto !== load) return;
    for (const [i,img] of images.entries()) {
      img.referrerPolicy = "no-referrer";
      img.alt = label + " " + model.name + (i ? " 按鍵位置示意" : " 型號外觀示意");
      img.dataset.model = modelId;
      img.dataset.shell = color;
      img.src = load.src;
      img.hidden = false;
    }
    caption.textContent = model.sensor + " ／ " + label + "示意";
  };
  load.onerror = () => {
    if (pendingShellPhoto !== load) return;
    if (load.src === localSrc) {
      load.src = photo.url;
    } else {
      for (const img of images) img.hidden = true;
      caption.textContent = model.sensor + " ／ " + label + "圖片無法載入";
    }
  };
  load.src = localSrc;
}

function identifyInterface(devices) {
  const candidates = Object.entries(mouseModels).filter(([,m]) => devices.some(d => m.driver.filters.some(f =>
    f.productId === d.productId && f.vendorId === d.vendorId)));
  if (candidates.length !== 1) throw new Error("請只選取一個支援的裝置。");
  const [model, {driver}] = candidates[0];
  return {model, driver, ...driver.interfaces(devices)};
}

function transportLabel(productId) {
  if ([0xfa7c,0x402d,0x5c2f].includes(productId)) return "2.4 GHz 接收器";
  return productId === 0x402c ? "藍牙" : "USB 有線";
}

function matchesModelEdits(base, target, actual, verifyKeys = false) {
  if (base.slots.length !== target.slots.length || actual.slots.length !== target.slots.length) return false;
  return (base.sensorSync === target.sensorSync || actual.sensorSync === target.sensorSync) &&
    AJ199.matchesEdits(base,target,actual,verifyKeys);
}

// Called once the controls exist, and again after a successful hardware identity read.
function showModel(id) {
  const changed = modelId !== id;
  modelId = id;
  const model = currentModel(), pro = id === "aj179-pro", max = id === "aj179-v2-max";
  document.body.dataset.model = id;
  document.title = model.name + " 滑鼠設定";
  const poster = document.querySelector(".model");
  poster.querySelector("h1").textContent = model.name;
  poster.querySelector("span").textContent = model.description;
  showShellColor(preferredShell(id));
  bands[0] = model.step;
  bands[bands.length-1] = model.maxDpi;
  for (const a of ["x","y"]) {
    const row = $("axis-"+a), number = $("num-"+a);
    number.min = number.step = model.step;
    number.max = model.maxDpi;
    row.querySelectorAll(".ticks span").forEach((tick,i) => tick.textContent = bands[i]);
    for (const step of row.querySelectorAll("[data-step]")) {
      const sign = Math.sign(Number(step.dataset.step));
      step.dataset.step = sign*model.step;
      step.title = (sign < 0 ? "減少 " : "增加 ") + model.step + " DPI";
      step.setAttribute("aria-label",step.title);
    }
  }
  list("#axes-mode button")[1].disabled = max;
  $("axes-mode").title = max ? "此型號提供 X/Y 同步調整" : "";
  $("debounce").max = model.debounce;
  document.querySelector(".stage-tools").hidden = id !== "aj199";
  $("led-title").textContent = pro ? "檔位指示色" : max ? "機身燈效" : "滾輪燈";
  $("modes").hidden = pro;
  $("light-note").textContent = pro ? "可調整各 DPI 檔位的指示色" : max ? "機身燈效與 DPI 檔色獨立" : "燈效模式 · 全部檔位";
  document.querySelector(".lighting-title").hidden = pro;
  for (const k of ["brightness","speed"]) $(k).closest(".setting").hidden = pro;
  $("brightness").min = max ? 0 : 10;
  $("brightness").step = max ? 25 : 10;
  document.querySelector("label[for=brightness] strong").textContent = max ? "機身燈亮度" : "滾輪燈亮度";
  for (const option of $("speed").options) if (option.value !== "") {
    option.hidden = max ? +option.value > 4 : +option.value === 0;
  }
  $("light-idle-time").closest("dl").hidden = id !== "aj199";
  $("motion-hint").textContent = max ? "儲存到滑鼠的感應器設定" : "預覽區依回報週期取樣";
  document.querySelector(".local-label").textContent = max ? "角度為頁面預覽" : "頁面預覽";
  for (const opt of $("key-action").options) {
    opt.hidden = pro && ["靜音","播放／暫停"].includes(opt.value);
  }
  const positions = max || pro ? [[41,29],[59,29],[50,26],[31.5,51],[31,39]] : points;
  for (let i=0;i<6;i++) {
    const dot = $("hot-"+i);
    dot.hidden = !positions[i];
    if (positions[i]) {dot.style.left = positions[i][0]+"%"; dot.style.top = positions[i][1]+"%";}
  }
  if (changed) keyProfiles.changeModel();
  $("model-select").value = id;
}

function updateModelOptions() {
  const pro = modelId === "aj179-pro", max = modelId === "aj179-v2-max";
  const pid = deviceUI.link?.command.productId;
  for (const b of list("#rate button")) b.hidden = +b.value > 1000 && (!pro || pid === 0x4026);
  $("rate-note").textContent = pro && pid === 0x402c ? "Hz · 儲存設定，藍牙實際頻率依連線而定" : "Hz · 全部檔位";
  if (max && pid === 0x5c2f) {
    $("color").disabled = true;
    $("color").parentElement.title = "此接收器的檔色讀回有限，請用 USB 修改";
  } else $("color").parentElement.title = "";
  if (max) $("light-note").textContent = pid === 0x5c2f ? "修改 DPI 檔色請使用 USB" : "機身燈效與 DPI 檔色獨立";
  if (max) $("motion-sync").disabled = state.sensorSync == null;
  else $("motion-sync").disabled = false;
  if (max) $("stage-count").textContent = state.slots.length + " 個儲存位置";
  if (pro || max) {
    const color = confirmed.slots[confirmedLive].color;
    $("live-light").textContent = color ? "· DPI 檔色" : "· 檔色未提供";
    document.querySelector(".slot-read i").style.background = color || "transparent";
  }
}

"use strict";

const simulation = new URLSearchParams(location.search).get("mode") === "demo";
const deviceUI = {
  link: null, snapshot: null, busy: false, pending: false, queuedRead: false,
  writeTimer: 0, readTimer: 0, stageTimer: 0, status: "未連接", detail: "", tone: "idle"
};

function deviceStatus(status, detail, tone = "idle") {
  Object.assign(deviceUI, {status, detail, tone});
  renderDeviceUI();
}

function renderDeviceUI() {
  if (simulation) return;
  keyProfiles.render();
  const {link, snapshot, busy, pending, status, detail, tone} = deviceUI;
  document.body.classList.toggle("disconnected", !snapshot);
  $("pairing").hidden = Boolean(snapshot);
  $("connect").hidden = Boolean(link);
  $("connect").disabled = busy || !navigator.hid || !navigator.locks;
  $("refresh").hidden = $("disconnect").hidden = !link;
  $("refresh").disabled = busy || pending;
  $("sync-status").textContent = status;
  $("sync-status").parentElement.dataset.tone = tone;
  $("connection-hint").textContent = detail || "插上 USB 資料線或 2.4 GHz 接收器，再選擇滑鼠。";
  $("last").textContent = detail;
  $("undo").disabled = !snapshot || busy || !undoState;
  for (const panel of list(".page")) panel.inert = !snapshot || busy;
  $("device-status").textContent = snapshot ? "已連接" : link ? "等待讀值" : "未連接";
  const medium = linkTransport(link);
  $("transport").textContent = {radio:"2.4 GHz 接收器", usb:"USB 有線", ble:"藍牙"}[medium] || "—";
  updateRateLimit();
  const battery = snapshot?.battery;
  $("battery").textContent = battery?.percent == null ? "—" : battery.percent + "%" + (battery.charging ? " · 充電中" : "");
  const seconds = snapshot?.lightIdleSeconds;
  $("light-idle-time").textContent = seconds == null ? "未提供" :
    seconds < 60 ? seconds + " 秒" : seconds / 60 + " 分鐘";
  if (!snapshot) {
    document.querySelector(".wheel").className = "wheel off";
    return;
  }
  const resizing = pending && state.count !== snapshot.count;
  const addReason = state.count >= 6 ? "一般版最多可新增至六檔" : "";
  const removeReason = state.count > 6 ? "目前配置超出一般版六檔範圍" :
    state.count <= 1 ? "至少保留一檔" :
    edit >= state.count || live >= state.count ? "請先切換到已啟用的檔位" : "";
  for (const [button, reason] of [[$("add-stage"), addReason], [$("remove-stage"), removeReason]]) {
    button.disabled = Boolean(reason) || resizing;
    button.title = resizing ? "正在更新檔位數量" : reason;
  }
  for (const k of ["snap","ripple"]) {
    $(k).disabled = state[k] == null;
    if ($(k).disabled) $(k).querySelector("span").textContent = "未提供";
  }
  for (const [group, field] of [["lod","lod"],["modes","mode"]]) {
    for (const button of list("#" + group + " button")) {
      button.disabled = state[field] == null;
      button.title = button.disabled ? "裝置未提供有效讀值" : "";
    }
  }
  $("debounce").disabled = state.debounce == null;
  $("debounce").placeholder = "—";
  $("color").disabled = !state.slots[edit].color;
  $("brightness").disabled = state.brightness == null || !state.mode || state.mode === "off";
  $("speed").disabled = state.speed == null || state.mode !== "breathing";
  $("key-action").disabled = state.keys[key] == null;
  updateModelOptions();
}

function acceptDeviceRead(actual) {
  const previous = deviceUI.snapshot;
  if (modelId !== deviceUI.link.model) showModel(deviceUI.link.model);
  // A physical stage change alone must not invalidate Undo. A concurrent
  // settings change does, since Undo must never replay stale device values.
  if (previous && (!matchesModelEdits(previous, actual, previous) ||
      (undoState?.layout && previous.active !== actual.active))) undoState = null;
  deviceUI.snapshot = actual;
  state = {...actual, slots: copy(actual.slots), keys: [...actual.keys],
    motionSync: state.motionSync, gripAngle: state.gripAngle};
  delete state.raw;
  delete state.battery;
  delete state.lightIdleSeconds;
  delete state.active;
  confirmed = copy(state);
  live = confirmedLive = actual.active;
  if (!previous) {
    follow = true;
    axis = "x";
    split = actual.slots.map(s => s.x !== s.y);
  }
  if (follow || (edit >= state.count && edit !== live)) edit = live;
  if (modelId === "aj179-v2-max") split.fill(false);
  else if (state.slots[edit].x !== state.slots[edit].y) split[edit] = true;
  if (!split[edit]) axis = "x";
  render();
}

function scheduleDeviceRead(delay) {
  clearTimeout(deviceUI.readTimer);
  const link = deviceUI.link;
  if (!link) return;
  deviceUI.readTimer = setTimeout(() => {
    if (deviceUI.link !== link) return;
    if (deviceUI.busy || deviceUI.pending || gesture) deviceUI.queuedRead = true;
    else if (document.activeElement?.dataset.typing) scheduleDeviceRead(700);
    else readDevice();
  }, delay);
}

// AJ179 exposes the active slot through a query. Keep the edit selection
// independent, and suspend polling while the tab is hidden or an edit is pending.
function scheduleStageWatch(link) {
  clearTimeout(deviceUI.stageTimer);
  if (!link.driver.readActive || !deviceUI.snapshot || document.hidden) return;
  deviceUI.stageTimer = setTimeout(async () => {
    if (deviceUI.link !== link || document.hidden || !deviceUI.snapshot) return;
    const available = () => !deviceUI.pending && !deviceUI.busy && !gesture && !document.activeElement?.dataset.typing;
    if (available()) {
      try {
        const active = await link.driver.readActive(link);
        if (deviceUI.link === link && available() && active !== deviceUI.snapshot?.active) scheduleDeviceRead(0);
      } catch {
        if (deviceUI.link === link && available()) scheduleDeviceRead(0);
      }
    }
    if (deviceUI.link === link) scheduleStageWatch(link);
  },3000);
}

function finishDeviceWork(link) {
  if (deviceUI.link !== link) return;
  deviceUI.busy = false;
  scheduleStageWatch(link);
  if (deviceUI.queuedRead) {
    deviceUI.queuedRead = false;
    scheduleDeviceRead(90);
  } else if (deviceUI.snapshot) scheduleDeviceRead(45000);
  renderDeviceUI();
}

function readFailed(link, error) {
  deviceUI.snapshot = null;
  deviceUI.pending = false;
  undoState = null;
  const waking = error.retryOnWake && [0xfa7c,0x402d].includes(link.command.productId) && link.retries++ < 8;
  deviceStatus(waking ? "等待滑鼠喚醒" : "未取得讀值",
    error.message + (waking ? " 網頁會自動重讀。" : " 可按「重新讀取」再試一次。"), "error");
  if (waking) scheduleDeviceRead(2000);
}

async function readDevice() {
  const link = deviceUI.link;
  if (!link || deviceUI.busy || deviceUI.pending) return;
  clearTimeout(deviceUI.readTimer);
  deviceUI.busy = true;
  deviceStatus("讀取中", "正在讀取滑鼠設定。", "busy");
  try {
    const actual = await link.driver.readFull(link);
    if (deviceUI.link !== link) return;
    acceptDeviceRead(actual);
    link.retries = 0;
    deviceStatus("已讀回", "正在使用第 " + (live + 1) + " 檔。", "ready");
  } catch (error) {
    if (deviceUI.link === link) readFailed(link, error);
  } finally { finishDeviceWork(link); }
}

function queueDeviceWrite() {
  clearTimeout(deviceUI.writeTimer);
  const base = deviceUI.snapshot;
  if (!base || deviceUI.busy) return;
  confirmed.motionSync = state.motionSync;
  confirmed.gripAngle = state.gripAngle;
  const target = {...state, active: live};
  deviceUI.pending = !matchesModelEdits(base, target, base);
  if (!deviceUI.pending) {
    deviceStatus("已就緒", last, "idle");
    if (deviceUI.queuedRead && !gesture) {
      deviceUI.queuedRead = false;
      scheduleDeviceRead(90);
    }
    return;
  }
  deviceStatus("準備寫入", last, "busy");
  if (!gesture) deviceUI.writeTimer = setTimeout(writeDevice, 220);
}

async function writeDevice(verifyAllKeys = false) {
  const {link, snapshot: base} = deviceUI;
  if (!link || !base || gesture || deviceUI.busy || !deviceUI.pending) return;
  clearTimeout(deviceUI.readTimer);
  const target = {...copy(state), active: live};
  const history = undoState;
  deviceUI.pending = false;
  deviceUI.busy = true;
  deviceStatus("寫入中", last, "busy");
  try {
    const result = await link.driver.saveFull(link, base, target, verifyAllKeys);
    if (deviceUI.link !== link) return;
    acceptDeviceRead(result);
    // Undo only if no other settings changed during this transaction.
    if (matchesModelEdits(target, result, target)) undoState = history;
    deviceStatus("已寫入並讀回", last, "ready");
  } catch (error) {
    if (deviceUI.link !== link) return;
    undoState = null;
    deviceStatus("重新核對", "正在確認滑鼠目前的設定。", "busy");
    try {
      const actual = await link.driver.readFull(link);
      if (deviceUI.link !== link) return;
      acceptDeviceRead(actual);
      if (matchesModelEdits(base, target, actual, verifyAllKeys)) deviceStatus("已讀回確認", last, "ready");
      else deviceStatus("未完整套用", error.message + " 畫面已更新為滑鼠目前的設定。", "error");
    } catch (readError) {
      if (deviceUI.link === link) readFailed(link, readError);
    }
  } finally { finishDeviceWork(link); }
}

async function disconnectDevice(message = "已中斷連接。") {
  const link = deviceUI.link;
  if (!link) return;
  deviceUI.link = null;
  link.controller.abort();
  clearTimeout(deviceUI.stageTimer);
  clearTimeout(deviceUI.readTimer);
  clearTimeout(deviceUI.writeTimer);
  Object.assign(deviceUI, {snapshot: null, busy: true, pending: false, queuedRead: false});
  gesture = undoState = null;
  for (const input of list("[data-typing]")) delete input.dataset.typing;
  deviceStatus("未連接", message);
  await Promise.allSettled(link.devices.filter(d => d.opened).map(d => d.close()));
  deviceUI.busy = false;
  renderDeviceUI();
}

async function connectDevice() {
  if (deviceUI.busy || deviceUI.link) return;
  deviceUI.busy = true;
  deviceStatus("選擇裝置", "請在瀏覽器清單中選取滑鼠或接收器。", "busy");
  let link;
  try {
    const selected = await navigator.hid.requestDevice({filters: Object.values(mouseModels).flatMap(m => m.driver.filters)});
    if (!selected.length) throw new Error("尚未選取裝置。");
    const {model, driver, command, input} = identifyInterface(selected);
    const controller = new AbortController();
    link = {model, driver, command, input, controller, signal: controller.signal, devices: [...new Set([input, command])], retries: 0};
    deviceUI.link = link;
    for (const device of link.devices) {
      if (link.signal.aborted) return;
      if (!device.opened) await device.open();
      if (link.signal.aborted) { if (device.opened) await device.close(); return; }
    }
    if (driver.notifiedSlot) input.addEventListener("inputreport", event => {
      const slot = driver.notifiedSlot(event);
      if (slot === null || slot === deviceUI.snapshot?.active && !deviceUI.busy && !deviceUI.pending) return;
      if (deviceUI.busy || deviceUI.pending) deviceUI.queuedRead = true;
      else scheduleDeviceRead(65);
    }, {signal: link.signal});
    deviceUI.busy = false;
    await readDevice();
  } catch (error) {
    if (link && deviceUI.link !== link) return;
    const message = error.name === "NotFoundError" ? "尚未選取裝置。" : error.message;
    if (link) await disconnectDevice(message);
    else { deviceUI.busy = false; deviceStatus("未連接", message); }
  }
}

function setupDeviceUI() {
  function unknown(select, label) {
    const option = new Option(label, "");
    option.disabled = true;
    select.add(option, 0);
  }
  unknown($("speed"), "未提供");
  for (let n = 0; n <= 8; n++) $("speed").add(new Option("速度 " + n, n));
  unknown($("key-action"), "其他指派");
  $("cycle").hidden = !simulation;
  $("play").hidden = !simulation;
  $("pairing").hidden = simulation;
  for (const [id,model] of Object.entries(mouseModels)) $("model-select").add(new Option(model.name, id));
  $("model-picker").hidden = !simulation;
  for (const button of list('[aria-controls="spec-dialog"]')) {
    button.onclick = () => $("spec-dialog").showModal();
  }
  for (const tag of list("#spec-connections small")) tag.textContent = simulation ? "模擬" : "目前連線";
  $("model-select").onchange = event => {
    const url = new URL(location.href);
    url.searchParams.set("model",event.target.value);
    location.assign(url);
  };
  for (const input of list("input[name=shell-color]")) {
    input.onchange = () => {
      shellChoices.set(modelId,input.value);
      try { localStorage.setItem(shellKey(modelId),input.value); } catch { /* Keep the choice for this session. */ }
      showShellColor(input.value);
    };
  }
  showModel(modelId);
  if (simulation) {
    $("mode-link").href = location.pathname;
    $("mode-link").textContent = "連接真實滑鼠";
    const transportSelect = $("demo-transport");
    for (const medium of Object.keys(currentModel().maxRates)) {
      transportSelect.add(new Option(connectionNames[medium] + " 模擬", medium));
    }
    transportSelect.value = "radio";
    transportSelect.onchange = updateRateLimit;
    transportSelect.hidden = false;
    $("transport").hidden = true;
    $("battery").textContent = "模擬供電";
    $("device-status").textContent = "模擬裝置";
    $("light-idle-time").textContent = "5 分鐘";
    return;
  }
  $("connect").onclick = connectDevice;
  $("disconnect").onclick = () => disconnectDevice();
  $("refresh").onclick = () => { if (deviceUI.link) deviceUI.link.retries = 0; readDevice(); };
  if (!navigator.hid || !navigator.locks) deviceUI.detail = "請使用桌面版 Chrome 或 Edge，透過 localhost 或 HTTPS 開啟此頁。";
  navigator.hid?.addEventListener("disconnect", event => {
    if (deviceUI.link?.devices.includes(event.device)) disconnectDevice("滑鼠或接收器已拔除。");
  });
  document.addEventListener("visibilitychange", () => {
    clearTimeout(deviceUI.stageTimer);
    if (!document.hidden && deviceUI.link) scheduleDeviceRead(100);
  });
}

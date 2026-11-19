"use strict";

const keyProfiles = (() => {
  const storageKey = () => modelId + ".key-profiles.v1." + (simulation ? "demo" : "device");
  let profiles = [], preferredId = "", editing = null, storageError = "", saving = false;

  function sameKeys(a, b) {
    return a.length === b.length && a.every((action, i) => action === b[i]);
  }

  function supported(keys) {
    return Array.isArray(keys) && keys.length === 6 &&
      keys.every(action => actions.includes(action) && (modelId !== "aj179-pro" || !["靜音","播放／暫停"].includes(action))) && keys.includes("左鍵點擊");
  }

  function confirmedKeys() {
    return simulation ? confirmed.keys : deviceUI.snapshot?.keys;
  }

  function ready() {
    return simulation ? !confirmTimer : Boolean(deviceUI.snapshot && !deviceUI.busy && !deviceUI.pending);
  }

  function readProfiles() {
    const raw = localStorage.getItem(storageKey());
    if (raw === null) return [];
    const items = JSON.parse(raw);
    if (!Array.isArray(items) || !items.every(p => p && typeof p.id === "string" &&
      typeof p.name === "string" && p.name.trim() && supported(p.keys))) {
      throw new Error("無法讀取已儲存的按鍵配置。");
    }
    return items;
  }

  function reload() {
    try {
      profiles = readProfiles();
      storageError = "";
    } catch {
      profiles = [];
      storageError = "無法讀取這個瀏覽器的配置儲存空間。";
    }
    const buttons = profiles.map(p => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.id = p.id;
      button.textContent = p.name;
      button.title = p.name;
      return button;
    });
    $("key-profiles").replaceChildren(...buttons);
    render();
  }

  function matching(keys) {
    if (!keys) return null;
    return profiles.find(p => p.id === preferredId && sameKeys(p.keys, keys)) ||
      profiles.find(p => sameKeys(p.keys, keys));
  }

  function render() {
    const keys = confirmedKeys();
    const active = matching(keys);
    const canUseKeys = ready() && supported(keys) && !storageError;
    const status = storageError || (!keys ? "等待裝置讀值" :
      !supported(keys) ? "配置需要六個已辨識的指派，並保留左鍵點擊" :
      active ? "目前配置 · " + active.name :
      profiles.length ? "目前指派與已存配置不同" : "可將目前六鍵存為配置");
    if ($("key-profile-status").textContent !== status) $("key-profile-status").textContent = status;
    for (const b of $("key-profiles").children) {
      press(b, b.dataset.id === active?.id);
      b.disabled = !canUseKeys;
    }
    $("profile-new").disabled = !canUseKeys;
    $("profile-manage").disabled = !profiles.length || !!storageError;
    $("profile-update").disabled = saving || !canUseKeys || !editing || sameKeys(editing.keys, keys);
    $("profile-delete").disabled = saving || !editing;
    $("profile-save").disabled = saving || ($("profile-picker-label").hidden ? !canUseKeys : !editing);
  }

  function switchTo(id) {
    const profile = profiles.find(p => p.id === id);
    if (!profile || !ready() || !supported(confirmedKeys())) return;
    preferredId = id;
    if (sameKeys(confirmedKeys(), profile.keys)) { render(); return; }
    change("切換按鍵配置「" + profile.name + "」", () => { state.keys = [...profile.keys]; }, null, null);
    if (!simulation) {
      clearTimeout(deviceUI.writeTimer);
      writeDevice(true);
    }
  }

  function editSelected() {
    editing = profiles.find(p => p.id === $("profile-picker").value) || null;
    $("profile-name").value = editing?.name || "";
    const missing = !editing && !$("profile-picker-label").hidden;
    if (missing) $("profile-error").textContent = "這個配置已移除，請重新開啟管理配置。";
    $("profile-error").hidden = !missing;
    render();
  }

  function openDialog(manage) {
    $("profile-title").textContent = manage ? "管理按鍵配置" : "儲存目前按鍵配置";
    $("profile-save").textContent = manage ? "儲存名稱" : "儲存";
    $("profile-picker-label").hidden = $("profile-maintenance").hidden = !manage;
    $("profile-picker").replaceChildren();
    if (manage) {
      for (const p of profiles) $("profile-picker").add(new Option(p.name, p.id));
      const selected = matching(confirmedKeys()) || profiles.find(p => p.id === preferredId) || profiles[0];
      $("profile-picker").value = selected.id;
    }
    editSelected();
    $("profile-dialog").showModal();
    $("profile-name").focus();
    $("profile-name").select();
  }

  async function save(operation) {
    if (saving) return;
    const original = editing, store = storageKey();
    const name = $("profile-name").value.trim();
    if (operation === "delete" && !confirm("刪除配置「" + original.name + "」？滑鼠會保留目前的按鍵指派。")) return;
    saving = true;
    render();
    function persist() {
      if (storageKey() !== store) throw new Error("型號已變更，請重新選擇配置。");
      const items = readProfiles();
      const record = original && items.find(p => p.id === original.id);
      if (original && (!record || record.name !== original.name || !sameKeys(record.keys, original.keys))) {
        throw new Error("這個配置已在其他分頁變更，請重新開啟管理配置。");
      }
      if (operation === "rename" || operation === "new") {
        if (!name) throw new Error("請輸入配置名稱。");
        if (items.some(p => p.id !== original?.id && p.name.toLowerCase() === name.toLowerCase())) {
          throw new Error("已有同名配置，請換一個名稱。");
        }
      }
      const keys = confirmedKeys();
      if ((operation === "new" || operation === "update") && (!ready() || !supported(keys))) {
        throw new Error("請等六個按鍵指派讀回後再儲存。");
      }
      let id = original?.id;
      if (operation === "new") {
        id = crypto.randomUUID();
        items.push({id, name, keys: [...keys]});
      } else if (operation === "rename") record.name = name;
      else if (operation === "update") record.keys = [...keys];
      else items.splice(items.indexOf(record), 1);
      localStorage.setItem(store, JSON.stringify(items));
      if (operation === "new" || operation === "update") preferredId = id;
    }
    try {
      if (navigator.locks) await navigator.locks.request(store, persist);
      else persist();
      reload();
      $("profile-dialog").close();
    } catch (error) {
      $("profile-error").textContent = error instanceof DOMException ? "瀏覽器無法儲存配置，請確認網站儲存空間可用。" : error.message;
      $("profile-error").hidden = false;
    } finally {
      saving = false;
      render();
    }
  }

  function setup() {
    $("key-profiles").onclick = e => { if (e.target.dataset.id) switchTo(e.target.dataset.id); };
    $("profile-new").onclick = () => openDialog(false);
    $("profile-manage").onclick = () => openDialog(true);
    $("profile-picker").onchange = editSelected;
    $("profile-form").onsubmit = e => { e.preventDefault(); save(editing ? "rename" : "new"); };
    $("profile-update").onclick = () => save("update");
    $("profile-delete").onclick = () => save("delete");
    $("profile-cancel").onclick = () => $("profile-dialog").close();
    window.addEventListener("storage", e => { if (e.key === storageKey() || e.key === null) reload(); });
    reload();
  }

  function changeModel() {
    preferredId = "";
    editing = null;
    if ($("profile-dialog").open) $("profile-dialog").close();
    reload();
  }
  return {setup, render, changeModel};
})();

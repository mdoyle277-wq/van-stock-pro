import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./supabase-config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});
const el = id => document.getElementById(id);
const panel = el("referenceLibraryPanel");
if (panel) {
  const status = el("referenceLibraryStatus");
  const list = el("referenceLibraryList");
  const folderLabel = el("referenceLibraryCurrentFolder");
  const search = el("referenceLibrarySearch");
  const uploadInput = el("referenceLibraryUpload");
  const storageChoice = el("referenceLibraryStorage");
  let session = null;
  let currentFolder = "";
  let localItems = [];
  let cloudItems = [];
  let db = null;
  const BUCKET = "account-reference-library";
  const MAX_BYTES = 20 * 1024 * 1024;

  function say(message, kind) {
    status.textContent = message;
    status.dataset.kind = kind || "info";
  }
  function safeName(value) {
    return String(value || "document").replace(/[\\\\/]/g, "-").replace(/[^a-zA-Z0-9._() -]/g, "_").slice(0, 140);
  }
  function openDb(userId) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("vsp-reference-library-" + userId, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("items")) database.createObjectStore("items", { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  function store(mode, item) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction("items", mode);
      const req = tx.objectStore("items")[mode === "readonly" ? "getAll" : "put"](item);
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Local file storage failed"));
    });
  }
  function removeLocal(id) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction("items", "readwrite");
      tx.objectStore("items").delete(id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }
  function relativeFolder() {
    return currentFolder;
  }
  function parentFolder(path) {
    const parts = path.split("/").filter(Boolean);
    parts.pop();
    return parts.join("/");
  }
  function isInCurrentFolder(path) {
    return String(path || "") === currentFolder;
  }
  function mergedItems() {
    const map = new Map();
    localItems.forEach(item => map.set(item.id, { ...item, local: true, cloud: item.storage_mode === "both" }));
    cloudItems.forEach(item => {
      const old = map.get(item.id);
      map.set(item.id, { ...(old || {}), ...item, local: !!old, cloud: true, blob: old?.blob });
    });
    return [...map.values()].filter(item => isInCurrentFolder(item.folder_path))
      .filter(item => !search.value || item.original_name.toLowerCase().includes(search.value.toLowerCase()))
      .sort((a,b) => (a.item_type === b.item_type ? a.original_name.localeCompare(b.original_name) : a.item_type === "folder" ? -1 : 1));
  }
  function makeButton(label, action, className) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className || "secondary smallbtn";
    button.textContent = label;
    button.addEventListener("click", action);
    return button;
  }
  function render() {
    if (!session) return;
    folderLabel.textContent = currentFolder ? " / " + currentFolder.replace(/\\//g, " / ") : " / All references";
    list.replaceChildren();
    const items = mergedItems();
    if (currentFolder) {
      const up = document.createElement("div");
      up.className = "reference-library-row";
      up.append(makeButton("← Back", () => { currentFolder = parentFolder(currentFolder); render(); }));
      list.append(up);
    }
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No references here yet. Add a folder or upload a document.";
      list.append(empty);
      return;
    }
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "reference-library-row";
      const details = document.createElement("div");
      details.className = "reference-library-details";
      const name = document.createElement("strong");
      name.textContent = (item.item_type === "folder" ? "📁 " : (item.mime_type === "application/pdf" ? "📕 " : "📄 ")) + item.original_name;
      const meta = document.createElement("small");
      const labels = [];
      if (item.item_type === "folder") labels.push("Folder");
      else {
        labels.push(formatBytes(item.file_size || item.blob?.size || 0));
        labels.push(item.cloud ? "Cloud backup" : "Local device only");
      }
      meta.textContent = labels.join(" · ");
      details.append(name, meta);
      const actions = document.createElement("div");
      actions.className = "reference-library-actions";
      if (item.item_type === "folder") {
        actions.append(makeButton("Open", () => { currentFolder = [currentFolder, item.original_name].filter(Boolean).join("/"); render(); }));
      } else {
        actions.append(makeButton("Open", () => openItem(item)));
        if (item.local && !item.cloud) actions.append(makeButton("Back up", () => backupItem(item)));
        if (item.cloud && !item.local) actions.append(makeButton("Save offline", () => saveOffline(item)));
      }
      actions.append(makeButton("Rename", () => renameItem(item)));
      actions.append(makeButton("Delete", () => deleteItem(item), "danger smallbtn"));
      row.append(details, actions);
      list.append(row);
    }
  }
  function formatBytes(bytes) {
    if (!bytes) return "0 B";
    const units = ["B","KB","MB","GB"];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3);
    return (bytes / Math.pow(1024,index)).toFixed(index ? 1 : 0) + " " + units[index];
  }
  async function refresh() {
    if (!session?.user?.id) return;
    localItems = await store("readonly");
    const { data, error } = await supabase.from("reference_library_items")
      .select("id,owner_user_id,item_type,original_name,folder_path,mime_type,file_size,storage_path,created_at,updated_at")
      .eq("owner_user_id", session.user.id)
      .order("item_type", { ascending: true }).order("original_name", { ascending: true });
    if (error) throw error;
    cloudItems = data || [];
    render();
  }
  async function addFolder() {
    const name = prompt("Folder name");
    if (!name || !name.trim()) return;
    const clean = safeName(name.trim());
    if (clean.includes("/")) { say("Folder names cannot contain a slash.", "error"); return; }
    const path = [currentFolder, clean].filter(Boolean).join("/");
    if (localItems.some(item => item.item_type === "folder" && item.folder_path === currentFolder && item.original_name.toLowerCase() === clean.toLowerCase())) {
      say("That folder already exists.", "error"); return;
    }
    await store("readwrite", { id: crypto.randomUUID(), user_id: session.user.id, item_type: "folder", original_name: clean, folder_path: currentFolder, mime_type: "", file_size: 0, storage_mode: "local", created_at: new Date().toISOString() });
    say("Folder created on this device.", "success");
    await refresh();
  }
  async function uploadFile(file) {
    if (!file) return;
    if (file.size > MAX_BYTES) { say("This file is over the 20 MB limit.", "error"); return; }
    const id = crypto.randomUUID();
    const local = { id, user_id: session.user.id, item_type: "file", original_name: file.name, folder_path: relativeFolder(), mime_type: file.type || "application/octet-stream", file_size: file.size, blob: file, storage_mode: "local", created_at: new Date().toISOString() };
    if (storageChoice.value === "cloud") {
      await store("readwrite", local);
      await uploadLocalToCloud(local);
    } else {
      await store("readwrite", local);
      say("Saved locally on this device. It is not backed up to the cloud.", "success");
    }
    await refresh();
  }
  async function uploadLocalToCloud(item) {
    const path = session.user.id + "/" + item.id + "/" + safeName(item.original_name);
    const { error: uploadError } = await supabase.storage.from(BUCKET).upload(path, item.blob, {
      contentType: item.mime_type || "application/octet-stream",
      upsert: false
    });
    if (uploadError) throw uploadError;
    const record = {
      id: item.id,
      owner_user_id: session.user.id,
      item_type: "file",
      original_name: item.original_name,
      folder_path: item.folder_path || "",
      mime_type: item.mime_type || "application/octet-stream",
      file_size: item.file_size || item.blob.size,
      storage_path: path
    };
    const { error } = await supabase.from("reference_library_items").insert(record);
    if (error) {
      await supabase.storage.from(BUCKET).remove([path]);
      throw error;
    }
    await store("readwrite", { ...item, storage_mode: "both" });
    say("Cloud backup complete. A local copy is also kept on this device.", "success");
  }
  async function backupItem(item) {
    try {
      say("Backing up " + item.original_name + "…");
      await uploadLocalToCloud(item);
      await refresh();
    } catch (error) { say("Backup failed: " + (error.message || "Unknown error"), "error"); }
  }
  async function saveOffline(item) {
    try {
      say("Downloading " + item.original_name + "…");
      const { data, error } = await supabase.storage.from(BUCKET).download(item.storage_path);
      if (error) throw error;
      await store("readwrite", { id: item.id, user_id: session.user.id, item_type: "file", original_name: item.original_name, folder_path: item.folder_path || "", mime_type: item.mime_type, file_size: item.file_size, blob: data, storage_mode: "both", created_at: item.created_at });
      say("A local offline copy has been saved.", "success");
      await refresh();
    } catch (error) { say("Download failed: " + (error.message || "Unknown error"), "error"); }
  }
  async function openItem(item) {
    try {
      let blob = item.blob;
      if (!blob) {
        const { data, error } = await supabase.storage.from(BUCKET).download(item.storage_path);
        if (error) throw error;
        blob = data;
      }
      const url = URL.createObjectURL(blob);
      const opened = window.open(url, "_blank", "noopener");
      if (!opened) {
        const a = document.createElement("a");
        a.href = url; a.download = item.original_name; a.click();
      }
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) { say("Could not open file: " + (error.message || "Unknown error"), "error"); }
  }
  async function renameItem(item) {
    const name = prompt("New name", item.original_name);
    if (!name || !name.trim() || name.trim() === item.original_name) return;
    const clean = safeName(name.trim());
    try {
      if (item.cloud) {
        const { error } = await supabase.from("reference_library_items").update({ original_name: clean, updated_at: new Date().toISOString() }).eq("id", item.id).eq("owner_user_id", session.user.id);
        if (error) throw error;
      }
      const local = localItems.find(x => x.id === item.id);
      if (local) await store("readwrite", { ...local, original_name: clean });
      say("Renamed.", "success");
      await refresh();
    } catch (error) { say("Rename failed: " + (error.message || "Unknown error"), "error"); }
  }
  async function deleteItem(item) {
    if (!confirm("Delete " + item.original_name + "? This cannot be undone.")) return;
    try {
      if (item.cloud) {
        const { error: storageError } = await supabase.storage.from(BUCKET).remove([item.storage_path]);
        if (storageError) throw storageError;
        const { error } = await supabase.from("reference_library_items").delete().eq("id", item.id).eq("owner_user_id", session.user.id);
        if (error) throw error;
      }
      await removeLocal(item.id);
      say("Deleted.", "success");
      await refresh();
    } catch (error) { say("Delete failed: " + (error.message || "Unknown error"), "error"); }
  }
  async function loadSession(nextSession) {
    const nextId = nextSession?.user?.id || null;
    const oldId = session?.user?.id || null;
    session = nextSession;
    if (!nextId) {
      db?.close(); db = null; localItems = []; cloudItems = [];
      panel.hidden = false;
      say("Sign in to use your private reference library.", "info");
      list.replaceChildren();
      return;
    }
    if (oldId !== nextId) {
      db?.close();
      db = await openDb(nextId);
      currentFolder = "";
    }
    panel.hidden = false;
    try { await refresh(); say("Private library ready for " + (session.user.email || "this account") + ".", "success"); }
    catch (error) { say("Library could not load: " + (error.message || "Unknown error"), "error"); }
  }
  el("referenceLibraryAddFolder").addEventListener("click", () => addFolder().catch(error => say(error.message, "error")));
  el("referenceLibraryUploadButton").addEventListener("click", () => uploadInput.click());
  uploadInput.addEventListener("change", async () => {
    const file = uploadInput.files?.[0];
    uploadInput.value = "";
    try { await uploadFile(file); } catch (error) { say("Upload failed: " + (error.message || "Unknown error"), "error"); }
  });
  search.addEventListener("input", render);
  el("referenceLibraryRefresh").addEventListener("click", () => refresh().then(() => say("Library refreshed.", "success")).catch(error => say(error.message, "error")));
  el("referenceLibraryHome").addEventListener("click", () => { currentFolder = ""; render(); });
  supabase.auth.onAuthStateChange((_event, nextSession) => { void loadSession(nextSession); });
  const { data } = await supabase.auth.getSession();
  await loadSession(data.session);
}

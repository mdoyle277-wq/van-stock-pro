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
    return String(value || "document").replace(/[\\\/]/g, "-").replace(/[^a-zA-Z0-9._() -]/g, "_").slice(0, 140);
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
    folderLabel.textContent = currentFolder ? " / " + currentFolder.replace(/\//g, " / ") : " / All references";
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
    const folder = { id: crypto.randomUUID(), user_id: session.user.id, item_type: "folder", original_name: clean, folder_path: currentFolder, mime_type: "", file_size: 0, storage_mode: storageChoice.value === "cloud" ? "both" : "local", created_at: new Date().toISOString() };
    await store("readwrite", folder);
    if (storageChoice.value === "cloud") {
      const { error } = await supabase.from("reference_library_items").insert({ id: folder.id, owner_user_id: session.user.id, item_type: "folder", original_name: clean, folder_path: currentFolder, mime_type: "", file_size: 0, storage_path: null });
      if (error) throw error;
      say("Folder created and backed up to your account.", "success");
    } else { say("Folder created on this device only.", "success"); }
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
    await ensureCloudFolders(item.folder_path || "");
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
  async function ensureCloudFolders(path) {
    const parts = String(path || "").split("/").filter(Boolean);
    let parent = "";
    for (const part of parts) {
      const existing = cloudItems.find(x => x.item_type === "folder" && x.folder_path === parent && x.original_name === part);
      if (!existing) {
        const localFolder = localItems.find(x => x.item_type === "folder" && x.folder_path === parent && x.original_name === part);
        const id = localFolder?.id || crypto.randomUUID();
        const { error } = await supabase.from("reference_library_items").insert({
          id, owner_user_id: session.user.id, item_type: "folder",
          original_name: part, folder_path: parent, mime_type: "", file_size: 0, storage_path: null
        });
        if (error && !/duplicate key/i.test(error.message || "")) throw error;
        if (localFolder) await store("readwrite", { ...localFolder, storage_mode: "both" });
      }
      parent = [parent, part].filter(Boolean).join("/");
    }
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
      if (item.item_type === "folder") {
        const folderPath = [item.folder_path, item.original_name].filter(Boolean).join("/");
        const hasChildren = [...localItems, ...cloudItems].some(child => child.id !== item.id && child.folder_path === folderPath);
        if (hasChildren) throw new Error("This folder is not empty. Move or delete its contents first.");
      }
      if (item.cloud) {
        if (item.item_type === "file" && item.storage_path) {
          const { error: storageError } = await supabase.storage.from(BUCKET).remove([item.storage_path]);
          if (storageError) throw storageError;
        }
        const { error } = await supabase.from("reference_library_items").delete().eq("id", item.id).eq("owner_user_id", session.user.id);
        if (error) throw error;
      }
      await removeLocal(item.id);
      say("Deleted.", "success");
      await refresh();
    } catch (error) { say("Delete failed: " + (error.message || "Unknown error"), "error"); }
  }
  async function loadSession(nextSession) {
    // Hide immediately on an account/session change, before any async work.
    // Do not hide again after awaiting IndexedDB: the user may have opened
    // the panel while account initialisation was still completing.
    panel.hidden = true;
    const nextId = nextSession?.user?.id || null;
    const oldId = session?.user?.id || null;
    session = nextSession;
    if (!nextId) {
      db?.close(); db = null; localItems = []; cloudItems = [];
      panel.hidden = true;
      say("Sign in to use your private reference library.", "info");
      list.replaceChildren();
      return;
    }
    if (oldId !== nextId) {
      db?.close();
      db = await openDb(nextId);
      currentFolder = "";
    }
    try { await refresh(); say("Private library ready for " + (session.user.email || "this account") + ".", "success"); }
    catch (error) { say("Library could not load: " + (error.message || "Unknown error"), "error"); }
  }
  el("referenceLibraryOpenTop")?.addEventListener("click", () => { panel.hidden = false; panel.scrollIntoView({ behavior: "smooth", block: "start" }); });
  el("referenceLibraryClose")?.addEventListener("click", () => { panel.hidden = true; });
  el("sharedReferenceLibraryOpenTop")?.addEventListener("click", () => { sharedPanel.hidden = false; sharedPanel.scrollIntoView({ behavior: "smooth", block: "start" }); });
  el("sharedReferenceLibraryClose")?.addEventListener("click", () => { sharedPanel.hidden = true; });
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


// Company-wide Owner/Admin reference library. This is separate from private
// account libraries: all authenticated accounts can read; only Owner/Admin
// workspace members can create, rename or delete shared content.
const sharedPanel = document.getElementById("sharedReferenceLibraryPanel");
if (sharedPanel) {
  const sharedList = document.getElementById("sharedReferenceLibraryList");
  const sharedStatus = document.getElementById("sharedReferenceLibraryStatus");
  const sharedSearch = document.getElementById("sharedReferenceLibrarySearch");
  const sharedFolderLabel = document.getElementById("sharedReferenceLibraryCurrentFolder");
  const sharedAdminTools = document.getElementById("sharedReferenceLibraryAdminTools");
  const sharedUploadInput = document.getElementById("sharedReferenceLibraryUpload");
  const SHARED_BUCKET = "shared-reference-library";
  const SHARED_MAX_BYTES = 20 * 1024 * 1024;
  let sharedSession = null;
  let sharedCanManage = false;
  let sharedCurrentFolder = "";
  let sharedItems = [];

  function sharedSay(message, kind = "info") {
    sharedStatus.textContent = message;
    sharedStatus.dataset.kind = kind;
  }
  function sharedSafeName(value) {
    return String(value || "document").replace(/[\/]/g, "-")
      .replace(/[^a-zA-Z0-9._() -]/g, "_").slice(0, 140);
  }
  function sharedParent(path) {
    const parts = String(path || "").split("/").filter(Boolean);
    parts.pop();
    return parts.join("/");
  }
  function sharedBytes(bytes) {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const n = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3);
    return (bytes / Math.pow(1024, n)).toFixed(n ? 1 : 0) + " " + units[n];
  }
  function sharedButton(label, action, className = "secondary smallbtn") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.addEventListener("click", action);
    return button;
  }
  async function sharedRefresh() {
    if (!sharedSession?.user?.id) return;
    const { data, error } = await supabase.from("shared_reference_library_items")
      .select("id,item_type,original_name,folder_path,mime_type,file_size,storage_path,created_by,created_at,updated_at")
      .order("item_type", { ascending: true }).order("original_name", { ascending: true });
    if (error) throw error;
    sharedItems = data || [];
    sharedRender();
  }
  function sharedRender() {
    if (!sharedSession?.user?.id) return;
    sharedFolderLabel.textContent = sharedCurrentFolder
      ? " / " + sharedCurrentFolder.split("/").join(" / ")
      : " / All shared references";
    sharedList.replaceChildren();
    sharedList.classList.toggle("shared-member-list", !sharedCanManage);
    const items = sharedItems.filter(item => item.folder_path === sharedCurrentFolder)
      .filter(item => !sharedSearch.value || item.original_name.toLowerCase().includes(sharedSearch.value.toLowerCase()));
    if (sharedCurrentFolder) {
      const backRow = document.createElement("div");
      backRow.className = "reference-library-row";
      backRow.append(sharedButton("← Back", () => {
        sharedCurrentFolder = sharedParent(sharedCurrentFolder);
        sharedRender();
      }));
      sharedList.append(backRow);
    }
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = sharedCanManage
        ? "No shared references here yet. Add a folder or upload a file."
        : "No shared references in this folder yet.";
      sharedList.append(empty);
      return;
    }
    for (const item of items) {
      if (!sharedCanManage) {
        const memberRow = document.createElement("div");
        memberRow.className = "shared-member-item";
        const tile = sharedButton(item.original_name, () => {
          if (item.item_type === "folder") {
            sharedCurrentFolder = [sharedCurrentFolder, item.original_name].filter(Boolean).join("/");
            sharedRender();
          } else {
            sharedOpen(item);
          }
        }, "shared-member-tile");
        if (item.item_type === "folder") tile.textContent = "📁  " + item.original_name;
        memberRow.append(tile);
        sharedList.append(memberRow);
        continue;
      }
      // Owner/Admin management layout remains unchanged.
      const row = document.createElement("div");
      row.className = "reference-library-row";
      const details = document.createElement("div");
      details.className = "reference-library-details";
      const name = document.createElement("strong");
      name.textContent = (item.item_type === "folder" ? "📁 " : item.mime_type === "application/pdf" ? "📕 " : "📄 ") + item.original_name;
      const meta = document.createElement("small");
      meta.textContent = item.item_type === "folder" ? "Shared folder" : sharedBytes(item.file_size) + " · Available to all accounts";
      details.append(name, meta);
      const actions = document.createElement("div");
      actions.className = "reference-library-actions";
      if (item.item_type === "folder") {
        actions.append(sharedButton("Open", () => {
          sharedCurrentFolder = [sharedCurrentFolder, item.original_name].filter(Boolean).join("/");
          sharedRender();
        }));
      } else {
        actions.append(sharedButton("View", () => sharedOpen(item)));
        actions.append(sharedButton("Download", () => sharedDownload(item)));
      }
      actions.append(sharedButton("Rename", () => sharedRename(item)));
      actions.append(sharedButton("Delete", () => sharedDelete(item), "danger smallbtn"));
      row.append(details, actions);
      sharedList.append(row);
    }
  }
  async function sharedAddFolder() {
    const name = prompt("New shared folder name");
    if (!name || !name.trim()) return;
    const clean = sharedSafeName(name.trim());
    if (clean.includes("/")) throw new Error("Folder names cannot contain a slash.");
    if (sharedItems.some(item => item.item_type === "folder" && item.folder_path === sharedCurrentFolder && item.original_name.toLowerCase() === clean.toLowerCase())) {
      throw new Error("That shared folder already exists.");
    }
    const { error } = await supabase.from("shared_reference_library_items").insert({
      id: crypto.randomUUID(), item_type: "folder", original_name: clean,
      folder_path: sharedCurrentFolder, mime_type: "", file_size: 0,
      storage_path: null, created_by: sharedSession.user.id
    });
    if (error) throw error;
    sharedSay("Shared folder created. All signed-in accounts can see it.", "success");
    await sharedRefresh();
  }
  async function sharedUpload(file) {
    if (!file) return;
    if (file.size > SHARED_MAX_BYTES) throw new Error("This file is over the 20 MB limit.");
    const id = crypto.randomUUID();
    const path = "shared/" + id + "/" + sharedSafeName(file.name);
    const { error: uploadError } = await supabase.storage.from(SHARED_BUCKET).upload(path, file, {
      contentType: file.type || "application/octet-stream", upsert: false
    });
    if (uploadError) throw uploadError;
    const { error } = await supabase.from("shared_reference_library_items").insert({
      id, item_type: "file", original_name: file.name, folder_path: sharedCurrentFolder,
      mime_type: file.type || "application/octet-stream", file_size: file.size,
      storage_path: path, created_by: sharedSession.user.id
    });
    if (error) {
      await supabase.storage.from(SHARED_BUCKET).remove([path]);
      throw error;
    }
    sharedSay("Shared file uploaded. It is now visible to every signed-in account.", "success");
    await sharedRefresh();
  }
  async function sharedGetBlob(item) {
    const { data, error } = await supabase.storage.from(SHARED_BUCKET).download(item.storage_path);
    if (error) throw error;
    return data;
  }
  const sharedViewer = document.getElementById("sharedReferenceViewer");
  const sharedViewerFrame = document.getElementById("sharedReferenceViewerFrame");
  const sharedPdfPages = document.getElementById("sharedReferencePdfPages");
  const sharedImageWrap = document.getElementById("sharedReferenceImageWrap");
  const sharedImage = document.getElementById("sharedReferenceImage");
  const sharedViewerTitle = document.getElementById("sharedReferenceViewerTitle");
  let sharedPdfJsPromise = null;
  async function sharedRenderPdf(blob) {
    if (!sharedPdfJsPromise) sharedPdfJsPromise = import("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs").then(pdfjs => {
      pdfjs.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs";
      return pdfjs;
    });
    const pdfjs = await sharedPdfJsPromise;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const pdf = await pdfjs.getDocument({ data: bytes }).promise;
    sharedPdfPages.replaceChildren();
    const availableWidth = Math.max(240, sharedPdfPages.clientWidth - 20);
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
      const page = await pdf.getPage(pageNo);
      const base = page.getViewport({ scale: 1 });
      const scale = availableWidth / base.width;
      const viewport = page.getViewport({ scale });
      const outputScale = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = document.createElement("canvas");
      canvas.className = "shared-reference-pdf-page";
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = Math.floor(viewport.width) + "px";
      canvas.style.height = Math.floor(viewport.height) + "px";
      sharedPdfPages.append(canvas);
      const context = canvas.getContext("2d", { alpha: false });
      await page.render({ canvasContext: context, viewport, transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0] }).promise;
    }
  }
  const sharedViewerNotice = document.getElementById("sharedReferenceViewerNotice");
  let sharedViewerUrl = null;
  function sharedCloseViewer() {
    sharedViewer.hidden = true;
    sharedViewerFrame.removeAttribute("src");
    sharedViewerFrame.hidden = false;
    sharedPdfPages.hidden = true;
    sharedPdfPages.replaceChildren();
    sharedImageWrap.hidden = true;
    sharedImage.removeAttribute("src");
    if (sharedViewerUrl) URL.revokeObjectURL(sharedViewerUrl);
    sharedViewerUrl = null;
  }
  document.getElementById("sharedReferenceViewerClose").addEventListener("click", sharedCloseViewer);
  sharedViewer.addEventListener("click", event => { if (event.target === sharedViewer) sharedCloseViewer(); });
  document.addEventListener("keydown", event => { if (event.key === "Escape" && !sharedViewer.hidden) sharedCloseViewer(); });
  async function sharedOpen(item) {
    try {
      sharedSay("Opening " + item.original_name + "…");
      const blob = await sharedGetBlob(item);
      // Ordinary member accounts get an in-app preview with a clear Close control.
      // Owner/Admins retain the existing separate-tab behaviour.
      if (!sharedCanManage) {
        if (sharedViewerUrl) URL.revokeObjectURL(sharedViewerUrl);
        sharedViewerUrl = URL.createObjectURL(blob);
        sharedViewerTitle.textContent = item.original_name;
        const canPreview = /^application\/pdf$|^image\/|^text\//i.test(item.mime_type || "");
        sharedViewerNotice.hidden = canPreview;
        sharedViewerNotice.textContent = canPreview
          ? ""
          : "This file type may not preview in your browser. Close this preview and ask an Owner/Admin for an alternative format.";
        const isPdf = /^application\/pdf$/i.test(item.mime_type || "") || /\.pdf$/i.test(item.original_name || "");
        sharedViewer.hidden = false;
        if (isPdf) {
          // Render every PDF page ourselves at the available phone width.
          // This avoids Android's built-in PDF viewer ignoring fit-to-page hints.
          sharedViewerFrame.hidden = true;
          sharedImageWrap.hidden = true;
          sharedImage.removeAttribute("src");
          sharedPdfPages.hidden = false;
          await sharedRenderPdf(blob);
        } else if (/^image\//i.test(item.mime_type || "") || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(item.original_name || "")) {
          // Use a contained image element instead of the browser's native image
          // document, which can open at natural size and crop on mobile screens.
          sharedViewerFrame.hidden = true;
          sharedPdfPages.hidden = true;
          sharedPdfPages.replaceChildren();
          sharedImageWrap.hidden = false;
          sharedImage.src = sharedViewerUrl;
          sharedImage.alt = item.original_name || "Reference image";
        } else {
          sharedPdfPages.hidden = true;
          sharedPdfPages.replaceChildren();
          sharedImageWrap.hidden = true;
          sharedImage.removeAttribute("src");
          sharedViewerFrame.hidden = false;
          sharedViewerFrame.src = canPreview ? sharedViewerUrl : "about:blank";
        }
        sharedSay("Reference opened.", "success");
        return;
      }
      const url = URL.createObjectURL(blob);
      const opened = window.open(url, "_blank", "noopener");
      if (!opened) {
        const link = document.createElement("a");
        link.href = url; link.download = item.original_name; link.click();
      }
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
      sharedSay("Reference opened.", "success");
    } catch (error) { sharedSay("Could not open file: " + (error.message || "Unknown error"), "error"); }
  }
  async function sharedDownload(item) {
    try {
      sharedSay("Preparing download…");
      const blob = await sharedGetBlob(item);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = item.original_name;
      document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
      sharedSay("Download started.", "success");
    } catch (error) { sharedSay("Download failed: " + (error.message || "Unknown error"), "error"); }
  }
  async function sharedRename(item) {
    const name = prompt("New shared name", item.original_name);
    if (!name || !name.trim() || name.trim() === item.original_name) return;
    const clean = sharedSafeName(name.trim());
    try {
      const { error } = await supabase.from("shared_reference_library_items")
        .update({ original_name: clean, updated_at: new Date().toISOString() }).eq("id", item.id);
      if (error) throw error;
      sharedSay("Shared reference renamed.", "success");
      await sharedRefresh();
    } catch (error) { sharedSay("Rename failed: " + (error.message || "Unknown error"), "error"); }
  }
  async function sharedDelete(item) {
    if (!confirm("Delete this shared " + item.item_type + " for every account? This cannot be undone.")) return;
    try {
      if (item.item_type === "folder") {
        const folderPath = [item.folder_path, item.original_name].filter(Boolean).join("/");
        if (sharedItems.some(child => child.id !== item.id && child.folder_path === folderPath)) {
          throw new Error("This folder is not empty. Delete or move its contents first.");
        }
      } else if (item.storage_path) {
        const { error: storageError } = await supabase.storage.from(SHARED_BUCKET).remove([item.storage_path]);
        if (storageError) throw storageError;
      }
      const { error } = await supabase.from("shared_reference_library_items").delete().eq("id", item.id);
      if (error) throw error;
      sharedSay("Shared reference deleted for all accounts.", "success");
      await sharedRefresh();
    } catch (error) { sharedSay("Delete failed: " + (error.message || "Unknown error"), "error"); }
  }
  async function sharedLoadSession(nextSession) {
    sharedSession = nextSession;
    if (!nextSession?.user?.id) {
      sharedCanManage = false;
      sharedItems = [];
      sharedAdminTools.hidden = true;
      sharedList.replaceChildren();
      sharedSay("Sign in to view the Owner/Admin shared library.");
      return;
    }
    try {
      const { data: memberships, error } = await supabase.from("workspace_members")
        .select("workspace_id,role").eq("user_id", nextSession.user.id);
      if (error) throw error;
      const workspaceIds = [...new Set((memberships || []).map(row => row.workspace_id))];
      let workspaces = [];
      if (workspaceIds.length) {
        const { data, error: workspaceError } = await supabase.from("workspaces")
          .select("id,created_by").in("id", workspaceIds);
        if (workspaceError) throw workspaceError;
        workspaces = data || [];
      }
      // Do not mistake an account's automatically-created personal workspace
      // (where it is OWNER) for Owner status in the shared company workspace.
      // The company owner is the creator/owner; company admins are admins in
      // a workspace created by someone else.
      sharedCanManage = (memberships || []).some(row => {
        const workspace = workspaces.find(item => item.id === row.workspace_id);
        const role = String(row.role || "").toLowerCase();
        return !!workspace && (
          (role === "owner" && workspace.created_by === nextSession.user.id) ||
          (role === "admin" && workspace.created_by !== nextSession.user.id)
        );
      });
      sharedAdminTools.hidden = !sharedCanManage;
      sharedSay(sharedCanManage
        ? "You can manage this shared library as an Owner/Admin. Changes are visible to every account."
        : "View-only access. You can open references but cannot edit or delete them.", "success");
      await sharedRefresh();
    } catch (error) {
      sharedAdminTools.hidden = true;
      sharedSay("Shared library could not load: " + (error.message || "Unknown error"), "error");
    }
  }
  document.getElementById("sharedReferenceLibraryAddFolder").addEventListener("click", () => {
    if (sharedCanManage) sharedAddFolder().catch(error => sharedSay(error.message, "error"));
  });
  document.getElementById("sharedReferenceLibraryUploadButton").addEventListener("click", () => {
    if (sharedCanManage) sharedUploadInput.click();
  });
  sharedUploadInput.addEventListener("change", async () => {
    const file = sharedUploadInput.files?.[0];
    sharedUploadInput.value = "";
    if (!file || !sharedCanManage) return;
    try { await sharedUpload(file); } catch (error) { sharedSay("Upload failed: " + (error.message || "Unknown error"), "error"); }
  });
  sharedSearch.addEventListener("input", sharedRender);
  document.getElementById("sharedReferenceLibraryHome").addEventListener("click", () => {
    sharedCurrentFolder = ""; sharedRender();
  });
  document.getElementById("sharedReferenceLibraryRefresh").addEventListener("click", () => {
    sharedRefresh().then(() => sharedSay("Shared references refreshed.", "success"))
      .catch(error => sharedSay(error.message, "error"));
  });
  supabase.auth.onAuthStateChange((_event, nextSession) => { void sharedLoadSession(nextSession); });
  const { data: sharedInitial } = await supabase.auth.getSession();
  await sharedLoadSession(sharedInitial.session);
}

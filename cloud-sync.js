import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./supabase-config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

const STOCK_KEY = "van-stock-pro-items-v1";
const DIRTY_KEY = "van-stock-pro-cloud-dirty-v1";
const BASELINE_KEY = "van-stock-pro-cloud-baseline-v1";
const POLL_INTERVAL_MS = 15000;
const CLOUD_FIELDS = [
  "name", "sku", "barcode", "category", "qty", "min_qty",
  "max_qty", "location", "supplier", "supplier_url", "notes"
];

let activeWorkspace = null;
let activeUserId = null;
let realtimeChannel = null;
let pollTimer = null;
let syncQueue = Promise.resolve();
let localStockDirty = false;
let pendingLocalStockPushes = 0;
let dirtySequence = 0;
let memoryDirtyIds = new Set();
const deletingIds = new Set();
const diagnostics = {
  lastAction: "Not started",
  lastError: "",
  lastSuccessAt: null,
  lastPushAt: null,
  lastPullAt: null,
  lastRemoteCount: null,
  lastLocalCount: null
};

if (sessionStorage.getItem("van-stock-pro-cloud-reloaded") === "1") {
  sessionStorage.removeItem("van-stock-pro-cloud-reloaded");
}

function workspaceTag() {
  return activeWorkspace ? String(activeWorkspace).slice(-8) : "not ready";
}

function say(message, kind = "info") {
  const element = document.getElementById("cloudMessage");
  if (element) {
    element.textContent = message;
    element.dataset.kind = kind;
  }
}

function errorText(error) {
  return [
    error?.message || String(error || "Unknown cloud error"),
    error?.code ? "code " + error.code : "",
    error?.details || "",
    error?.hint || ""
  ].filter(Boolean).join(" · ");
}

function readLocalStock() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STOCK_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalStock(items) {
  const serialized = JSON.stringify(items);
  localStorage.setItem(STOCK_KEY, serialized);
  if (localStorage.getItem(STOCK_KEY) !== serialized) {
    throw new Error("Local stock could not be verified after saving.");
  }
}

function readDirtyState() {
  try {
    const raw = localStorage.getItem(DIRTY_KEY);
    if (!raw) return { marker: null, ids: [] };
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return {
          marker: String(parsed.marker || raw),
          ids: Array.isArray(parsed.ids) ? parsed.ids.map(String) : []
        };
      }
    } catch {
      // A legacy marker is still treated as pending, but has no item IDs.
    }
    return { marker: raw, ids: [] };
  } catch {
    return { marker: localStockDirty ? "memory-pending" : null, ids: [...memoryDirtyIds] };
  }
}

function hasPendingLocalStock() {
  return localStockDirty || !!readDirtyState().marker || pendingLocalStockPushes > 0;
}

function markLocalStockDirty(event) {
  const changedIds = Array.isArray(event?.detail?.changedIds)
    ? event.detail.changedIds.map(String)
    : [];
  if (!changedIds.length) return null;

  localStockDirty = true;
  changedIds.forEach(id => memoryDirtyIds.add(id));
  dirtySequence++;
  const marker = String(Date.now()) + "-" + String(dirtySequence);
  const previous = readDirtyState();
  const ids = [...new Set([...previous.ids, ...changedIds])];
  try {
    localStorage.setItem(DIRTY_KEY, JSON.stringify({ marker, ids }));
  } catch (error) {
    diagnostics.lastError = "Could not persist pending-sync marker: " + errorText(error);
    say("Stock is saved on this device, but the pending cloud marker could not be stored. Keep this page open and check the connection.", "warning");
  }
  diagnostics.lastAction = "Local stock save detected";
  diagnostics.lastLocalCount = readLocalStock().length;
  return marker;
}

function toCloudRow(item, workspaceId) {
  return {
    workspace_id: workspaceId,
    legacy_id: String(item.id),
    name: String(item.name || "Unnamed item"),
    sku: String(item.sku || ""),
    barcode: String(item.barcode || ""),
    category: String(item.category || ""),
    qty: Number(item.qty || 0),
    min_qty: Number(item.minQty || 0),
    max_qty: item.maxQty === "" || item.maxQty == null ? null : Number(item.maxQty),
    location: String(item.location || ""),
    supplier: String(item.supplier || ""),
    supplier_url: String(item.supplierUrl || ""),
    notes: String(item.notes || "")
  };
}

function fromCloudRow(row, previousItem) {
  return {
    id: String(row.legacy_id),
    name: row.name,
    sku: row.sku || "",
    barcode: row.barcode || "",
    category: row.category || "",
    qty: Number(row.qty || 0),
    minQty: Number(row.min_qty || 0),
    maxQty: row.max_qty == null ? null : Number(row.max_qty),
    location: row.location || "",
    supplier: row.supplier || "",
    supplierUrl: row.supplier_url || "",
    notes: row.notes || "",
    // Item photos remain on the device until cloud photo storage is implemented.
    photo: previousItem?.photo || ""
  };
}

function sameCloudValue(field, local, remote) {
  if (field === "qty" || field === "min_qty") {
    return Number(local || 0) === Number(remote || 0);
  }
  if (field === "max_qty") {
    const a = local == null || local === "" ? null : Number(local);
    const b = remote == null || remote === "" ? null : Number(remote);
    return a === b;
  }
  return String(local ?? "") === String(remote ?? "");
}

function sameCloudRow(a, b) {
  return CLOUD_FIELDS.every(field => sameCloudValue(field, a?.[field], b?.[field]));
}

function readBaseline() {
  try {
    const parsed = JSON.parse(localStorage.getItem(BASELINE_KEY) || "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeBaseline(items) {
  const snapshot = {};
  for (const item of items) {
    snapshot[String(item.id)] = toCloudRow(item, activeWorkspace);
  }
  const serialized = JSON.stringify(snapshot);
  localStorage.setItem(BASELINE_KEY, serialized);
  if (localStorage.getItem(BASELINE_KEY) !== serialized) {
    throw new Error("The last-synced comparison snapshot could not be verified.");
  }
}

function buildMergePlan(localItems, remoteRows, forcedLocalIds) {
  const baseline = readBaseline();
  const activeRows = remoteRows.filter(row => !row.deleted_at);
  const remoteById = new Map(activeRows.map(row => [String(row.legacy_id), row]));
  const localById = new Map(localItems.map(item => [String(item.id), item]));
  const mergedItems = [];
  const conflicts = [];
  const localWins = [];
  const remoteWins = [];

  for (const item of localItems) {
    const id = String(item.id);
    const remote = remoteById.get(id);
    if (!remote) {
      mergedItems.push(item);
      localWins.push(id);
      continue;
    }

    const localRow = toCloudRow(item, activeWorkspace);
    if (sameCloudRow(localRow, remote)) {
      mergedItems.push(fromCloudRow(remote, item));
      continue;
    }

    const base = baseline?.[id];
    if (!base) {
      if (forcedLocalIds.has(id)) {
        mergedItems.push(item);
        localWins.push(id);
      } else {
        conflicts.push({ id, name: String(item.name || id), reason: "No previous sync baseline" });
      }
      continue;
    }

    const localChanged = !sameCloudRow(localRow, base);
    const remoteChanged = !sameCloudRow(remote, base);
    if (localChanged && remoteChanged) {
      conflicts.push({ id, name: String(item.name || id), reason: "Both device and cloud changed" });
    } else if (localChanged) {
      mergedItems.push(item);
      localWins.push(id);
    } else {
      mergedItems.push(fromCloudRow(remote, item));
      remoteWins.push(id);
    }
  }

  for (const row of activeRows) {
    const id = String(row.legacy_id);
    if (!localById.has(id)) {
      mergedItems.push(fromCloudRow(row, null));
      remoteWins.push(id);
    }
  }

  return { mergedItems, conflicts, localWins, remoteWins };
}

function requestReloadOnce() {
  if (sessionStorage.getItem("van-stock-pro-cloud-reloaded") === "1") return;
  sessionStorage.setItem("van-stock-pro-cloud-reloaded", "1");
  location.reload();
}

async function fetchActiveRows() {
  const result = await supabase
    .from("stock_items")
    .select("legacy_id,name,sku,barcode,category,qty,min_qty,max_qty,location,supplier,supplier_url,notes,deleted_at")
    .eq("workspace_id", activeWorkspace);
  if (result.error) throw new Error("Supabase stock download failed: " + errorText(result.error));
  return result.data || [];
}

async function verifyCloudRows(items, context) {
  const result = await supabase
    .from("stock_items")
    .select("legacy_id,name,sku,barcode,category,qty,min_qty,max_qty,location,supplier,supplier_url,notes")
    .eq("workspace_id", activeWorkspace)
    .is("deleted_at", null);
  if (result.error) throw new Error("Supabase " + context + " verification query failed: " + errorText(result.error));

  const verifiedById = new Map((result.data || []).map(row => [String(row.legacy_id), row]));
  const mismatches = [];
  for (const item of items) {
    const expected = toCloudRow(item, activeWorkspace);
    const saved = verifiedById.get(String(item.id));
    if (!saved || !sameCloudRow(expected, saved)) mismatches.push(String(item.name || item.id));
  }
  if (mismatches.length) {
    throw new Error(
      "Supabase " + context + " verification failed for " + mismatches.length +
      " item(s): " + mismatches.slice(0, 3).join(", ") + ". Local stock was retained."
    );
  }
  diagnostics.lastRemoteCount = (result.data || []).length;
  return result.data || [];
}

function clearDirtyMarkerIfUnchanged(markerAtStart) {
  const current = readDirtyState();
  if (markerAtStart && current.marker === markerAtStart) {
    try {
      localStorage.removeItem(DIRTY_KEY);
      localStockDirty = false;
      memoryDirtyIds.clear();
      return true;
    } catch (error) {
      diagnostics.lastError = "Cloud upload succeeded but the pending marker could not be cleared: " + errorText(error);
      return false;
    }
  }
  if (!current.marker) {
    localStockDirty = false;
    memoryDirtyIds.clear();
    return true;
  }
  localStockDirty = true;
  return false;
}

async function performStockSync(mode) {
  if (!activeWorkspace) return;

  const dirtyAtStart = readDirtyState();
  const markerAtStart = dirtyAtStart.marker;
  const forcedLocalIds = new Set([...dirtyAtStart.ids, ...memoryDirtyIds]);
  let localItems = readLocalStock();
  diagnostics.lastLocalCount = localItems.length;

  if (mode === "reconcile" && hasPendingLocalStock()) {
    diagnostics.lastAction = "Pull deferred while a local upload is pending";
    return;
  }

  const remoteRows = await fetchActiveRows();
  if (mode === "reconcile" && hasPendingLocalStock()) {
    diagnostics.lastAction = "Pull deferred after a local save";
    return;
  }

  const deletedIds = new Set(remoteRows.filter(row => row.deleted_at).map(row => String(row.legacy_id)));
  localItems = localItems.filter(item => !deletedIds.has(String(item.id)));

  const plan = buildMergePlan(localItems, remoteRows, forcedLocalIds);
  if (plan.conflicts.length) {
    diagnostics.lastAction = "Local/cloud conflict; no automatic overwrite";
    diagnostics.lastError = plan.conflicts.length + " item(s) differ on both sides or have no safe baseline";
    const sample = plan.conflicts.slice(0, 3).map(item => item.name).join(", ");
    say(
      "Sync paused: " + plan.conflicts.length + " item(s) need conflict checking (" + sample +
      "). No stock was changed. Workspace …" + workspaceTag() +
      ". The app will not guess which quantity is correct.",
      "warning"
    );
    return;
  }

  const mergedItems = plan.mergedItems;
  const payload = mergedItems.map(item => toCloudRow(item, activeWorkspace));
  if (mode === "push" && payload.length === 0) {
    diagnostics.lastAction = "Empty local stock; upload skipped";
    say("Cloud upload skipped because this device has no stock items. No cloud items were deleted. Workspace …" + workspaceTag(), "warning");
    return;
  }

  for (let start = 0; start < payload.length; start += 100) {
    const result = await supabase
      .from("stock_items")
      .upsert(payload.slice(start, start + 100), { onConflict: "workspace_id,legacy_id" });
    if (result.error) throw new Error("Supabase stock upload failed: " + errorText(result.error));
  }

  const verifiedRows = await verifyCloudRows(mergedItems, mode === "push" ? "upload" : "reconciliation");

  // If another save arrived while this request was running, do not write this
  // older snapshot or baseline over it. Its queued push will run next.
  const currentDirty = readDirtyState();
  if (hasPendingLocalStock() && currentDirty.marker !== markerAtStart) {
    diagnostics.lastAction = "A newer local save is waiting to upload";
    return;
  }
  if (mode === "reconcile" && hasPendingLocalStock()) return;

  const previous = JSON.stringify(readLocalStock());
  const next = JSON.stringify(mergedItems);
  if (previous !== next) {
    writeLocalStock(mergedItems);
  }
  writeBaseline(mergedItems);

  if (mode === "push") {
    clearDirtyMarkerIfUnchanged(markerAtStart);
    diagnostics.lastPushAt = new Date().toISOString();
  } else {
    diagnostics.lastPullAt = new Date().toISOString();
  }

  diagnostics.lastAction = plan.localWins.length
    ? "Local changes merged and uploaded"
    : plan.remoteWins.length
      ? "Cloud changes downloaded and verified"
      : "Local and cloud stock match";
  diagnostics.lastSuccessAt = new Date().toISOString();
  diagnostics.lastError = "";
  diagnostics.lastRemoteCount = verifiedRows.length;

  say(
    "Cloud sync verified: " + mergedItems.length + " active item(s). Workspace …" +
    workspaceTag() + ". Uploads and downloads checked against Supabase." +
    " Photos and movement/job/order history remain device-local.",
    "success"
  );

  if (previous !== next) requestReloadOnce();
}

function syncStock(mode = "reconcile") {
  const task = syncQueue.then(() => performStockSync(mode));
  syncQueue = task.catch(error => {
    const message = errorText(error);
    diagnostics.lastAction = "Cloud sync failed";
    diagnostics.lastError = message;
    say("Cloud stock sync failed: " + message + ". Local stock was kept. Workspace …" + workspaceTag(), "warning");
  });
  return task;
}

function stopCloudListeners() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (realtimeChannel) {
    supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
}

function startCloudListeners(workspaceId) {
  stopCloudListeners();

  realtimeChannel = supabase
    .channel("van-stock-pro-stock-" + workspaceId)
    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "stock_items",
      filter: "workspace_id=eq." + workspaceId
    }, () => {
      syncStock("reconcile").catch(() => {});
    })
    .subscribe(status => {
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        diagnostics.lastError = "Realtime channel " + status;
        say("Cloud sign-in is active, but live updates are unavailable. The 15-second stock check remains enabled. Workspace …" + workspaceTag(), "warning");
      }
    });

  pollTimer = window.setInterval(() => {
    if (activeWorkspace && document.visibilityState === "visible") {
      syncStock("reconcile").catch(() => {});
    }
  }, POLL_INTERVAL_MS);
}

async function getWorkspace() {
  const result = await supabase.rpc("ensure_default_workspace");
  if (result.error) throw new Error("Workspace lookup failed: " + errorText(result.error));

  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  if (!row?.result_workspace_id || !["owner", "admin", "member"].includes(row.result_role)) {
    throw new Error("No usable workspace membership was returned.");
  }

  if (activeWorkspace !== row.result_workspace_id) {
    activeWorkspace = row.result_workspace_id;
    startCloudListeners(activeWorkspace);
  }
  diagnostics.lastAction = "Workspace connected";
  return activeWorkspace;
}

window.vanStockProCloudDiagnostics = function () {
  const dirty = readDirtyState();
  return {
    userIdSuffix: activeUserId ? String(activeUserId).slice(-8) : null,
    workspaceId: activeWorkspace,
    workspaceSuffix: activeWorkspace ? String(activeWorkspace).slice(-8) : null,
    localItemCount: readLocalStock().length,
    pendingLocalPush: hasPendingLocalStock(),
    pendingItemIds: dirty.ids,
    pendingPushCount: pendingLocalStockPushes,
    lastAction: diagnostics.lastAction,
    lastError: diagnostics.lastError,
    lastSuccessAt: diagnostics.lastSuccessAt,
    lastPushAt: diagnostics.lastPushAt,
    lastPullAt: diagnostics.lastPullAt,
    lastRemoteCount: diagnostics.lastRemoteCount
  };
};

window.vanStockProDeleteItem = async function deleteCloudStockItem(legacyId) {
  const id = String(legacyId);
  if (!activeWorkspace) throw new Error("Cloud workspace is not ready. Sign in again, then retry.");
  if (deletingIds.has(id)) throw new Error("This item is already being deleted.");

  deletingIds.add(id);
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15000);
  try {
    const result = await supabase
      .from("stock_items")
      .update({ deleted_at: new Date().toISOString() })
      .eq("workspace_id", activeWorkspace)
      .eq("legacy_id", id)
      .is("deleted_at", null)
      .select("legacy_id")
      .abortSignal(controller.signal);

    if (result.error) {
      if (result.error.name === "AbortError" || /abort/i.test(result.error.message || "")) {
        throw new Error("Supabase did not respond within 15 seconds. Check your connection and try again.");
      }
      throw new Error("Supabase delete failed: " + errorText(result.error));
    }
    if (!result.data || result.data.length !== 1) {
      throw new Error("Supabase matched no active item. Check that this item exists in your signed-in workspace.");
    }

    const remaining = readLocalStock().filter(item => String(item.id) !== id);
    writeLocalStock(remaining);
    const baseline = readBaseline();
    if (baseline) {
      delete baseline[id];
      localStorage.setItem(BASELINE_KEY, JSON.stringify(baseline));
    }
    say("Item deleted from shared cloud stock. Other devices will remove it during their next update. Workspace …" + workspaceTag(), "success");
    return true;
  } finally {
    window.clearTimeout(timeout);
    deletingIds.delete(id);
  }
};

window.addEventListener("van-stock-pro:stock-saved", event => {
  const marker = markLocalStockDirty(event);
  if (!marker) return;
  if (!activeWorkspace) {
    say("Stock saved on this device. Cloud workspace is still starting; the upload is queued. Do not close this page yet.", "warning");
    return;
  }
  pendingLocalStockPushes++;
  diagnostics.lastAction = "Uploading local stock to Supabase";
  say("Local stock saved. Uploading to Supabase now… Workspace …" + workspaceTag(), "info");
  syncStock("push")
    .catch(() => {})
    .finally(() => {
      pendingLocalStockPushes = Math.max(0, pendingLocalStockPushes - 1);
      const current = readDirtyState();
      if (current.marker && current.marker !== marker) {
        syncStock("push").catch(() => {});
      }
    });
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && activeWorkspace) {
    syncStock("reconcile").catch(() => {});
  }
});

supabase.auth.onAuthStateChange((event, session) => {
  const userId = session?.user?.id || null;
  if (!userId) {
    activeUserId = null;
    activeWorkspace = null;
    localStockDirty = false;
    memoryDirtyIds.clear();
    stopCloudListeners();
    return;
  }

  if (userId !== activeUserId || event === "SIGNED_IN" || event === "INITIAL_SESSION") {
    activeUserId = userId;
    queueMicrotask(() => {
      getWorkspace()
        .then(() => syncStock(readDirtyState().marker ? "push" : "reconcile"))
        .catch(error => {
          const message = errorText(error);
          diagnostics.lastAction = "Workspace/sync startup failed";
          diagnostics.lastError = message;
          say("Signed in, but cloud stock sync could not start: " + message + ". Local stock remains available.", "warning");
        });
    });
  }
});

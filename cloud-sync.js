import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./supabase-config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

const STOCK_KEY = "van-stock-pro-items-v1";
const POLL_INTERVAL_MS = 15000;

let activeWorkspace = null;
let activeUserId = null;
let realtimeChannel = null;
let pollTimer = null;
let syncQueue = Promise.resolve();
let reloadAfterReconcile = false;
const deletingIds = new Set();

function say(message, kind = "info") {
  const element = document.getElementById("cloudMessage");
  if (element) {
    element.textContent = message;
    element.dataset.kind = kind;
  }
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

function requestReloadOnce() {
  if (sessionStorage.getItem("van-stock-pro-cloud-reloaded") === "1") return;
  sessionStorage.setItem("van-stock-pro-cloud-reloaded", "1");
  location.reload();
}

async function performStockSync(mode) {
  if (!activeWorkspace) return;

  let localItems = readLocalStock();
  if (mode === "push" && localItems.length === 0) return;

  let remoteRows = [];
  if (mode === "reconcile") {
    const result = await supabase
      .from("stock_items")
      .select("legacy_id,name,sku,barcode,category,qty,min_qty,max_qty,location,supplier,supplier_url,notes,deleted_at")
      .eq("workspace_id", activeWorkspace);
    if (result.error) throw result.error;
    remoteRows = result.data || [];
  } else {
    const result = await supabase
      .from("stock_items")
      .select("legacy_id")
      .eq("workspace_id", activeWorkspace)
      .not("deleted_at", "is", null);
    if (result.error) throw result.error;
    remoteRows = result.data || [];
  }

  const deletedIds = new Set(
    remoteRows.filter(row => row.deleted_at || mode === "push").map(row => String(row.legacy_id))
  );
  localItems = localItems.filter(item => !deletedIds.has(String(item.id)));

  let mergedItems = localItems;
  if (mode === "reconcile") {
    const activeRows = remoteRows.filter(row => !row.deleted_at);
    const remoteById = new Map(activeRows.map(row => [String(row.legacy_id), row]));

    mergedItems = localItems.map(item => {
      const remote = remoteById.get(String(item.id));
      return remote ? fromCloudRow(remote, item) : item;
    });

    const localIds = new Set(mergedItems.map(item => String(item.id)));
    for (const row of activeRows) {
      if (!localIds.has(String(row.legacy_id))) {
        mergedItems.push(fromCloudRow(row, null));
      }
    }
  }

  const payload = mergedItems.map(item => toCloudRow(item, activeWorkspace));
  for (let start = 0; start < payload.length; start += 100) {
    const result = await supabase
      .from("stock_items")
      .upsert(payload.slice(start, start + 100), { onConflict: "workspace_id,legacy_id" });
    if (result.error) throw result.error;
  }

  const verification = await supabase
    .from("stock_items")
    .select("legacy_id,name,qty,min_qty,max_qty")
    .eq("workspace_id", activeWorkspace)
    .is("deleted_at", null);
  if (verification.error) throw verification.error;

  const verifiedById = new Map(
    (verification.data || []).map(row => [String(row.legacy_id), row])
  );
  const mismatch = mergedItems.some(item => {
    const saved = verifiedById.get(String(item.id));
    return !saved ||
      saved.name !== String(item.name || "Unnamed item") ||
      Number(saved.qty) !== Number(item.qty || 0) ||
      Number(saved.min_qty) !== Number(item.minQty || 0) ||
      (item.maxQty == null || item.maxQty === ""
        ? saved.max_qty !== null
        : Number(saved.max_qty) !== Number(item.maxQty));
  });
  if (mismatch) {
    throw new Error("Cloud verification found a mismatch. The previous local stock was retained.");
  }

  const previous = JSON.stringify(readLocalStock());
  const next = JSON.stringify(mergedItems);
  if (previous !== next) {
    writeLocalStock(mergedItems);
    requestReloadOnce();
    return;
  }

  say(
    "Cloud stock sync verified: " + mergedItems.length +
    " active item(s). Deleted items remain deleted across devices. Photos and movement/job/order history are still device-local.",
    "success"
  );
}

function syncStock(mode = "reconcile") {
  // Serialize reads and writes so a background upload cannot race a deletion.
  const task = syncQueue.then(() => performStockSync(mode));
  syncQueue = task.catch(error => {
    say("Cloud stock sync needs attention: " + (error?.message || String(error)) + ". Local stock was kept.", "warning");
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
        say("Cloud sign-in is active, but live updates are unavailable. Background stock checks will continue.", "warning");
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
  if (result.error) throw result.error;

  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  if (!row?.result_workspace_id || !["owner", "admin", "member"].includes(row.result_role)) {
    throw new Error("No usable workspace membership was returned.");
  }

  if (activeWorkspace !== row.result_workspace_id) {
    activeWorkspace = row.result_workspace_id;
    startCloudListeners(activeWorkspace);
  }
  return activeWorkspace;
}

window.vanStockProDeleteItem = async function deleteCloudStockItem(legacyId) {
  const id = String(legacyId);
  if (!activeWorkspace) throw new Error("Sign in before deleting shared cloud stock.");
  if (deletingIds.has(id)) throw new Error("This item is already being deleted.");

  deletingIds.add(id);
  try {
    // Wait for any earlier upload/reconciliation before writing the tombstone.
    await syncQueue;
    const result = await supabase
      .from("stock_items")
      .update({ deleted_at: new Date().toISOString() })
      .eq("workspace_id", activeWorkspace)
      .eq("legacy_id", id)
      .is("deleted_at", null)
      .select("legacy_id");

    if (result.error) throw result.error;
    if (!result.data || result.data.length !== 1) {
      throw new Error("The cloud item was not found or was already deleted. Refresh stock and try again.");
    }

    const remaining = readLocalStock().filter(item => String(item.id) !== id);
    writeLocalStock(remaining);
    say("Item deleted from shared cloud stock. Other devices will remove it during their next update.", "success");
    return true;
  } finally {
    deletingIds.delete(id);
  }
};

window.addEventListener("van-stock-pro:stock-saved", () => {
  if (activeWorkspace) syncStock("push").catch(() => {});
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
    stopCloudListeners();
    return;
  }

  if (userId !== activeUserId || event === "SIGNED_IN" || event === "INITIAL_SESSION") {
    activeUserId = userId;
    queueMicrotask(() => {
      getWorkspace()
        .then(() => syncStock("reconcile"))
        .catch(error => {
          say("Signed in, but cloud stock sync could not start: " +
            (error?.message || String(error)) + ". Local stock remains available.", "warning");
        });
    });
  }
});

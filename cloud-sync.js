import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./supabase-config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});
const STOCK_KEY = "van-stock-pro-items-v1";
let activeWorkspace = null;
let syncing = false;
let queuedItems = null;
let queuedMode = null;
let lastSessionUser = null;

function say(text, kind = "info") {
  const el = document.getElementById("cloudMessage");
  if (el) { el.textContent = text; el.dataset.kind = kind; }
}
function readLocal() {
  try {
    const value = JSON.parse(localStorage.getItem(STOCK_KEY) || "[]");
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}
function toCloud(item, workspaceId) {
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
function fromCloud(row, old) {
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
    // Photos remain local until Storage upload/download is implemented.
    photo: old?.photo || ""
  };
}
async function getWorkspace() {
  const { data, error } = await supabase.rpc("ensure_default_workspace");
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.result_workspace_id || !["owner", "admin", "member"].includes(row.result_role)) {
    throw new Error("No usable workspace membership was returned.");
  }
  activeWorkspace = row.result_workspace_id;
  return activeWorkspace;
}
async function syncLocalStock(mode = "reconcile") {
  if (syncing) { queuedItems = readLocal(); return; }
  if (!activeWorkspace) return;
  syncing = true;
  try {
    let items = readLocal();
    if (!items.length) return;
    let merged = items;
    if (mode === "reconcile") {
      const { data: remoteRows, error: readError } = await supabase
        .from("stock_items")
        .select("legacy_id,name,sku,barcode,category,qty,min_qty,max_qty,location,supplier,supplier_url,notes")
        .eq("workspace_id", activeWorkspace);
      if (readError) throw readError;
      const remoteById = new Map((remoteRows || []).map(row => [String(row.legacy_id), row]));
      // On initial sign-in, cloud values win for matching IDs; local-only items remain.
      merged = items.map(item => {
        const remote = remoteById.get(String(item.id));
        return remote ? fromCloud(remote, item) : item;
      });
      for (const row of remoteRows || []) {
        if (!merged.some(item => String(item.id) === String(row.legacy_id))) merged.push(fromCloud(row, null));
      }
    }
    const cloudPayload = merged.map(item => toCloud(item, activeWorkspace));
    for (let i = 0; i < cloudPayload.length; i += 100) {
      const { error } = await supabase.from("stock_items").upsert(cloudPayload.slice(i, i + 100), { onConflict: "workspace_id,legacy_id" });
      if (error) throw error;
    }
    const verify = await supabase.from("stock_items").select("legacy_id,name,qty,min_qty,max_qty").eq("workspace_id", activeWorkspace);
    if (verify.error) throw verify.error;
    const verifiedById = new Map((verify.data || []).map(row => [String(row.legacy_id), row]));
    const mismatch = merged.some(item => {
      const row = verifiedById.get(String(item.id));
      return !row || row.name !== String(item.name || "Unnamed item") ||
        Number(row.qty) !== Number(item.qty || 0) || Number(row.min_qty) !== Number(item.minQty || 0);
    });
    if (mismatch) throw new Error("Cloud verification found a mismatch; local stock was retained.");
    const previous = JSON.stringify(readLocal());
    const next = JSON.stringify(merged);
    if (previous !== next) {
      localStorage.setItem(STOCK_KEY, next);
      // The stock UI is rendered from local storage at startup. Reload once after
      // cloud reconciliation so the screen reflects the merged stock list.
      if (!sessionStorage.getItem("van-stock-pro-cloud-reloaded")) {
        sessionStorage.setItem("van-stock-pro-cloud-reloaded", "1");
        location.reload();
        return;
      }
    }
    say("Cloud stock sync verified: " + merged.length + " items. Changes saved on this device are uploaded; cloud stock is reconciled at sign-in. Photos and movement/job/order history still require cloud integration.", "success");
  } catch (error) {
    say("Cloud stock sync needs attention: " + (error?.message || String(error)) + ". Local stock was kept.", "warning");
  } finally {
    syncing = false;
    if (queuedItems) {
      queuedItems = null;
      const nextMode = queuedMode || "push";
      queuedMode = null;
      queueMicrotask(() => syncLocalStock(nextMode));
    }
  }
}
window.addEventListener("van-stock-pro:stock-saved", event => {
  if (!activeWorkspace) return;
  // Stock saves remain local-first. Upload errors are reported without discarding local data.
  syncLocalStock("push");
});
supabase.auth.onAuthStateChange((event, session) => {
  const userId = session?.user?.id || null;
  if (!userId) { activeWorkspace = null; lastSessionUser = null; return; }
  if (userId !== lastSessionUser || event === "SIGNED_IN" || event === "INITIAL_SESSION") {
    lastSessionUser = userId;
    getWorkspace().then(syncLocalStock).catch(error =>
      say("Signed in, but cloud stock sync could not start: " + (error?.message || String(error)) + ". Local stock remains available.", "warning")
    );
  }
});

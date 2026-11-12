import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./supabase-config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});
const $ = (id) => document.getElementById(id);
const panel = $("cloudStatus");
const email = $("cloudEmail");
const password = $("cloudPassword");
const status = $("cloudMessage");
const sessionLabel = $("cloudSession");
const signInButton = $("cloudSignIn");
const signUpButton = $("cloudSignUp");
const signOutButton = $("cloudSignOut");
const setupButton = $("cloudWorkspace");
let currentSession = null;
let currentWorkspaceId = null;
let legacyImportAllowed = false;
const LEGACY_WORKSPACE_CUTOFF = "2026-11-12T00:00:00Z";
let stockSyncQueue = Promise.resolve();
const workspaceImportButton = document.createElement("button");
workspaceImportButton.type = "button";
workspaceImportButton.className = "secondary";
workspaceImportButton.textContent = "Import this device's existing stock into this workspace";
workspaceImportButton.hidden = true;
workspaceImportButton.style.marginTop = "10px";
status?.insertAdjacentElement("afterend", workspaceImportButton);

function toCloudRow(item, workspaceId = currentWorkspaceId) {
  return {
    workspace_id: workspaceId,
    legacy_id: String(item.id),
    name: String(item.name || "Unnamed item"),
    sku: String(item.sku || ""),
    barcode: String(item.barcode || ""),
    category: String(item.category || ""),
    qty: Number(item.qty) || 0,
    min_qty: Number(item.minQty) || 0,
    max_qty: item.maxQty === "" || item.maxQty == null ? null : Number(item.maxQty),
    location: String(item.location || ""),
    supplier: String(item.supplier || ""),
    supplier_url: String(item.supplierUrl || ""),
    notes: String(item.notes || "")
  };
}
function fromCloudRow(row) {
  return {
    id: String(row.legacy_id || row.id),
    name: row.name || "",
    sku: row.sku || "",
    barcode: row.barcode || "",
    category: row.category || "",
    qty: Number(row.qty) || 0,
    minQty: Number(row.min_qty) || 0,
    maxQty: row.max_qty == null ? null : Number(row.max_qty),
    location: row.location || "",
    supplier: row.supplier || "",
    supplierUrl: row.supplier_url || "",
    notes: row.notes || "",
    photo: ""
  };
}
async function loadWorkspaceStock() {
  if (!currentSession?.user) return;
  const loadingUserId = currentSession.user.id;
  const { data: memberships, error: memberError } = await supabase
    .from("workspace_members").select("workspace_id, role").eq("user_id", currentSession.user.id).limit(1);
  if (memberError) throw memberError;
  if (currentSession?.user?.id !== loadingUserId) return;
  if (!memberships?.length) {
    currentWorkspaceId = null;
    workspaceImportButton.hidden = true;
    message("Signed in, but no workspace membership was found. Use Set up workspace first.", "warning");
    return;
  }
  currentWorkspaceId = memberships[0].workspace_id;
  const { data: workspaceInfo, error: workspaceInfoError } = await supabase.from("workspaces")
    .select("created_at").eq("id", currentWorkspaceId).single();
  if (workspaceInfoError) throw workspaceInfoError;
  legacyImportAllowed = ["owner", "admin"].includes(memberships[0].role) &&
    !!workspaceInfo?.created_at && workspaceInfo.created_at < LEGACY_WORKSPACE_CUTOFF;
  const { data: rows, error } = await supabase.from("stock_items")
    .select("id, legacy_id, name, sku, barcode, category, qty, min_qty, max_qty, location, supplier, supplier_url, notes")
    .eq("workspace_id", currentWorkspaceId).order("name", { ascending: true });
  if (error) throw error;
  if (currentSession?.user?.id !== loadingUserId) return;
  const list = (rows || []).map(fromCloudRow);
  if (window.VSP_STOCK_BRIDGE) window.VSP_STOCK_BRIDGE.setItems(list);
  workspaceImportButton.hidden = list.length > 0 || !legacyImportAllowed;
  message(list.length
    ? "Workspace stock loaded securely: " + list.length + " item(s). Only stock in this workspace is shown."
    : "Your workspace is ready and currently has no stock. It is separate from the administrator's stock. Import existing device stock only if this is the administrator's device.", "success");
}
async function syncWorkspaceStock(items, workspaceId = currentWorkspaceId) {
  if (!workspaceId || !Array.isArray(items)) return;
  const rows = items.map(item => toCloudRow(item, workspaceId));
  if (rows.length) {
    const { error } = await supabase.from("stock_items").upsert(rows, { onConflict: "workspace_id,legacy_id" });
    if (error) throw error;
  }
  const { data: existing, error: readError } = await supabase.from("stock_items")
    .select("id, legacy_id").eq("workspace_id", workspaceId);
  if (readError) throw readError;
  const keep = new Set(items.map(item => String(item.id)));
  for (const row of (existing || [])) {
    if (!keep.has(String(row.legacy_id))) {
      const { error: deleteError } = await supabase.from("stock_items").delete()
        .eq("workspace_id", workspaceId).eq("id", row.id);
      if (deleteError) throw deleteError;
    }
  }
  message("Workspace stock saved to cloud: " + items.length + " item(s).", "success");
}
window.addEventListener("vsp-stock-save", event => {
  const snapshot = event.detail?.items;
  const workspaceId = currentWorkspaceId;
  stockSyncQueue = stockSyncQueue.then(() => syncWorkspaceStock(snapshot, workspaceId))
    .catch(error => message("Stock is saved on this device, but cloud sync failed: " + (error?.message || error), "error"));
});
workspaceImportButton.addEventListener("click", async () => {
  if (!currentWorkspaceId || !legacyImportAllowed || !window.VSP_STOCK_BRIDGE) return;
  const items = window.VSP_STOCK_BRIDGE.getPreCloudItems();
  if (!items.length) return message("There is no existing device stock to import.", "warning");
  if (!confirm("Import " + items.length + " items from this device into this empty workspace? This does not overwrite any other workspace.")) return;
  workspaceImportButton.disabled = true;
  try {
    await syncWorkspaceStock(items);
    await loadWorkspaceStock();
    message("Imported " + items.length + " stock item(s) into this workspace only.", "success");
  } catch (error) {
    message("Import failed: " + (error?.message || error), "error");
  } finally {
    workspaceImportButton.disabled = false;
  }
});

function message(text, kind = "info") {
  if (!status) return;
  status.textContent = text;
  status.dataset.kind = kind;
}
function setSession(session) {
  const previousUserId = currentSession?.user?.id || null;
  const nextUserId = session?.user?.id || null;
  currentSession = session;
  if (previousUserId !== nextUserId) {
    currentWorkspaceId = null;
    legacyImportAllowed = false;
    workspaceImportButton.hidden = true;
    if (window.VSP_STOCK_BRIDGE) window.VSP_STOCK_BRIDGE.setItems([]);
  }
  const user = session?.user;
  sessionLabel.textContent = user ? "Signed in as " + user.email : "Not signed in";
  signInButton.hidden = !!user;
  signUpButton.hidden = !!user;
  signOutButton.hidden = !user;
  setupButton.hidden = !user;
  email.disabled = !!user;
  password.disabled = !!user;
}
async function checkSchema() {
  const { error } = await supabase.from("workspaces").select("id").limit(1);
  if (error) {
    if (error.code === "42P01" || /relation .* does not exist|schema cache/i.test(error.message || "")) {
      message("Your Supabase project is reachable, but the Van Stock Pro database schema has not been installed yet. Open supabase/schema.sql in GitHub, paste it into Supabase SQL Editor, and run it. No stock data has been uploaded.", "warning");
    } else if (error.code === "PGRST301" || error.code === "42501") {
      message("Signed in, but database access is not ready. Check that the Van Stock Pro schema and row-level security policies were installed.", "warning");
    } else {
      message("Connected to Supabase, but the workspace check failed: " + error.message, "warning");
    }
    return false;
  }
  return true;
}
async function runAuth(action) {
  const mail = (email.value || "").trim();
  const pass = password.value || "";
  if (!mail || !pass) {
    message("Enter your email and password first.", "warning");
    return;
  }
  signInButton.disabled = signUpButton.disabled = true;
  try {
    if (action === "signup") {
      const { data, error } = await supabase.auth.signUp({ email: mail, password: pass });
      if (error) throw error;
      setSession(data.session);
      message(data.session
        ? "Account created and signed in. Next, initialise your Van Stock Pro workspace."
        : "Account created. Check your email to confirm the account, then sign in here.");
    } else {
      const { data, error } = await supabase.auth.signInWithPassword({ email: mail, password: pass });
      if (error) throw error;
      setSession(data.session);
      message("Signed in. Checking your workspace setup…");
      const ready = await checkSchema();
      if (ready) await loadWorkspaceStock();
    }
  } catch (error) {
    message(error?.message || "Authentication failed.", "error");
  } finally {
    signInButton.disabled = signUpButton.disabled = false;
  }
}
signInButton.addEventListener("click", () => runAuth("signin"));
signUpButton.addEventListener("click", () => runAuth("signup"));
signOutButton.addEventListener("click", async () => {
  const { error } = await supabase.auth.signOut();
  if (error) message(error.message, "error");
  else { setSession(null); message("Signed out. Your existing browser stock has not been changed."); }
});
setupButton.addEventListener("click", async () => {
  if (!currentSession?.user) return message("Sign in first.", "warning");
  setupButton.disabled = true;
  try {
    const ready = await checkSchema();
    if (!ready) return;
    const uid = currentSession.user.id;
    const { data: memberships, error: memberError } = await supabase
      .from("workspace_members").select("workspace_id, role").eq("user_id", uid).limit(1);
    if (memberError) throw memberError;
    if (memberships?.length) {
      await loadWorkspaceStock();
      return;
    }
    const { data: owned, error: ownedError } = await supabase.from("workspaces").select("id").eq("created_by", uid).order("created_at", { ascending: true }).limit(1);
    if (ownedError) throw ownedError;
    let workspace = owned?.[0];
    let createdNow = false;
    if (!workspace) {
      const { data, error } = await supabase.from("workspaces").insert({ name: "Van Stock Pro", created_by: uid }).select("id").single();
      if (error) throw error;
      workspace = data;
      createdNow = true;
    }
    const { error: membershipError } = await supabase.from("workspace_members").insert({
      workspace_id: workspace.id, user_id: uid, role: "owner"
    });
    if (membershipError) {
      // Keep the created workspace for diagnosis; do not delete anything automatically.
      throw new Error("Workspace " + (createdNow ? "was created" : "was recovered") + " but owner membership did not finish: " + membershipError.message);
    }
    await loadWorkspaceStock();
    message((createdNow ? "Van Stock Pro workspace created." : "Existing Van Stock Pro workspace recovered.") + " Your workspace stock is now isolated.", "success");
  } catch (error) {
    message(error?.message || "Workspace setup failed.", "error");
  } finally {
    setupButton.disabled = false;
  }
});
supabase.auth.onAuthStateChange((_event, session) => {
  setSession(session);
});
const { data: initial } = await supabase.auth.getSession();
setSession(initial.session);
if (initial.session) { const ready = await checkSchema(); if (ready) await loadWorkspaceStock(); }

const backupFile = $("cloudBackupFile");
const previewButton = $("cloudPreviewImport");
const clearPreviewButton = $("cloudClearImport");
const importMessage = $("cloudImportMessage");
const importSummary = $("cloudImportSummary");
function clearImportPreview() {
  backupFile.value = "";
  importSummary.hidden = true;
  importMessage.textContent = "No backup selected. Use the app's Download data backup feature to create a JSON file first.";
}
function countArray(data, key) {
  try {
    const raw = data[key];
    if (raw == null) return [];
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    // A present but malformed record list must not look like a valid empty list.
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function previewBackup(payload) {
  if (!payload || payload.format !== "van-stock-pro-data-backup" || !payload.data || typeof payload.data !== "object" || Array.isArray(payload.data)) {
    throw new Error("This is not a recognised Van Stock Pro JSON data backup. Choose the file created by Download data backup.");
  }
  const data = payload.data;
  const items = countArray(data, "van-stock-pro-items-v1");
  const movements = countArray(data, "van-stock-pro-movements-v2");
  const usage = countArray(data, "van-stock-pro-usage-v1");
  if (items === null || movements === null || usage === null) {
    throw new Error("A stock, movement, or job-usage record list is invalid JSON. No data has been changed.");
  }
  const photoCount = items.filter(item => item && (item.photo || item.photoData || item.image || item.imageData)).length;
  const known = new Set(["van-stock-pro-items-v1", "van-stock-pro-movements-v2", "van-stock-pro-usage-v1"]);
  const settingCount = Object.keys(data).filter(key => !known.has(key)).length;
  const warnings = [];
  if (!items.length) warnings.push("No stock items were found under the expected stock key.");
  if (items.some(item => !item || typeof item !== "object" || Array.isArray(item) || !String(item.name || "").trim())) warnings.push("Some stock entries are missing a valid item name or are not records.");
  if (items.some(item => !item || item.qty == null || item.qty === "" || !Number.isFinite(Number(item.qty)) || Number(item.qty) < 0)) warnings.push("Some stock quantities are missing, invalid, or negative.");
  const itemIds = items.map(item => item && item.id != null ? String(item.id).trim() : "").filter(Boolean);
  if (new Set(itemIds).size !== itemIds.length) warnings.push("Duplicate stock item IDs were found; review before importing.");
  if (items.some(item => item && item.maxQty != null && item.maxQty !== "" && (!Number.isFinite(Number(item.maxQty)) || Number(item.maxQty) < 0))) warnings.push("Some maximum stock quantities are invalid or negative.");
  if (items.some(item => item && item.minQty != null && item.minQty !== "" && (!Number.isFinite(Number(item.minQty)) || Number(item.minQty) < 0))) warnings.push("Some minimum stock quantities are invalid or negative.");
  if (items.some(item => item && item.maxQty != null && item.maxQty !== "" && item.minQty != null && item.minQty !== "" && Number.isFinite(Number(item.maxQty)) && Number.isFinite(Number(item.minQty)) && Number(item.maxQty) < Number(item.minQty))) warnings.push("Some maximum stock quantities are below their minimum.");
  if (movements.some(record => !record || typeof record !== "object" || Array.isArray(record))) warnings.push("Some stock movement entries are not valid records.");
  if (usage.some(record => !record || typeof record !== "object" || Array.isArray(record))) warnings.push("Some job-usage entries are not valid records.");
  if (usage.some(record => record && (record.quantity == null || record.quantity === "" || !Number.isFinite(Number(record.quantity)) || Number(record.quantity) <= 0))) warnings.push("Some job-usage quantities are missing, invalid, or not positive.");
  const knownItemIds = new Set(itemIds);
  if (movements.some(record => record && record.itemId != null && !knownItemIds.has(String(record.itemId)))) warnings.push("Some stock movements refer to item IDs not present in the stock list.");
  if (usage.some(record => record && record.itemId != null && !knownItemIds.has(String(record.itemId)))) warnings.push("Some job-usage records refer to item IDs not present in the stock list.");
  if (items.some(item => item && item.id == null)) warnings.push("Some stock items have no legacy ID; history linking needs manual review.");
  if (items.some(item => item && [item.photo, item.photoData, item.image, item.imageData].some(value => typeof value === "string" && value.startsWith("data:") && value.length > 7 * 1024 * 1024))) warnings.push("Some embedded photos are very large; photo conversion and upload limits must be checked before migration.");
  $("cloudImportItems").textContent = items.length;
  $("cloudImportMovements").textContent = movements.length;
  $("cloudImportUsage").textContent = usage.length;
  $("cloudImportPhotos").textContent = photoCount;
  $("cloudImportSettings").textContent = "Additional settings/data entries: " + settingCount + ". Read-only preview only; no database writes have been made.";
  $("cloudImportWarnings").textContent = warnings.length ? "Review notes: " + warnings.join(" ") : "Basic record checks passed. A full migration still needs duplicate, photo-upload, history-linking, and database permission tests.";
  importSummary.hidden = false;
  importMessage.textContent = "Backup parsed successfully (created " + (payload.createdAt || "date not provided") + "). Preview only — nothing was uploaded or changed.";
}
previewButton.addEventListener("click", async () => {
  const file = backupFile.files && backupFile.files[0];
  if (!file) {
    importMessage.textContent = "Choose a JSON data backup first.";
    return;
  }
  previewButton.disabled = true;
  importSummary.hidden = true;
  try {
    if (file.size > 50 * 1024 * 1024) throw new Error("This backup is larger than 50 MB. Create a smaller backup or split the file before previewing.");
    const payload = JSON.parse(await file.text());
    previewBackup(payload);
  } catch (error) {
    importMessage.textContent = error?.message || "Could not preview this backup.";
  } finally {
    previewButton.disabled = false;
  }
});
clearPreviewButton.addEventListener("click", clearImportPreview);

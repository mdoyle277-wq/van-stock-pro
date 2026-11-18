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
const previewButton = $("cloudPreview");
const previewResult = $("cloudPreviewResult");
let currentSession = null;

function message(text, kind = "info") {
  if (!status) return;
  status.textContent = text;
  status.dataset.kind = kind;
}
function clearCloudLoadingWithEmptyStock() {
  if (typeof window.__VSP_APPLY_CLOUD_STOCK === "function") {
    try { window.__VSP_APPLY_CLOUD_STOCK([]); } catch {}
  }
  document.body.classList.remove("cloud-loading");
}
function cloudStockErrorDetail(error) {
  const detail = error?.message || "Unknown cloud stock error";
  if (/no unique or exclusion constraint|on conflict/i.test(detail)) {
    return "The required workspace/owner/legacy-ID unique index is missing. Run supabase/migrations/20261112_user_stock_cloud_sync.sql in Supabase SQL Editor.";
  }
  return detail;
}
// Supabase manages session expiry and token refresh; do not force-sign-out
// active mobile users merely because they are tapping rather than typing.
function setSession(session) {
  const previousUserId = currentSession?.user?.id || null;
  const nextUserId = session?.user?.id || null;
  currentSession = session;
  if (previousUserId !== nextUserId || !nextUserId) {
    document.body.classList.remove("cloud-admin");
    // Preserve a local snapshot for recovery, but never display or upload it
    // as the next account's stock: browsers can be shared between accounts.
    try {
      const cached = localStorage.getItem("van-stock-pro-items-v1");
      const cachedItems = cached ? JSON.parse(cached) : null;
      // Never replace a non-empty account archive with the empty list written
      // while switching accounts.
      // Only archive stock when switching away from a known signed-in account.
      // A browser's unassigned legacy cache must never be attributed to the
      // next account: on a first sign-in that cache may contain the admin's
      // 62 starter items and would otherwise be imported into a new user's
      // personal workspace.
      if (previousUserId && Array.isArray(cachedItems) && cachedItems.length) {
        const archiveKey = "van-stock-pro-isolated-cache-v2-" + previousUserId;
        localStorage.setItem(archiveKey, cached);
      }
    } catch {}
    document.body.classList.add("cloud-loading");
    stockSyncReady = false;
    stockWorkspaceId = null;
    if (typeof window.__VSP_APPLY_CLOUD_STOCK === "function") {
      window.__VSP_APPLY_CLOUD_STOCK([]);
    }
  }
  document.body.classList.toggle("cloud-authenticated", !!session?.user);
  const miniSignOut = $("cloudSignOutMini");
  const miniSignIn = $("cloudSignInMini");
  if (miniSignOut) { const show = !!session?.user; miniSignOut.hidden = !show; miniSignOut.classList.toggle("is-hidden", !show); miniSignOut.style.setProperty("display", show ? "inline-flex" : "none", "important"); miniSignOut.disabled = !show; miniSignOut.title = "Sign out"; }
  if (miniSignIn) { const show = !session?.user; miniSignIn.hidden = !show; miniSignIn.classList.toggle("is-hidden", !show); miniSignIn.style.setProperty("display", show ? "inline-flex" : "none", "important"); miniSignIn.disabled = !show; miniSignIn.title = "Open sign-in fields below the title"; }
  const user = session?.user;
  sessionLabel.textContent = user ? "Signed in as " + user.email : "Not signed in";
  signInButton.hidden = !!user;
  signUpButton.hidden = !!user;
  signOutButton.hidden = !user;
  setupButton.hidden = !user;
  previewButton.hidden = !user;
  email.disabled = !!user;
  password.disabled = !!user;
  updateSyncStatus(session?.user ? "connecting" : "signed-out");
  window.dispatchEvent(new Event("vsp-category-session"));
}
async function checkSchema() {
  const { error: workspaceError } = await supabase.from("workspaces").select("id").limit(1);
  if (workspaceError) {
    clearCloudLoadingWithEmptyStock();
    message("Workspace database check failed: " + (workspaceError.message || "Unknown error") + ". No cloud stock was changed.", "error");
    return false;
  }
  const { error: stockError } = await supabase.from("stock_items")
    .select("id,workspace_id,owner_user_id,legacy_id").limit(1);
  if (stockError) {
    const detail = stockError.message || "Unknown stock schema error";
    if (/owner_user_id|legacy_id|column .* does not exist|schema cache/i.test(detail)) {
      clearCloudLoadingWithEmptyStock();
      message("CLOUD STOCK NOT READY — the per-user stock migration is missing. Run supabase/migrations/20261112_user_stock_cloud_sync.sql in Supabase SQL Editor before adding stock. Existing stock rows are retained; do not run a reset or delete script.", "error");
    } else {
      clearCloudLoadingWithEmptyStock();
      message("Stock database check failed: " + detail + ". No cloud stock was changed.", "error");
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
      if (data.session) { await refreshAccessPanel(); await initialiseCloudStock(); }
      message(data.session
        ? "Account created and signed in. Next, initialise your Van Stock Pro workspace."
        : "Account created. Check your email to confirm the account, then sign in here.");
    } else {
      const { data, error } = await supabase.auth.signInWithPassword({ email: mail, password: pass });
      if (error) throw error;
      setSession(data.session);
      message("Signed in. Checking your workspace setup…");
      const schemaReady = await checkSchema();
      if (schemaReady) { await refreshAccessPanel(); await initialiseCloudStock(); }
    }
  } catch (error) {
    message(error?.message || "Authentication failed.", "error");
  } finally {
    signInButton.disabled = signUpButton.disabled = false;
  }
}

/* Workspace-scoped stock persistence. Each authorised account owns a private
   stock list inside its workspace; RLS enforces the same owner boundary. */
let stockWorkspaceId = null;
let stockSyncTimer = null;
let stockSyncBusy = false;
let stockSyncAgain = false;
let stockSyncReady = false;

function updateSyncStatus(state, detail) {
  const panel = $("syncStatusPanel");
  if (!panel) return;
  const userId = currentSession?.user?.id || null;
  let queued = 0;
  try { if (userId) queued = readOfflineQueue(userId).length; } catch { queued = "Check"; }
  const online = typeof navigator === "undefined" || navigator.onLine !== false;
  const badge = $("syncStatusBadge");
  const connection = $("syncStatusConnection");
  const cloud = $("syncStatusCloud");
  const queue = $("syncStatusQueue");
  const last = $("syncStatusLast");
  const help = $("syncStatusHelp");
  let label = state || "checking";
  if (!userId) label = "signed-out";
  else if (!online) label = "offline";
  else if (queued && label === "synced") label = "pending";
  panel.dataset.state = label === "signed-out" ? "offline" : label;
  if (badge) badge.textContent = ({
    "signed-out":"Not signed in", checking:"Checking…", connecting:"Connecting…",
    syncing:"Syncing…", synced:"Up to date", pending:"Waiting to upload",
    offline:"Offline — saved here", error:"Sync problem", ready:"Connected"
  })[label] || label;
  if (connection) connection.textContent = !userId ? "Not signed in" : online ? "Online" : "Offline";
  if (cloud) cloud.textContent = !userId ? "Sign in required" : !stockSyncReady ? "Connecting / unavailable" : online ? "Connected" : "Offline mode";
  if (queue) queue.textContent = String(queued);
  if (last) {
    let stamp = null;
    try { stamp = userId && localStorage.getItem("van-stock-pro-last-sync-" + userId); } catch {}
    last.textContent = stamp ? new Date(stamp).toLocaleString() : "Not yet synced";
  }
  if (help) help.textContent = detail || (queued ? queued + " saved record(s) will upload when a connection is available." : !online ? "Changes remain on this device and will upload when signal returns." : "Your stock and job records are checked automatically.");
}


function stockRowsToItems(rows) {
  return (rows || []).map(row => {
    let extra = {};
    try {
      const parsed = row.notes ? JSON.parse(row.notes) : {};
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) extra = parsed;
    } catch {}
    return {
      ...extra,
      id: String(row.legacy_id ?? row.id),
      name: row.name || extra.name || "Unnamed item",
      sku: row.sku || "",
      barcode: row.barcode || "",
      category: row.category || "",
      qty: Number(row.qty ?? 0),
      minQty: Number(row.min_qty ?? 0),
      maxQty: row.max_qty == null ? null : Number(row.max_qty),
      location: row.location || "",
      supplier: row.supplier || "",
      supplierUrl: row.supplier_url || "",
      photo: extra.photo || ""
    };
  });
}
function itemToStockRow(item, workspaceId, userId) {
  const safe = { ...item };
  return {
    workspace_id: workspaceId,
    owner_user_id: userId,
    legacy_id: String(item.id),
    name: String(item.name || "Unnamed item"),
    sku: String(item.sku || ""),
    barcode: String(item.barcode || ""),
    category: String(item.category || ""),
    qty: Number(item.qty || 0),
    min_qty: Number(item.minQty || 0),
    max_qty: item.maxQty == null || item.maxQty === "" ? null : Number(item.maxQty),
    location: String(item.location || ""),
    supplier: String(item.supplier || ""),
    supplier_url: String(item.supplierUrl || ""),
    notes: JSON.stringify(safe),
    updated_at: new Date().toISOString()
  };
}
async function getMyStockWorkspace() {
  if (!currentSession?.user) throw new Error("Sign in before syncing stock.");
  const userId = currentSession.user.id;
  const { data: memberships, error } = await supabase.from("workspace_members")
    .select("workspace_id, role, created_at").eq("user_id", userId)
    .order("created_at", { ascending: true }).limit(50);
  if (error) throw error;
  if (!memberships?.length) throw new Error("No workspace is linked to this account. Set up or authorise the workspace first.");
  const ids = [...new Set(memberships.map(row => row.workspace_id))];
  const { data: workspaces, error: workspaceError } = await supabase.from("workspaces")
    .select("id, created_by").in("id", ids);
  if (workspaceError) throw workspaceError;
  if (currentSession?.user?.id !== userId) throw new Error("The signed-in account changed while loading workspaces.");
  // Prefer a personal workspace if one exists. If the account only has a
  // shared workspace membership, owner_user_id + RLS still isolate its rows.
  const personal = (workspaces || []).find(row => row.created_by === userId);
  const personalMembership = personal
    ? memberships.find(row => row.workspace_id === personal.id)
    : null;
  const membership = personalMembership?.role !== "viewer" && personalMembership
    ? personalMembership
    : memberships.find(row => row.role !== "viewer");
  if (!membership) throw new Error("This account has view-only access and cannot change stock.");
  return { id: membership.workspace_id, role: membership.role, isPersonal: !!personal && membership.workspace_id === personal.id };
}
async function writeCloudStock(items) {
  if (!stockWorkspaceId || !currentSession?.user) throw new Error("Cloud workspace is not ready.");
  if (!Array.isArray(items)) throw new Error("Local stock is not a valid item list.");
  // Guard cloud writes as well as the Add Item form: legacy imports or restored
  // local data can bypass the form-level check. Never upload duplicate SKU/location
  // pairs, and never partially update cloud stock when the local list is ambiguous.
  const normaliseStockKey = value => String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
  const seenStockKeys = new Map();
  const duplicateStockKeys = [];
  for (const item of items) {
    const sku = normaliseStockKey(item?.sku);
    if (!sku) continue;
    const location = normaliseStockKey(item?.location);
    const key = sku + "\u0000" + location;
    if (seenStockKeys.has(key)) {
      const label = String(item.sku || "").trim() + (String(item.location || "").trim() ? " @ " + String(item.location).trim() : "");
      if (!duplicateStockKeys.includes(label)) duplicateStockKeys.push(label);
    } else {
      seenStockKeys.set(key, true);
    }
  }
  if (duplicateStockKeys.length) {
    const shown = duplicateStockKeys.slice(0, 5).join(", ");
    const extra = duplicateStockKeys.length > 5 ? " (and " + (duplicateStockKeys.length - 5) + " more)" : "";
    throw new Error("Cloud save stopped: duplicate SKU and location entries were found (" + shown + extra + "). No cloud stock was changed. Keep both records until their quantities and history have been checked, then edit or remove the duplicate.");
  }
  const userId = currentSession.user.id;
  const workspaceId = stockWorkspaceId;
  const rows = items.map(item => itemToStockRow(item, workspaceId, userId));
  if (rows.length) {
    const { error } = await supabase.from("stock_items")
      .upsert(rows, { onConflict: "workspace_id,owner_user_id,legacy_id" });
    if (error) throw error;
  }
  if (currentSession?.user?.id !== userId || stockWorkspaceId !== workspaceId)
    throw new Error("The signed-in account or workspace changed during the save. Sign in again and retry.");
  const { data: existing, error: readError } = await supabase.from("stock_items")
    .select("legacy_id").eq("workspace_id", workspaceId).eq("owner_user_id", userId);
  if (readError) throw readError;
  const keep = new Set(items.map(item => String(item.id)));
  const remove = (existing || []).map(row => String(row.legacy_id)).filter(id => !keep.has(id));
  if (remove.length) {
    const { error } = await supabase.from("stock_items").delete()
      .eq("workspace_id", workspaceId).eq("owner_user_id", userId).in("legacy_id", remove);
    if (error) throw error;
  }
  if (currentSession?.user?.id !== userId || stockWorkspaceId !== workspaceId)
    throw new Error("The signed-in account or workspace changed during the save. Sign in again and retry.");
  const { count, error: verifyError } = await supabase.from("stock_items")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId).eq("owner_user_id", userId);
  if (verifyError) throw verifyError;
  if (count !== items.length) throw new Error("Cloud verification failed: expected " + items.length + " stock lines but found " + count + ".");
}
async function initialiseCloudStock() {
  if (!currentSession?.user) return;
  const userId = currentSession.user.id;
  stockSyncReady = false;
  try {
    const workspace = await getMyStockWorkspace();
    if (currentSession?.user?.id !== userId) return;
    stockWorkspaceId = workspace.id;
    try{localStorage.setItem("van-stock-pro-workspace-"+userId,workspace.id)}catch{}
    // Only workspace owners/admins may access app-code backup and restore.
    document.body.classList.toggle("cloud-admin", ["owner", "admin"].includes(String(workspace.role || "").toLowerCase()));
    const { data: cloudRows, error } = await supabase.from("stock_items")
      .select("*").eq("workspace_id", stockWorkspaceId).eq("owner_user_id", userId)
      .order("name", { ascending: true });
    if (error) throw error;
    if (currentSession?.user?.id !== userId) return;
    // Fail closed if the database ever returns a row outside this account/workspace.
    // This is a second guard in addition to the explicit filters and Supabase RLS.
    const foreignRows = (cloudRows || []).filter(row =>
      row.owner_user_id !== userId || row.workspace_id !== stockWorkspaceId
    );
    if (foreignRows.length) {
      throw new Error("Account isolation check failed: the database returned stock owned by another account. No stock was displayed or changed.");
    }
    const cloudItems = stockRowsToItems(cloudRows || []);
    if (typeof window.__VSP_APPLY_CLOUD_STOCK !== "function") throw new Error("Stock screen is not ready to receive cloud data.");
    if (cloudItems.length) {
      window.__VSP_APPLY_CLOUD_STOCK(cloudItems);
      message("Your private cloud stock loaded and verified: " + cloudItems.length + " item(s).", "success");
    } else if (workspace.role === "owner" && workspace.isPersonal) {
      // Import only the cache archived for this exact account on sign-in.
      // Never read the shared browser stock key for a newly invited user.
      const local = readLocalArray("van-stock-pro-isolated-cache-v2-" + userId);
      if (local.length) {
        await writeCloudStock(local);
        if (currentSession?.user?.id !== userId) return;
        window.__VSP_APPLY_CLOUD_STOCK(local);
        message("Your account's archived stock was copied to its private cloud list and verified: " + local.length + " item(s).", "success");
      } else {
        window.__VSP_APPLY_CLOUD_STOCK([]);
        message("Your private stock is ready. Add your first item to begin.", "success");
      }
    } else {
      window.__VSP_APPLY_CLOUD_STOCK([]);
      message("Your private stock is empty. The administrator's stock is kept separate.", "success");
    }
    if (currentSession?.user?.id === userId) {
      stockSyncReady = true;
      document.body.classList.remove("cloud-loading");
      updateSyncStatus(navigator.onLine === false ? "offline" : "ready");
      await syncOfflineQueue();
    }
  } catch (error) {
    if (currentSession?.user?.id === userId) {
      const cachedWorkspace=localStorage.getItem("van-stock-pro-workspace-"+userId);
      if(cachedWorkspace&&/^[0-9a-f-]{36}$/i.test(cachedWorkspace)){
        stockWorkspaceId=cachedWorkspace;stockSyncReady=true;
        document.body.classList.remove("cloud-loading");
        message("OFFLINE MODE — your existing local stock is available. New job and battery records will be saved on this device and uploaded when signal returns.","warning");
        updateSyncStatus("offline");
      }else{
        stockSyncReady=false;clearCloudLoadingWithEmptyStock();
        updateSyncStatus("error", error?.message || "Cloud connection could not be established.");
        message("CLOUD STOCK NOT READY — connect to the internet once on this device before offline use. "+cloudStockErrorDetail(error),"error");
      }
    }
  }
}
async function runStockSync() {
  if (!stockSyncReady || !currentSession?.user || !stockWorkspaceId) return;
  if (stockSyncBusy) { stockSyncAgain = true; return; }
  stockSyncBusy = true;
  updateSyncStatus("syncing");
  const userId = currentSession.user.id;
  const workspaceId = stockWorkspaceId;
  try {
    const raw = localStorage.getItem("van-stock-pro-items-v1");
    const items = raw == null ? [] : JSON.parse(raw);
    if (!Array.isArray(items)) throw new Error("Saved local stock is not a valid list.");
    if(navigator.onLine===false)return;
    await writeCloudStock(items);
    if (currentSession?.user?.id !== userId || stockWorkspaceId !== workspaceId) return;
    await syncOfflineQueue();
    try { localStorage.setItem("van-stock-pro-last-sync-" + userId, new Date().toISOString()); } catch {}
    updateSyncStatus(readOfflineQueue(userId).length ? "pending" : "synced");
    message("Cloud stock saved and verified: " + items.length + " item(s).", "success");
  } catch (error) {
    if (currentSession?.user?.id === userId) {
      updateSyncStatus(isNetworkFailure(error) ? "offline" : "error", error?.message || "Cloud save failed.");
      message("CLOUD SAVE FAILED — your local stock is still on this device. " + cloudStockErrorDetail(error), "error");
    }
  } finally {
    stockSyncBusy = false;
    if (stockSyncAgain && stockSyncReady) { stockSyncAgain = false; runStockSync(); }
    else stockSyncAgain = false;
  }
}
window.addEventListener("online",()=>{updateSyncStatus("connecting");if(stockSyncReady){runStockSync();syncOfflineQueue()}else if(currentSession?.user?.id){initialiseCloudStock()}});
window.addEventListener("offline",()=>updateSyncStatus("offline","No internet connection. Changes are kept on this device until signal returns."));
window.addEventListener("focus",()=>{if(stockSyncReady&&navigator.onLine!==false){runStockSync();syncOfflineQueue()}});
window.addEventListener("vsp:stock-changed", () => {
  if (!stockSyncReady) return;
  if (stockSyncTimer) window.clearTimeout(stockSyncTimer);
  updateSyncStatus("syncing");
  message("Saving stock to the cloud…", "info");
  stockSyncTimer = window.setTimeout(() => {
    stockSyncTimer = null;
    runStockSync();
  }, 120);
});
// Warn before a refresh/navigation can interrupt an in-flight cloud save.
window.addEventListener("beforeunload", event => {
  if (stockSyncReady && (stockSyncBusy || stockSyncTimer !== null)) {
    event.preventDefault();
    event.returnValue = "";
  }
});

function readLocalArray(key) {
  const raw = localStorage.getItem(key);
  if (raw === null) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("Saved data at " + key + " is not a list. No data was changed.");
  return parsed;
}
function previewLocalMigration() {
  previewResult.hidden = false;
  previewResult.textContent = "Checking local stock and history…";
  try {
    const stock = readLocalArray("van-stock-pro-items-v1");
    const movements = readLocalArray("van-stock-pro-movements-v2");
    const usage = readLocalArray("van-stock-pro-usage-v1");
    const orders = readLocalArray("van-stock-pro-orders-v1");
    if (!stock.length) throw new Error("No local stock items were found. Nothing can be prepared for migration.");
    const invalid = stock.filter(item => !item || item.id === undefined || typeof item.name !== "string" || !Number.isFinite(Number(item.qty)));
    if (invalid.length) throw new Error(invalid.length + " stock item(s) are missing a valid ID, name, or quantity. No data was changed.");
    const photos = stock.filter(item => typeof item.photo === "string" && item.photo.length > 0).length;
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith("van-stock-pro-")) keys.push(key);
    }
    const sample = stock.slice(0, 5).map(item => String(item.name)).join(", ");
    previewResult.textContent =
      "LOCAL MIGRATION PREVIEW ONLY — nothing has been uploaded or changed. " +
      stock.length + " stock items; " + photos + " item photo(s); " +
      movements.length + " movement record(s); " + usage.length +
      " job-usage record(s); " + orders.length + " supplier/order history record(s); " +
      keys.length + " Van Stock Pro local-storage key(s). " +
      "Sample items: " + sample + (stock.length > 5 ? ", …" : "") +
      ". Legacy item IDs will be preserved. Download and keep a data backup before any future import.";
    previewResult.dataset.kind = "success";
  } catch (error) {
    previewResult.textContent = (error && error.message) || "Could not preview local data. No data was changed.";
    previewResult.dataset.kind = "error";
  }
}
previewButton.addEventListener("click", previewLocalMigration);
signInButton.addEventListener("click", () => runAuth("signin"));
signUpButton.addEventListener("click", () => runAuth("signup"));
$("cloudSignInMini")?.addEventListener("click", () => {
  $("cloudEmail")?.focus();
  $("cloudStatus")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
});
$("cloudSignOutMini")?.addEventListener("click", () => {
  if (!currentSession?.user) {
    $("cloudEmail")?.focus();
    $("cloudStatus")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    return;
  }
  signOutButton.click();
});
signOutButton.addEventListener("click", async () => {
  const { error } = await supabase.auth.signOut();
  if (error) message(error.message, "error");
  else {
    setSession(null);
    email.value = "";
    password.value = "";
    message("Signed out. Email and password fields cleared. Your existing browser stock has not been changed.");
  }
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
      message("Workspace is ready. Your local stock has not been migrated. The next step is a reviewed import preview.", "success");
      await refreshAccessPanel();
      await initialiseCloudStock();
      return;
    }
    const { data: workspace, error: workspaceError } = await supabase
      .from("workspaces").insert({ name: "Van Stock Pro", created_by: uid }).select("id").single();
    if (workspaceError) throw workspaceError;
    const { error: membershipError } = await supabase.from("workspace_members").insert({
      workspace_id: workspace.id, user_id: uid, role: "owner"
    });
    if (membershipError) {
      // Keep the created workspace for diagnosis; do not delete anything automatically.
      throw new Error("Workspace was created but owner membership did not finish: " + membershipError.message);
    }
    message("Van Stock Pro workspace created. No stock data was uploaded or changed. Next: build and test the backup import preview.", "success");
    await refreshAccessPanel();
    await initialiseCloudStock();
  } catch (error) {
    message(error?.message || "Workspace setup failed.", "error");
  } finally {
    setupButton.disabled = false;
  }
});
// Category preferences live in each user's own Supabase auth metadata.
// updateUser can only update the currently authenticated account, so another
// workspace member cannot edit the administrator's category list (or vice versa).

// Durable offline queue for job history records. Entries are scoped to the
// signed-in account and workspace and retain their UUID across retries.
function offlineQueueKey(userId){return "van-stock-pro-offline-queue-v1-"+userId}
function readOfflineQueue(userId){
  const raw=localStorage.getItem(offlineQueueKey(userId));if(!raw)return [];
  const value=JSON.parse(raw);
  if(!Array.isArray(value))throw new Error("The offline save queue is damaged. Do not clear this browser's site data; contact support before continuing.");
  return value;
}
function writeOfflineQueue(userId,queue){
  localStorage.setItem(offlineQueueKey(userId),JSON.stringify(queue));
}
function isNetworkFailure(error){
  if(typeof navigator!=="undefined"&&navigator.onLine===false)return true;
  const s=String(error?.message||error||"").toLowerCase();
  return /failed to fetch|networkerror|network request|load failed|offline|connection (lost|reset|closed)|timed? ?out|timeout|fetch failed/.test(s);
}
function queueOfflineRecord(kind,row){
  const userId=currentSession?.user?.id;
  if(!userId||!row?.workspace_id||!row?.id)throw new Error("Cannot queue this record without a signed-in account and saved workspace.");
  const queue=readOfflineQueue(userId);
  if(!queue.some(x=>x.id===row.id&&x.kind===kind))queue.push({kind,id:row.id,row,queued_at:new Date().toISOString()});
  writeOfflineQueue(userId,queue);
  updateSyncStatus("pending", queue.length + " record(s) saved on this device and waiting to upload.");
  message("Saved on this device · waiting to upload "+queue.length+" record(s) when signal returns.","warning");
}
function queuedRows(kind,workspaceId){
  const userId=currentSession?.user?.id;
  return userId?readOfflineQueue(userId).filter(x=>x.kind===kind&&x.row?.workspace_id===workspaceId&&x.row?.owner_user_id===userId).map(x=>x.row):[];
}
function queuedDomain(kind,row){
  if(kind==="job_usage")return {id:row.id,date:row.usage_date,usageDate:String(row.usage_date||"").slice(0,10),job:row.job_reference,itemId:row.item_id,itemName:row.item_name,engineer:row.engineer_name||"",visitNotes:row.visit_notes||"",sku:row.sku||"",category:row.category||"",quantity:Number(row.quantity||0),_syncPending:true};
  return {id:row.id,date:row.visit_date,job:row.job_reference,siteName:row.site_name||"",engineer:row.engineer_name||"",systemType:row.system_type||"",notes:row.visit_notes||"",defects:row.defects||"",followUp:row.follow_up||"",batteryType:row.battery_type||"",batteryQuantity:row.battery_quantity??"",batteryInstalledDate:row.battery_installed_date||"",batteryDueDate:row.battery_due_date||"",intruderBatteryType:row.intruder_battery_type||"",intruderBatteryOther:row.intruder_battery_other||"",intruderBatteryQuantity:row.intruder_battery_quantity??"",intruderBatteryInstalledDate:row.intruder_battery_installed_date||"",intruderBatteryDueDate:row.intruder_battery_due_date||"",_syncPending:true};
}
async function insertOrQueueOfflineRecord(kind,table,row,selectFields){
  if(navigator.onLine===false){queueOfflineRecord(kind,row);return null;}
  const {data,error}=await supabase.from(table).insert(row).select(selectFields).single();
  if(error){if(isNetworkFailure(error)){queueOfflineRecord(kind,row);return null;}throw error;}
  return data;
}
let offlineQueueSyncBusy=false;
async function syncOfflineQueue(){
  const userId=currentSession?.user?.id,workspaceId=stockWorkspaceId;
  if(!userId||!workspaceId||!stockSyncReady||navigator.onLine===false||offlineQueueSyncBusy)return;
  offlineQueueSyncBusy=true;
  let queue=readOfflineQueue(userId),uploaded=0;
  try{
    for(const entry of queue.slice()){
      if(entry.row?.owner_user_id!==userId||entry.row?.workspace_id!==workspaceId)continue;
      const table=entry.kind==="job_usage"?"job_usage_records":entry.kind==="site_visit"?"job_site_visits":null;
      if(!table)continue;
      const {data,error}=await supabase.from(table).insert(entry.row).select("id").single();
      if(error){
        if(error.code==="23505"){
          const {data:existing,error:checkError}=await supabase.from(table).select("id").eq("id",entry.id).eq("workspace_id",workspaceId).eq("owner_user_id",userId).maybeSingle();
          if(checkError||!existing?.id)throw error;
        }else throw error;
      }
      if(currentSession?.user?.id!==userId||stockWorkspaceId!==workspaceId)throw new Error("Account changed during offline sync.");
      queue=queue.filter(x=>!(x.kind===entry.kind&&x.id===entry.id));
      writeOfflineQueue(userId,queue);uploaded++;
    }
    if(uploaded){
      message("Synced "+uploaded+" offline record(s) to Supabase. "+queue.length+" still waiting.","success");
      window.dispatchEvent(new Event("vsp:offline-sync-complete"));
      try { localStorage.setItem("van-stock-pro-last-sync-" + userId, new Date().toISOString()); } catch {}
    }else if(queue.length){
      message(queue.length+" record(s) saved on this device · waiting to upload.","warning");
    }
    updateSyncStatus(queue.length ? "pending" : (uploaded ? "synced" : "ready"));
  }catch(error){
    message("Offline sync paused · "+queue.length+" record(s) remain safely on this device. "+(error?.message||"Check your connection."),"warning");
  }finally{offlineQueueSyncBusy=false;updateSyncStatus(navigator.onLine===false?"offline":(readOfflineQueue(userId).length?"pending":"ready"));}
}

// Private job usage history. RLS and explicit owner filters ensure that
// even workspace admins can see only their own records in this first release.
window.__VSP_JOB_USAGE_STORE = {
  isReady() { return !!(currentSession?.user?.id && stockWorkspaceId && stockSyncReady); },
  async getAll() {
    if (!this.isReady()) throw new Error("Sign in and wait for your private cloud stock to finish loading.");
    const userId = currentSession.user.id, workspaceId = stockWorkspaceId;
    const { data, error } = await supabase.from("job_usage_records")
      .select("id,usage_date,job_reference,item_id,item_name,sku,category,quantity,engineer_name,visit_notes")
      .eq("workspace_id", workspaceId).eq("owner_user_id", userId)
      .order("usage_date", { ascending: false }).limit(5000);
    if (error) {if(isNetworkFailure(error))return queuedRows("job_usage",workspaceId).map(row=>queuedDomain("job_usage",row));throw error;}
    if (currentSession?.user?.id !== userId || stockWorkspaceId !== workspaceId)
      throw new Error("The signed-in account changed while loading job history.");
    const cloud=(data || []).map(row => ({
      id: row.id, date: row.usage_date, usageDate: String(row.usage_date || "").slice(0,10),
      job: row.job_reference, itemId: row.item_id, itemName: row.item_name,
      engineer: row.engineer_name || "", visitNotes: row.visit_notes || "",
      sku: row.sku || "", category: row.category || "", quantity: Number(row.quantity || 0)
    }));
    return [...cloud,...queuedRows("job_usage",workspaceId).map(row=>queuedDomain("job_usage",row))];
  },
  async add(entry) {
    if (!this.isReady()) throw new Error("Sign in and wait for your private cloud stock to finish loading before recording job usage.");
    const userId = currentSession.user.id, workspaceId = stockWorkspaceId;
    const row = {
      id:entry.id||crypto.randomUUID(),workspace_id: workspaceId, owner_user_id: userId,
      usage_date: entry.date || new Date().toISOString(),
      job_reference: String(entry.job || "").trim(),
      item_id: String(entry.itemId ?? ""),
      item_name: String(entry.itemName || "Unnamed item"),
      sku: String(entry.sku || ""), category: String(entry.category || ""),
      engineer_name: String(entry.engineer || "").trim().slice(0,80),
      visit_notes: String(entry.visitNotes || "").trim().slice(0,1000),
      quantity: Number(entry.quantity)
    };
    if (!row.job_reference || !Number.isInteger(row.quantity) || row.quantity < 1)
      throw new Error("The job reference or quantity is invalid.");
    const data=await insertOrQueueOfflineRecord("job_usage","job_usage_records",row,"id,usage_date,job_reference,item_id,item_name,sku,category,quantity,engineer_name,visit_notes");
    if(!data)return queuedDomain("job_usage",row);
    if (currentSession?.user?.id !== userId || stockWorkspaceId !== workspaceId)
      throw new Error("The signed-in account changed while saving job usage. Refresh before continuing.");
    return {
      id: data.id, date: data.usage_date, usageDate: String(data.usage_date || "").slice(0,10),
      job: data.job_reference, itemId: data.item_id, itemName: data.item_name,
      engineer: data.engineer_name || "", visitNotes: data.visit_notes || "",
      sku: data.sku || "", category: data.category || "", quantity: Number(data.quantity || 0)
    };
  },
  async remove(id) {
    if (!this.isReady()) throw new Error("Cloud account is not ready.");
    if (!id) throw new Error("The parts-used record ID is missing.");
    const userId = currentSession.user.id, workspaceId = stockWorkspaceId;
    const localQueue=readOfflineQueue(userId),queued=localQueue.filter(x=>x.kind==="job_usage"&&x.id===id);
    if(queued.length){writeOfflineQueue(userId,localQueue.filter(x=>!(x.kind==="job_usage"&&x.id===id)));return true;}
    const { data, error } = await supabase.from("job_usage_records").delete()
      .eq("id", id).eq("workspace_id", workspaceId).eq("owner_user_id", userId)
      .select("id");
    if (error) throw error;
    if (!data || data.length !== 1) {
      throw new Error("Supabase did not confirm deletion. Check the job_usage_records DELETE permission for this signed-in user.");
    }
    if (currentSession?.user?.id !== userId || stockWorkspaceId !== workspaceId)
      throw new Error("The signed-in account changed while deleting the record. Refresh and check the job history.");
    return true;
  }
};


window.__VSP_JOB_SITE_VISIT_STORE = {
  isReady() { return !!(currentSession?.user?.id && stockWorkspaceId && stockSyncReady); },
  async getAll() {
    if (!this.isReady()) throw new Error("Sign in and wait for cloud stock to finish loading.");
    const userId=currentSession.user.id, workspaceId=stockWorkspaceId;
    const {data,error}=await supabase.from("job_site_visits")
      .select("id,visit_date,job_reference,site_name,engineer_name,system_type,visit_notes,defects,follow_up,battery_type,battery_quantity,battery_installed_date,battery_due_date,intruder_battery_type,intruder_battery_other,intruder_battery_quantity,intruder_battery_installed_date,intruder_battery_due_date")
      .eq("workspace_id",workspaceId).eq("owner_user_id",userId)
      .order("visit_date",{ascending:false}).limit(5000);
    if(error){if(isNetworkFailure(error))return queuedRows("site_visit",workspaceId).map(row=>queuedDomain("site_visit",row));throw error;}
    if(currentSession?.user?.id!==userId||stockWorkspaceId!==workspaceId)throw new Error("The signed-in account changed while loading site history.");
    const cloud=(data||[]).map(row=>({
      id:row.id,date:row.visit_date,job:row.job_reference,siteName:row.site_name||"",
      engineer:row.engineer_name||"",systemType:row.system_type||"",
      notes:row.visit_notes||"",defects:row.defects||"",followUp:row.follow_up||"",batteryType:row.battery_type||"",batteryQuantity:row.battery_quantity??"",batteryInstalledDate:row.battery_installed_date||"",batteryDueDate:row.battery_due_date||"",intruderBatteryType:row.intruder_battery_type||"",intruderBatteryOther:row.intruder_battery_other||"",intruderBatteryQuantity:row.intruder_battery_quantity??"",intruderBatteryInstalledDate:row.intruder_battery_installed_date||"",intruderBatteryDueDate:row.intruder_battery_due_date||""
    }));
    return [...cloud,...queuedRows("site_visit",workspaceId).map(row=>queuedDomain("site_visit",row))];
  },
  async add(entry) {
    if(!this.isReady())throw new Error("Sign in and wait for cloud stock to finish loading before saving a site visit.");
    const userId=currentSession.user.id,workspaceId=stockWorkspaceId;
    const row={
      id:entry.id||crypto.randomUUID(),workspace_id:workspaceId,owner_user_id:userId,
      visit_date:entry.date||new Date().toISOString(),
      job_reference:String(entry.job||"").trim().slice(0,120),
      site_name:String(entry.siteName||"").trim().slice(0,160),
      engineer_name:String(entry.engineer||"").trim().slice(0,80),
      system_type:String(entry.systemType||"").trim().slice(0,80),
      visit_notes:String(entry.notes||"").trim().slice(0,4000),
      defects:String(entry.defects||"").trim().slice(0,2000),
      follow_up:String(entry.followUp||"").trim().slice(0,2000),
      battery_type:String(entry.batteryType||"").trim().slice(0,100),
      battery_quantity:entry.batteryQuantity===""||entry.batteryQuantity==null?null:Number(entry.batteryQuantity),
      battery_installed_date:entry.batteryInstalledDate||null,
      battery_due_date:entry.batteryDueDate||null,
      intruder_battery_type:String(entry.intruderBatteryType||"").trim().slice(0,100),
      intruder_battery_other:String(entry.intruderBatteryOther||"").trim().slice(0,100),
      intruder_battery_quantity:entry.intruderBatteryQuantity===""||entry.intruderBatteryQuantity==null?null:Number(entry.intruderBatteryQuantity),
      intruder_battery_installed_date:entry.intruderBatteryInstalledDate||null,
      intruder_battery_due_date:entry.intruderBatteryDueDate||null
    };
    if(!row.job_reference||!row.visit_notes)throw new Error("Enter a job/site reference and visit notes.");
    const data=await insertOrQueueOfflineRecord("site_visit","job_site_visits",row,"id,visit_date,job_reference,site_name,engineer_name,system_type,visit_notes,defects,follow_up,battery_type,battery_quantity,battery_installed_date,battery_due_date,intruder_battery_type,intruder_battery_other,intruder_battery_quantity,intruder_battery_installed_date,intruder_battery_due_date");
    if(!data)return queuedDomain("site_visit",row);
    if(currentSession?.user?.id!==userId||stockWorkspaceId!==workspaceId)throw new Error("The signed-in account changed while saving. Refresh before continuing.");
    return {id:data.id,date:data.visit_date,job:data.job_reference,siteName:data.site_name||"",engineer:data.engineer_name||"",systemType:data.system_type||"",notes:data.visit_notes||"",defects:data.defects||"",followUp:data.follow_up||"",batteryType:data.battery_type||"",batteryQuantity:data.battery_quantity??"",batteryInstalledDate:data.battery_installed_date||"",batteryDueDate:data.battery_due_date||"",intruderBatteryType:data.intruder_battery_type||"",intruderBatteryOther:data.intruder_battery_other||"",intruderBatteryQuantity:data.intruder_battery_quantity??"",intruderBatteryInstalledDate:data.intruder_battery_installed_date||"",intruderBatteryDueDate:data.intruder_battery_due_date||""};
  },
  async update(id,entry) {
    if(!this.isReady())throw new Error("Sign in and wait for cloud stock to finish loading before editing a site visit.");
    if(!id)throw new Error("The site visit ID is missing.");
    const userId=currentSession.user.id,workspaceId=stockWorkspaceId;
    const fields={
      visit_date:entry.date||new Date().toISOString(),
      job_reference:String(entry.job||"").trim().slice(0,120),
      site_name:String(entry.siteName||"").trim().slice(0,160),
      engineer_name:String(entry.engineer||"").trim().slice(0,80),
      system_type:String(entry.systemType||"").trim().slice(0,80),
      visit_notes:String(entry.notes||"").trim().slice(0,4000),
      defects:String(entry.defects||"").trim().slice(0,2000),
      follow_up:String(entry.followUp||"").trim().slice(0,2000),
      battery_type:String(entry.batteryType||"").trim().slice(0,100),
      battery_quantity:entry.batteryQuantity===""||entry.batteryQuantity==null?null:Number(entry.batteryQuantity),
      battery_installed_date:entry.batteryInstalledDate||null,
      battery_due_date:entry.batteryDueDate||null,
      intruder_battery_type:String(entry.intruderBatteryType||"").trim().slice(0,100),
      intruder_battery_other:String(entry.intruderBatteryOther||"").trim().slice(0,100),
      intruder_battery_quantity:entry.intruderBatteryQuantity===""||entry.intruderBatteryQuantity==null?null:Number(entry.intruderBatteryQuantity),
      intruder_battery_installed_date:entry.intruderBatteryInstalledDate||null,
      intruder_battery_due_date:entry.intruderBatteryDueDate||null
    };
    if(!fields.job_reference||!fields.visit_notes)throw new Error("Enter a job/site reference and visit notes.");
    const {data,error}=await supabase.from("job_site_visits").update(fields)
      .eq("id",id).eq("workspace_id",workspaceId).eq("owner_user_id",userId)
      .select("id,visit_date,job_reference,site_name,engineer_name,system_type,visit_notes,defects,follow_up,battery_type,battery_quantity,battery_installed_date,battery_due_date,intruder_battery_type,intruder_battery_other,intruder_battery_quantity,intruder_battery_installed_date,intruder_battery_due_date").single();
    if(error)throw error;
    if(currentSession?.user?.id!==userId||stockWorkspaceId!==workspaceId)throw new Error("The signed-in account changed while updating. Refresh before continuing.");
    if(!data?.id)throw new Error("Supabase did not confirm the updated site visit.");
    return {id:data.id,date:data.visit_date,job:data.job_reference,siteName:data.site_name||"",engineer:data.engineer_name||"",systemType:data.system_type||"",notes:data.visit_notes||"",defects:data.defects||"",followUp:data.follow_up||"",batteryType:data.battery_type||"",batteryQuantity:data.battery_quantity??"",batteryInstalledDate:data.battery_installed_date||"",batteryDueDate:data.battery_due_date||"",intruderBatteryType:data.intruder_battery_type||"",intruderBatteryOther:data.intruder_battery_other||"",intruderBatteryQuantity:data.intruder_battery_quantity??"",intruderBatteryInstalledDate:data.intruder_battery_installed_date||"",intruderBatteryDueDate:data.intruder_battery_due_date||""};
  },
  async removeBatteryRecord(id,system) {
    if(!this.isReady())throw new Error("Cloud account is not ready.");
    if(!id||!["fire","intruder"].includes(system))throw new Error("Invalid battery record.");
    const userId=currentSession.user.id,workspaceId=stockWorkspaceId;
    const fields=system==="fire"
      ?{battery_type:"",battery_quantity:null,battery_installed_date:null,battery_due_date:null}
      :{intruder_battery_type:"",intruder_battery_other:"",intruder_battery_quantity:null,intruder_battery_installed_date:null,intruder_battery_due_date:null};
    const {error}=await supabase.from("job_site_visits").update(fields)
      .eq("id",id).eq("workspace_id",workspaceId).eq("owner_user_id",userId);
    if(error)throw error;
    const {data,error:verifyError}=await supabase.from("job_site_visits")
      .select("id,battery_type,intruder_battery_type,intruder_battery_other")
      .eq("id",id).eq("workspace_id",workspaceId).eq("owner_user_id",userId).maybeSingle();
    if(verifyError)throw verifyError;
    if(!data)throw new Error("The site visit could not be verified after updating.");
    if(system==="fire"&&data.battery_type)throw new Error("The fire battery record was not cleared.");
    if(system==="intruder"&&(data.intruder_battery_type||data.intruder_battery_other))throw new Error("The intruder battery record was not cleared.");
    return true;
  },
  async remove(id) {
    if(!this.isReady())throw new Error("Cloud account is not ready.");
    const userId=currentSession.user.id,workspaceId=stockWorkspaceId;
    const {error}=await supabase.from("job_site_visits").delete().eq("id",id).eq("workspace_id",workspaceId).eq("owner_user_id",userId);
    if(error)throw error;
    const {data:remaining,error:verifyError}=await supabase.from("job_site_visits").select("id").eq("id",id).eq("workspace_id",workspaceId).eq("owner_user_id",userId).maybeSingle();
    if(verifyError)throw verifyError;
    if(remaining?.id)throw new Error("Supabase did not remove this visit. Check the delete policy.");
  }
};


window.__VSP_JOB_SITE_PHOTO_STORE = {
  isReady() { return !!(currentSession?.user?.id && stockWorkspaceId && stockSyncReady); },
  async getForVisit(visitId) {
    if(!this.isReady()) throw new Error("Sign in and wait for cloud stock to finish loading.");
    const userId=currentSession.user.id,workspaceId=stockWorkspaceId;
    const {data,error}=await supabase.from("job_site_visit_photos")
      .select("id,visit_id,file_path,original_name,mime_type,file_size,created_at")
      .eq("workspace_id",workspaceId).eq("owner_user_id",userId).eq("visit_id",visitId)
      .order("created_at",{ascending:true});
    if(error) throw error;
    if(currentSession?.user?.id!==userId||stockWorkspaceId!==workspaceId) throw new Error("The signed-in account changed while loading photographs.");
    const photos=[];
    for(const row of data||[]){
      const {data:signed,error:signedError}=await supabase.storage.from("job-site-photos").createSignedUrl(row.file_path,3600);
      if(signedError) throw signedError;
      photos.push({...row,url:signed?.signedUrl||""});
    }
    return photos;
  },
  async uploadForVisit(visitId,files) {
    if(!this.isReady()) throw new Error("Sign in and wait for cloud stock to finish loading before uploading photographs.");
    if(!visitId) throw new Error("Save the site visit before uploading photographs.");
    const selected=Array.from(files||[]);
    if(!selected.length) return [];
    if(selected.length>10) throw new Error("Choose no more than 10 photographs for one upload.");
    for(const file of selected){
      if(!["image/jpeg","image/png","image/webp"].includes(file.type)) throw new Error("Use JPG, PNG or WEBP photographs.");
      if(file.size<=0||file.size>5242880) throw new Error("Each photograph must be 5 MB or smaller.");
    }
    const userId=currentSession.user.id,workspaceId=stockWorkspaceId,uploaded=[];
    try{
      for(const file of selected){
        const extension=file.type==="image/png"?"png":file.type==="image/webp"?"webp":"jpg";
        const safeName=(String(file.name||"photo").replace(/[^a-zA-Z0-9._-]/g,"_").slice(-80)||"photo."+extension);
        const path=workspaceId+"/"+userId+"/"+visitId+"/"+crypto.randomUUID()+"-"+safeName;
        const {error:uploadError}=await supabase.storage.from("job-site-photos").upload(path,file,{contentType:file.type,upsert:false});
        if(uploadError) throw uploadError;
        const {data,error}=await supabase.from("job_site_visit_photos").insert({
          workspace_id:workspaceId,owner_user_id:userId,visit_id:visitId,file_path:path,
          original_name:String(file.name||safeName).slice(0,200),mime_type:file.type,file_size:file.size
        }).select("id,visit_id,file_path,original_name,mime_type,file_size,created_at").single();
        if(error){await supabase.storage.from("job-site-photos").remove([path]);throw error;}
        uploaded.push(data);
        if(currentSession?.user?.id!==userId||stockWorkspaceId!==workspaceId) throw new Error("The signed-in account changed while uploading photographs.");
      }
      const result=[];
      for(const row of uploaded){
        const {data:signed,error}=await supabase.storage.from("job-site-photos").createSignedUrl(row.file_path,3600);
        if(error) throw error;
        result.push({...row,url:signed?.signedUrl||""});
      }
      return result;
    }catch(error){
      for(const row of uploaded){
        try{await supabase.from("job_site_visit_photos").delete().eq("id",row.id).eq("workspace_id",workspaceId).eq("owner_user_id",userId)}catch(cleanupError){}
        try{await supabase.storage.from("job-site-photos").remove([row.file_path])}catch(cleanupError){}
      }
      throw error;
    }
  },
  async remove(photoId) {
    if(!this.isReady()) throw new Error("Cloud account is not ready.");
    const userId=currentSession.user.id,workspaceId=stockWorkspaceId;
    const {data,error}=await supabase.from("job_site_visit_photos")
      .select("id,file_path").eq("id",photoId).eq("workspace_id",workspaceId).eq("owner_user_id",userId).single();
    if(error) throw error;
    if(!data?.file_path) throw new Error("Could not find this photograph in your account.");
    const {error:deleteError}=await supabase.from("job_site_visit_photos").delete()
      .eq("id",photoId).eq("workspace_id",workspaceId).eq("owner_user_id",userId);
    if(deleteError) throw deleteError;
    const {error:storageError}=await supabase.storage.from("job-site-photos").remove([data.file_path]);
    if(storageError) throw new Error("Photo record removed, but its stored file could not be deleted: "+storageError.message);
    return true;
  }
};

window.__VSP_JOB_NOTE_TEMPLATE_STORE = {
 async getAll(){
  if(!currentSession?.user?.id)throw new Error("Sign in to load your private templates.");
  const values=currentSession.user.user_metadata?.vsp_job_note_templates;
  if(values==null)return [];
  if(!Array.isArray(values)||values.some(t=>!t||typeof t.id!=="string"||typeof t.name!=="string"||typeof t.body!=="string"))throw new Error("Your saved job note templates are invalid.");
  return values;
 },
 async save(template){
  if(!currentSession?.user?.id)throw new Error("Sign in to save private templates.");
  const list=await this.getAll(),id=template.id||("tpl_"+crypto.randomUUID());
  const name=String(template.name||"").trim().slice(0,50),body=String(template.body||"").trim().slice(0,1000);
  if(!name||!body)throw new Error("Enter a template name and notes.");
  const next=list.filter(t=>t.id!==id);
  if(next.length>=50)throw new Error("You can save up to 50 private templates.");
  next.push({id,name,body});
  const userId=currentSession.user.id;
  const {data,error}=await supabase.auth.updateUser({data:{vsp_job_note_templates:next}});
  if(error)throw error;
  if(currentSession?.user?.id!==userId||!data?.user)throw new Error("Your account changed while saving. Sign in again.");
  currentSession={...currentSession,user:data.user};return id;
 },
 async remove(id){
  if(!currentSession?.user?.id)throw new Error("Sign in to manage private templates.");
  const list=await this.getAll(),next=list.filter(t=>t.id!==id),userId=currentSession.user.id;
  const {data,error}=await supabase.auth.updateUser({data:{vsp_job_note_templates:next}});
  if(error)throw error;
  if(currentSession?.user?.id!==userId||!data?.user)throw new Error("Your account changed while deleting. Sign in again.");
  currentSession={...currentSession,user:data.user};return true;
 }
};

window.__VSP_CATEGORY_STORE = {
  async get() {
    if (!currentSession?.user) throw new Error("Sign in to load your categories.");
    const values = currentSession.user.user_metadata?.vsp_categories;
    if (values == null) return null;
    if (!Array.isArray(values) || values.some(value => typeof value !== "string")) {
      throw new Error("Your saved category list is invalid. No categories were changed.");
    }
    return values;
  },
  async save(categories) {
    if (!currentSession?.user) throw new Error("Sign in to save your categories.");
    if (!Array.isArray(categories) || !categories.length || categories.length > 50 ||
        categories.some(value => typeof value !== "string" || !value.trim() || value.length > 40)) {
      throw new Error("Use between 1 and 50 category names, each up to 40 characters.");
    }
    const userId = currentSession.user.id;
    const { data, error } = await supabase.auth.updateUser({
      data: { vsp_categories: categories.map(value => value.trim()) }
    });
    if (error) throw error;
    if (currentSession?.user?.id !== userId || !data?.user) {
      throw new Error("The signed-in account changed. Please sign in again before saving categories.");
    }
    currentSession = { ...currentSession, user: data.user };
    return true;
  }
};

supabase.auth.onAuthStateChange((event, session) => {
  setSession(session);
  // Supabase restores an existing login on page refresh using INITIAL_SESSION.
  // Load that account's cloud stock after the auth callback returns so refresh
  // never leaves the user looking at local starter/browser stock.
  if (event === "INITIAL_SESSION" && session?.user) {
    const userId = session.user.id;
    window.setTimeout(async () => {
      if (currentSession?.user?.id !== userId) return;
      try {
        const ready = await checkSchema();
        if (!ready || currentSession?.user?.id !== userId) return;
        await refreshAccessPanel();
        if (currentSession?.user?.id === userId) await initialiseCloudStock();
      } catch (error) {
        if (currentSession?.user?.id === userId) {
          stockSyncReady = false;
          message("CLOUD STOCK RELOAD FAILED — " + (error?.message || "Unknown error"), "error");
        }
      }
    }, 0);
  }
});

 
// Workspace access management. Uses the existing RLS-protected membership
// table and never exposes a Supabase service-role key in browser code.
const accessPanel = $("userAccessPanel");
const accessMessage = $("accessMessage");
const accessBody = $("accessMembersBody");
const accessRoleLabel = $("accessRoleLabel");
let activeWorkspaceId = null;
let activeWorkspaceRole = null;
function accessNotice(text, kind = "info") {
  if (!accessMessage) return;
  accessMessage.textContent = text;
  accessMessage.dataset.kind = kind;
}
function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
async function refreshAccessPanel() {
  if (!accessPanel || !currentSession?.user) {
    if (accessPanel) accessPanel.hidden = true;
    activeWorkspaceId = null; activeWorkspaceRole = null; return;
  }
  try {
    const userId = currentSession.user.id;
    const { data: mine, error: mineError } = await supabase.from("workspace_members")
      .select("workspace_id, role, created_at").eq("user_id", userId)
      .order("created_at", { ascending: true }).limit(50);
    if (mineError) throw mineError;
    if (!mine?.length) {
      accessPanel.hidden = true; activeWorkspaceId = null; activeWorkspaceRole = null; return;
    }
    const workspaceIds = [...new Set(mine.map(row => row.workspace_id))];
    const { data: workspaces, error: workspaceError } = await supabase.from("workspaces")
      .select("id, created_by").in("id", workspaceIds);
    if (workspaceError) throw workspaceError;
    const personal = (workspaces || []).find(row => row.created_by === userId);
    const personalMembership = personal ? mine.find(row => row.workspace_id === personal.id) : null;
    const selected = personalMembership && ["owner", "admin"].includes(personalMembership.role)
      ? personalMembership
      : mine.find(row => ["owner", "admin"].includes(row.role));
    if (!selected) {
      accessPanel.hidden = true; activeWorkspaceId = null;
      activeWorkspaceRole = mine[0]?.role || null; return;
    }
    activeWorkspaceId = selected.workspace_id;
    activeWorkspaceRole = selected.role;
    accessPanel.hidden = false;
    accessRoleLabel.textContent = selected.role.toUpperCase();
    const adminOption = $("accessRole")?.querySelector('option[value="admin"]');
    if (adminOption) adminOption.disabled = selected.role !== "owner";
    const { data: members, error: listError } = await supabase.from("workspace_members")
      .select("user_id, role, created_at").eq("workspace_id", activeWorkspaceId)
      .order("created_at", { ascending: true });
    if (listError) throw listError;
    accessBody.replaceChildren();
    for (const member of members || []) {
      const tr = document.createElement("tr");
      const idCell = document.createElement("td");
      idCell.textContent = member.user_id;
      idCell.style.cssText = "font-family:monospace;font-size:11px;overflow-wrap:anywhere";
      const roleCell = document.createElement("td"); roleCell.textContent = member.role;
      const dateCell = document.createElement("td");
      dateCell.textContent = member.created_at ? new Date(member.created_at).toLocaleDateString() : "—";
      const actionCell = document.createElement("td");
      if (member.user_id !== currentSession.user.id) {
        const remove = document.createElement("button");
        remove.type = "button"; remove.className = "danger smallbtn"; remove.textContent = "Remove";
        remove.addEventListener("click", () => removeWorkspaceMember(member.user_id, remove));
        actionCell.append(remove);
      } else actionCell.textContent = "You";
      tr.append(idCell, roleCell, dateCell, actionCell); accessBody.append(tr);
    }
    if (!members?.length) {
      const tr = document.createElement("tr"); const td = document.createElement("td");
      td.colSpan = 4; td.textContent = "No members found."; tr.append(td); accessBody.append(tr);
    }
    accessNotice("Workspace access loaded. " + (members?.length || 0) + " authorised account(s).", "success");
  } catch (error) {
    accessPanel.hidden = false;
    accessNotice("Could not load user access: " + (error?.message || "Unknown error") + ". Check the workspace_members table and its access policies.", "error");
  }
}
async function removeWorkspaceMember(userId, button) {
  if (!activeWorkspaceId || !confirm("Remove this account from Van Stock Pro? Their account remains, but they lose access to this workspace.")) return;
  button.disabled = true;
  try {
    const { error } = await supabase.from("workspace_members").delete()
      .eq("workspace_id", activeWorkspaceId).eq("user_id", userId);
    if (error) throw error;
    accessNotice("User access removed.", "success"); await refreshAccessPanel();
  } catch (error) {
    accessNotice("Could not remove this user: " + (error?.message || "Unknown error"), "error");
    button.disabled = false;
  }
}
$("accessAddUser")?.addEventListener("click", async () => {
  if (!activeWorkspaceId || !["owner", "admin"].includes(activeWorkspaceRole)) return;
  const userId = ($("accessUserId")?.value || "").trim();
  const role = $("accessRole")?.value || "member";
  if (!isUuid(userId)) return accessNotice("Enter a valid Supabase User ID (UUID).", "warning");
  if (userId === currentSession?.user?.id) return accessNotice("You are already a member of this workspace.", "warning");
  if (!["member", "viewer", "admin"].includes(role)) return accessNotice("Choose a valid permission level.", "warning");
  if (activeWorkspaceRole === "admin" && !["member", "viewer"].includes(role))
    return accessNotice("Admins can only authorise members or viewers.", "warning");
  const button = $("accessAddUser"); button.disabled = true;
  try {
    const { error } = await supabase.from("workspace_members").insert({
      workspace_id: activeWorkspaceId, user_id: userId, role
    });
    if (error) throw error;
    $("accessUserId").value = "";
    accessNotice("User authorised as " + role + ".", "success"); await refreshAccessPanel();
  } catch (error) {
    accessNotice("Could not authorise this user: " + (error?.message || "Check that the account exists and the database policies are installed."), "error");
  } finally { button.disabled = false; }
});

// Restore the saved session only after the access-management panel is initialised.
const { data: initial } = await supabase.auth.getSession();
setSession(initial.session);
if (initial.session) {
  const schemaReady = await checkSchema();
  if (schemaReady) {
    await refreshAccessPanel();
    await initialiseCloudStock();
  }
}

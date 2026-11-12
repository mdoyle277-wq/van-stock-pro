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
const INACTIVITY_LIMIT_MS = 2 * 60 * 1000;
let inactivityTimer = null;
function clearInactivityTimer() {
  if (inactivityTimer !== null) window.clearTimeout(inactivityTimer);
  inactivityTimer = null;
}
async function signOutForInactivity() {
  clearInactivityTimer();
  if (!currentSession?.user) return;
  message("Signed out after 2 minutes without keyboard activity. Sign in again to continue.", "warning");
  const { error } = await supabase.auth.signOut();
  if (error) message("Automatic sign-out failed: " + error.message, "error");
}
function resetInactivityTimer() {
  if (!currentSession?.user) return;
  clearInactivityTimer();
  inactivityTimer = window.setTimeout(signOutForInactivity, INACTIVITY_LIMIT_MS);
}
["keydown"].forEach((eventName) => {
  window.addEventListener(eventName, resetInactivityTimer, { passive: true });
});
function setSession(session) {
  const previousUserId = currentSession?.user?.id || null;
  const nextUserId = session?.user?.id || null;
  currentSession = session;
  if (previousUserId !== nextUserId) {
    // Preserve a local snapshot for recovery, but never display or upload it
    // as the next account's stock: browsers can be shared between accounts.
    try {
      const cached = localStorage.getItem("van-stock-pro-items-v1");
      const cachedItems = cached ? JSON.parse(cached) : null;
      // Never replace a non-empty account archive with the empty list written
      // while switching accounts.
      if (Array.isArray(cachedItems) && cachedItems.length) {
        const archiveKey = "van-stock-pro-isolated-cache-" + (previousUserId || nextUserId || "unassigned");
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
  if (session?.user) resetInactivityTimer();
  else clearInactivityTimer();
  const user = session?.user;
  sessionLabel.textContent = user ? "Signed in as " + user.email : "Not signed in";
  signInButton.hidden = !!user;
  signUpButton.hidden = !!user;
  signOutButton.hidden = !user;
  setupButton.hidden = !user;
  previewButton.hidden = !user;
  email.disabled = !!user;
  password.disabled = !!user;
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
  const membership = personal
    ? memberships.find(row => row.workspace_id === personal.id)
    : memberships.find(row => row.role !== "viewer");
  if (!membership) throw new Error("This account has view-only access and cannot change stock.");
  return { id: membership.workspace_id, role: membership.role };
}
async function writeCloudStock(items) {
  if (!stockWorkspaceId || !currentSession?.user) throw new Error("Cloud workspace is not ready.");
  if (!Array.isArray(items)) throw new Error("Local stock is not a valid item list.");
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
    const { data: cloudRows, error } = await supabase.from("stock_items")
      .select("*").eq("workspace_id", stockWorkspaceId).eq("owner_user_id", userId)
      .order("name", { ascending: true });
    if (error) throw error;
    if (currentSession?.user?.id !== userId) return;
    const cloudItems = stockRowsToItems(cloudRows || []);
    if (typeof window.__VSP_APPLY_CLOUD_STOCK !== "function") throw new Error("Stock screen is not ready to receive cloud data.");
    if (cloudItems.length) {
      window.__VSP_APPLY_CLOUD_STOCK(cloudItems);
      message("Your private cloud stock loaded and verified: " + cloudItems.length + " item(s).", "success");
    } else if (workspace.role === "owner") {
      // Import only the cache archived for this exact account on sign-in.
      // Never read the shared browser stock key for a newly invited user.
      const local = readLocalArray("van-stock-pro-isolated-cache-" + userId);
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
    }
  } catch (error) {
    if (currentSession?.user?.id === userId) {
      stockSyncReady = false;
      clearCloudLoadingWithEmptyStock();
      message("CLOUD STOCK NOT READY — local data has been left untouched. " + (error?.message || "Unknown sync error"), "error");
    }
  }
}
async function runStockSync() {
  if (!stockSyncReady || !currentSession?.user || !stockWorkspaceId) return;
  if (stockSyncBusy) { stockSyncAgain = true; return; }
  stockSyncBusy = true;
  const userId = currentSession.user.id;
  const workspaceId = stockWorkspaceId;
  try {
    const raw = localStorage.getItem("van-stock-pro-items-v1");
    const items = raw == null ? [] : JSON.parse(raw);
    if (!Array.isArray(items)) throw new Error("Saved local stock is not a valid list.");
    await writeCloudStock(items);
    if (currentSession?.user?.id !== userId || stockWorkspaceId !== workspaceId) return;
    message("Cloud stock saved and verified: " + items.length + " item(s).", "success");
  } catch (error) {
    if (currentSession?.user?.id === userId) {
      message("CLOUD SAVE FAILED — your local stock is still on this device. " + (error?.message || "Unknown sync error"), "error");
    }
  } finally {
    stockSyncBusy = false;
    if (stockSyncAgain && stockSyncReady) { stockSyncAgain = false; runStockSync(); }
    else stockSyncAgain = false;
  }
}
window.addEventListener("vsp:stock-changed", () => {
  if (!stockSyncReady) return;
  if (stockSyncTimer) window.clearTimeout(stockSyncTimer);
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
    const { data: mine, error: mineError } = await supabase.from("workspace_members")
      .select("workspace_id, role").eq("user_id", currentSession.user.id)
      .order("created_at", { ascending: true }).limit(1);
    if (mineError) throw mineError;
    if (!mine?.length || !["owner", "admin"].includes(mine[0].role)) {
      accessPanel.hidden = true; activeWorkspaceId = null;
      activeWorkspaceRole = mine?.[0]?.role || null; return;
    }
    activeWorkspaceId = mine[0].workspace_id;
    activeWorkspaceRole = mine[0].role;
    accessPanel.hidden = false;
    accessRoleLabel.textContent = mine[0].role.toUpperCase();
    const adminOption = $("accessRole")?.querySelector('option[value="admin"]');
    if (adminOption) adminOption.disabled = mine[0].role !== "owner";
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

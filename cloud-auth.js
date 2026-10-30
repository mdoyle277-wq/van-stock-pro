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
const importButton = $("cloudImport");
const previewResult = $("cloudPreviewResult");
let currentSession = null;

function message(text, kind = "info") {
  if (!status) return;
  status.textContent = text;
  status.dataset.kind = kind;
}
function setSession(session) {
  currentSession = session;
  const user = session?.user;
  sessionLabel.textContent = user ? "Signed in as " + user.email : "Not signed in";
  signInButton.hidden = !!user;
  signUpButton.hidden = !!user;
  signOutButton.hidden = !user;
  setupButton.hidden = !user;
  previewButton.hidden = !user;
  if (importButton) importButton.hidden = !user;
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
      await checkSchema();
    }
  } catch (error) {
    message(error?.message || "Authentication failed.", "error");
  } finally {
    signInButton.disabled = signUpButton.disabled = false;
  }
}
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

async function importLocalStockToCloud() {
  if (!currentSession?.user) return message("Sign in first. No data was changed.", "warning");
  importButton.disabled = true;
  try {
    const ready = await checkSchema();
    if (!ready) throw new Error("Supabase schema check failed. No stock was uploaded.");
    const { data: workspaceData, error: workspaceError } = await supabase.rpc("ensure_default_workspace");
    if (workspaceError) throw workspaceError;
    const workspace = Array.isArray(workspaceData) ? workspaceData[0] : workspaceData;
    if (!workspace?.result_workspace_id || workspace.result_role !== "owner") {
      throw new Error("An owner workspace could not be confirmed. No stock was uploaded.");
    }
    const stock = readLocalArray("van-stock-pro-items-v1");
    if (!stock.length) throw new Error("No local stock items found. Nothing uploaded.");
    const invalid = stock.filter(i => !i || i.id === undefined || typeof i.name !== "string" || !Number.isFinite(Number(i.qty)) || !Number.isFinite(Number(i.minQty ?? 0)));
    if (invalid.length) throw new Error(invalid.length + " invalid item(s) found. No stock was uploaded.");
    const rows = stock.map(i => ({
      workspace_id: workspace.result_workspace_id,
      legacy_id: String(i.id),
      name: i.name,
      sku: String(i.sku || ""),
      barcode: String(i.barcode || ""),
      category: String(i.category || ""),
      qty: Number(i.qty),
      min_qty: Number(i.minQty ?? 0),
      max_qty: i.maxQty === "" || i.maxQty === undefined || i.maxQty === null ? null : Number(i.maxQty),
      location: String(i.location || ""),
      supplier: String(i.supplier || ""),
      supplier_url: String(i.supplierUrl || ""),
      photo_path: null,
      notes: String(i.notes || "")
    }));
    for (let start = 0; start < rows.length; start += 100) {
      const batch = rows.slice(start, start + 100);
      const { error } = await supabase.from("stock_items").upsert(batch, { onConflict: "workspace_id,legacy_id" });
      if (error) throw new Error("Upload stopped at batch " + (Math.floor(start / 100) + 1) + ": " + error.message + ". Some earlier batches may have uploaded; rerun safely after checking cloud stock.");
    }
    const { data: cloudRows, error: verifyError } = await supabase.from("stock_items")
      .select("legacy_id,name,qty,min_qty,max_qty")
      .eq("workspace_id", workspace.result_workspace_id);
    if (verifyError) throw new Error("Upload may have completed, but cloud verification failed: " + verifyError.message);
    const byId = new Map((cloudRows || []).map(i => [String(i.legacy_id), i]));
    const mismatches = rows.filter(i => {
      const saved = byId.get(i.legacy_id);
      return !saved || saved.name !== i.name || Number(saved.qty) !== i.qty || Number(saved.min_qty) !== i.min_qty ||
        (i.max_qty === null ? saved.max_qty !== null : Number(saved.max_qty) !== i.max_qty);
    });
    if (mismatches.length) throw new Error("Verification failed for " + mismatches.length + " item(s). Do not switch the live app to cloud yet.");
    message("SUCCESS — verified " + rows.length + " local stock items against Supabase. Local stock was not changed. Photos and movement/job/order history were not imported; cloud app-wide syncing is not yet complete.", "success");
    if (previewResult) {
      previewResult.hidden = false;
      previewResult.textContent = "Cloud verification passed: " + rows.length + " stock items match local IDs, names, quantities and min/max values. Photos and history remain local.";
    }
  } catch (error) {
    message(error?.message || "Stock import failed. Keep the local app and backup unchanged.", "error");
  } finally {
    importButton.disabled = false;
  }
}

previewButton.addEventListener("click", previewLocalMigration);
if (importButton) importButton.addEventListener("click", () => {
  const confirmPanel = $("cloudImportConfirm");
  if (confirmPanel) {
    confirmPanel.hidden = false;
    confirmPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    message("Review the confirmation below. No stock has been uploaded yet.", "warning");
  } else {
    message("Import confirmation panel is missing. No stock was uploaded.", "error");
  }
});
$("cloudImportConfirmYes")?.addEventListener("click", async () => {
  $("cloudImportConfirm").hidden = true;
  await importLocalStockToCloud();
});
$("cloudImportConfirmNo")?.addEventListener("click", () => {
  $("cloudImportConfirm").hidden = true;
  message("Import cancelled. No stock was uploaded or changed.", "info");
});
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
    const { data, error } = await supabase.rpc("ensure_default_workspace");
    if (error) {
      if (/ensure_default_workspace|schema cache|could not find the function/i.test(error.message || "")) {
        throw new Error("The safe workspace setup SQL has not been installed yet. Run supabase/workspace-hardening.sql in Supabase SQL Editor, then retry. No stock data was uploaded.");
      }
      throw error;
    }
    const result = Array.isArray(data) ? data[0] : data;
    if (!result?.result_workspace_id) {
      throw new Error("Supabase did not return a workspace confirmation. No stock data was uploaded; review the workspace membership before retrying.");
    }
    if (result.result_role !== "owner") {
      message("Existing workspace membership confirmed with role " + result.result_role + ". No owner privileges were granted and no stock data was uploaded.", "warning");
      return;
    }
    message(
      result.created_now
        ? "Van Stock Pro workspace and owner membership created and confirmed. No stock data was uploaded or changed."
        : "Van Stock Pro workspace and owner membership confirmed (existing workspace reused where possible). No stock data was uploaded or changed.",
      "success"
    );
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
if (initial.session) await checkSchema();

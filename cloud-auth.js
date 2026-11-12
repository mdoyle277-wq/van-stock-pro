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
const importBackupConfirmed = $("cloudImportBackupConfirmed");
const importConfirmYes = $("cloudImportConfirmYes");
if (importBackupConfirmed && importConfirmYes) {
  importConfirmYes.disabled = true;
  importBackupConfirmed.addEventListener("change", () => {
    importConfirmYes.disabled = !importBackupConfirmed.checked;
  });
}
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
  if (!importBackupConfirmed?.checked) {
    return message("Download and check a fresh full data backup from this phone before importing. No stock was uploaded.", "warning");
  }

  importButton.disabled = true;
  importConfirmYes.disabled = true;
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

    const seenIds = new Set();
    const invalid = stock.filter(item => {
      if (!item || item.id === undefined || typeof item.name !== "string" || !item.name.trim()) return true;
      const qty = Number(item.qty);
      const min = Number(item.minQty ?? 0);
      const max = item.maxQty === "" || item.maxQty === undefined || item.maxQty === null ? null : Number(item.maxQty);
      if (!Number.isFinite(qty) || qty < 0 || !Number.isFinite(min) || min < 0) return true;
      if (max !== null && (!Number.isFinite(max) || max < min)) return true;
      const id = String(item.id);
      if (seenIds.has(id)) return true;
      seenIds.add(id);
      return false;
    });
    if (invalid.length) {
      throw new Error(invalid.length + " invalid or duplicate item(s) found. No stock was uploaded.");
    }

    const rows = stock.map(item => ({
      workspace_id: workspace.result_workspace_id,
      legacy_id: String(item.id),
      name: item.name.trim(),
      sku: String(item.sku || ""),
      barcode: String(item.barcode || ""),
      category: String(item.category || ""),
      qty: Number(item.qty),
      min_qty: Number(item.minQty ?? 0),
      max_qty: item.maxQty === "" || item.maxQty === undefined || item.maxQty === null ? null : Number(item.maxQty),
      location: String(item.location || ""),
      supplier: String(item.supplier || ""),
      supplier_url: String(item.supplierUrl || ""),
      photo_path: null,
      notes: String(item.notes || "")
    }));

    const existingActiveIds = new Set();
    const tombstonedIds = new Set();
    const rowsToInsert = new Map();

    for (let start = 0; start < rows.length; start += 100) {
      const batch = rows.slice(start, start + 100);
      const ids = batch.map(row => row.legacy_id);
      const { data: existingRows, error: lookupError } = await supabase
        .from("stock_items")
        .select("legacy_id,deleted_at")
        .eq("workspace_id", workspace.result_workspace_id)
        .in("legacy_id", ids);
      if (lookupError) {
        throw new Error("Could not safely check existing cloud IDs before import: " + lookupError.message + ". No batch was uploaded.");
      }

      const existingById = new Map((existingRows || []).map(row => [String(row.legacy_id), row]));
      for (const existing of existingRows || []) {
        const id = String(existing.legacy_id);
        if (existing.deleted_at) tombstonedIds.add(id);
        else existingActiveIds.add(id);
      }

      const missing = batch.filter(row => !existingById.has(row.legacy_id));
      if (!missing.length) continue;

      // Insert-only upsert: a duplicate ID is ignored, never updated.
      const { error } = await supabase.from("stock_items").upsert(missing, {
        onConflict: "workspace_id,legacy_id",
        ignoreDuplicates: true
      });
      if (error) {
        throw new Error(
          "Insert-only import stopped at batch " + (Math.floor(start / 100) + 1) +
          ": " + error.message + ". Some earlier missing items may have been inserted; rerun safely after reviewing the preview."
        );
      }
      for (const row of missing) rowsToInsert.set(row.legacy_id, row);
    }

    const verifiedRows = [];
    for (let start = 0; start < rows.length; start += 100) {
      const ids = rows.slice(start, start + 100).map(row => row.legacy_id);
      const { data, error } = await supabase.from("stock_items")
        .select("legacy_id,deleted_at,name,sku,barcode,category,qty,min_qty,max_qty,location,supplier,supplier_url,notes")
        .eq("workspace_id", workspace.result_workspace_id)
        .in("legacy_id", ids);
      if (error) throw new Error("Import may have inserted some missing items, but verification failed: " + error.message);
      verifiedRows.push(...(data || []));
    }

    const activeById = new Map();
    for (const row of verifiedRows) {
      const id = String(row.legacy_id);
      if (row.deleted_at) tombstonedIds.add(id);
      else activeById.set(id, row);
    }

    const missingIds = rows.filter(row => !activeById.has(row.legacy_id) && !tombstonedIds.has(row.legacy_id));
    if (missingIds.length) {
      throw new Error(
        "Verification incomplete: " + missingIds.length + " item ID(s) are not active in the cloud. " +
        "No local stock was changed. Review the database before retrying."
      );
    }

    const matchesInsertedRow = (saved, expected) => {
      const sameText = (a, b) => String(a ?? "") === String(b ?? "");
      const sameNumber = (a, b) => Number(a ?? 0) === Number(b ?? 0);
      const savedMax = saved.max_qty == null ? null : Number(saved.max_qty);
      const expectedMax = expected.max_qty == null ? null : Number(expected.max_qty);
      return sameText(saved.name, expected.name) &&
        sameText(saved.sku, expected.sku) &&
        sameText(saved.barcode, expected.barcode) &&
        sameText(saved.category, expected.category) &&
        sameNumber(saved.qty, expected.qty) &&
        sameNumber(saved.min_qty, expected.min_qty) &&
        savedMax === expectedMax &&
        sameText(saved.location, expected.location) &&
        sameText(saved.supplier, expected.supplier) &&
        sameText(saved.supplier_url, expected.supplier_url) &&
        sameText(saved.notes, expected.notes);
    };

    const mismatches = [...rowsToInsert.values()].filter(expected => {
      const saved = activeById.get(expected.legacy_id);
      return saved && !matchesInsertedRow(saved, expected);
    });
    if (mismatches.length) {
      throw new Error(
        "Verification found " + mismatches.length + " insert conflict(s). Existing cloud rows were not overwritten. " +
        "Review those IDs before retrying."
      );
    }

    const insertedVerified = [...rowsToInsert.keys()].filter(id => {
      const saved = activeById.get(id);
      const expected = rowsToInsert.get(id);
      return saved && matchesInsertedRow(saved, expected);
    }).length;

    message(
      "IMPORT VERIFIED — " + rows.length + " local IDs checked. " +
      insertedVerified + " missing item(s) inserted and verified; " +
      existingActiveIds.size + " existing active cloud item(s) preserved without overwrite; " +
      tombstonedIds.size + " deleted cloud item(s) left deleted. " +
      "Local stock was not changed. Photos and movement/job/order history remain device-local.",
      "success"
    );
    if (previewResult) {
      previewResult.hidden = false;
      previewResult.textContent =
        "Insert-only cloud import verified. Existing active records were preserved, deleted records were not restored, and local stock was unchanged.";
    }
    importBackupConfirmed.checked = false;
    importConfirmYes.disabled = true;
  } catch (error) {
    message(
      (error?.message || "Stock import failed.") +
      " Local stock and existing cloud rows were not intentionally overwritten. If a batch completed before an error, rerunning this insert-only import will skip IDs already present.",
      "error"
    );
  } finally {
    importButton.disabled = false;
    importConfirmYes.disabled = !importBackupConfirmed?.checked;
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
  if (importBackupConfirmed) importBackupConfirmed.checked = false;
  if (importConfirmYes) importConfirmYes.disabled = true;
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

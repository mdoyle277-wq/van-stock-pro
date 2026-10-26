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
      message("Workspace is ready. Your local stock has not been migrated. The next step is a reviewed import preview.", "success");
      return;
    }
    const { data: owned, error: ownedError } = await supabase.from("workspaces").select("id").eq("created_by", uid).order("created_at", { ascending: true }).limit(1);
    if (ownedError) throw ownedError;
    let workspace = owned?.[0];
    if (!workspace) {
      const { data, error } = await supabase.from("workspaces").insert({ name: "Van Stock Pro", created_by: uid }).select("id").single();
      if (error) throw error;
      workspace = data;
    }
    const { error: membershipError } = await supabase.from("workspace_members").insert({
      workspace_id: workspace.id, user_id: uid, role: "owner"
    });
    if (membershipError) {
      // Keep the created workspace for diagnosis; do not delete anything automatically.
      throw new Error("Workspace was created but owner membership did not finish: " + membershipError.message);
    }
    message("Van Stock Pro workspace created. No stock data was uploaded or changed. Next: build and test the backup import preview.", "success");
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

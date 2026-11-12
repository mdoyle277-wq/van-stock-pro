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
  currentSession = session;
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
      if (data.session) { await refreshWorkspaceStock(); await refreshAccessPanel(); }
      message(data.session
        ? "Account created and signed in. Next, initialise your Van Stock Pro workspace."
        : "Account created. Check your email to confirm the account, then sign in here.");
    } else {
      const { data, error } = await supabase.auth.signInWithPassword({ email: mail, password: pass });
      if (error) throw error;
      setSession(data.session);
      message("Signed in. Checking your workspace setup…");
      const schemaReady = await checkSchema();
      if (schemaReady) { await refreshWorkspaceStock(); await refreshAccessPanel(); }
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
    window.VSP_CLOUD_READY=false; window.VSP_CLOUD_SAVE=null; document.body.classList.add("cloud-loading");
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
      await refreshWorkspaceStock();
      message("Workspace is ready. Your stock is loaded from your own workspace.", "success");
      await refreshAccessPanel();
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
    await refreshWorkspaceStock();
    message("Your empty Van Stock Pro workspace is ready. Administrator stock has not been copied into it.", "success");
    await refreshAccessPanel();
  } catch (error) {
    message(error?.message || "Workspace setup failed.", "error");
  } finally {
    setupButton.disabled = false;
  }
});
supabase.auth.onAuthStateChange((_event, session) => {
  setSession(session);
});

 
// Workspace access management. Uses the existing RLS-protected membership
// table and never exposes a Supabase service-role key in browser code.
const accessPanel = $("userAccessPanel");
const accessMessage = $("accessMessage");
const accessBody = $("accessMembersBody");
const accessRoleLabel = $("accessRoleLabel");
let activeWorkspaceId = null;
let activeWorkspaceRole = null;
let knownCloudLegacyIds = new Set();
let cloudSaveQueue = Promise.resolve();

function cloudRowToItem(row) {
  return { id:String(row.legacy_id ?? row.id), name:row.name||"", sku:row.sku||"",
    barcode:row.barcode||"", category:row.category||"Other", qty:Number(row.qty||0),
    minQty:Number(row.min_qty||0), maxQty:row.max_qty==null?null:Number(row.max_qty),
    location:row.location||"", supplier:row.supplier||"", supplierUrl:row.supplier_url||"", photo:"" };
}
async function refreshWorkspaceStock() {
  document.body.classList.add("cloud-loading");
  window.VSP_CLOUD_READY=false; window.VSP_CLOUD_SAVE=null;
  if (!currentSession?.user) {
    activeWorkspaceId=null; activeWorkspaceRole=null; knownCloudLegacyIds=new Set();
    window.VSP_SET_ITEMS?.([]); document.body.classList.remove("cloud-loading"); return;
  }
  const {data:memberships,error:memberErr}=await supabase.from("workspace_members")
    .select("workspace_id,role,created_at").eq("user_id",currentSession.user.id)
    .order("created_at",{ascending:true}).limit(10);
  if(memberErr) throw memberErr;
  const membership=(memberships||[]).find(m=>["owner","admin","member","viewer"].includes(m.role));
  if(!membership) {
    activeWorkspaceId=null; activeWorkspaceRole=null; knownCloudLegacyIds=new Set();
    window.VSP_SET_ITEMS?.([]);
    message("Your account is signed in, but it has no workspace yet. Tap Set up workspace to create your own empty stock area. Administrator stock will not be copied into it.","success");
    document.body.classList.remove("cloud-loading"); return;
  }
  activeWorkspaceId=membership.workspace_id; activeWorkspaceRole=membership.role;
  const {data:workspace,error:wsErr}=await supabase.from("workspaces")
    .select("id,name").eq("id",activeWorkspaceId).maybeSingle();
  if(wsErr) throw wsErr;
  const {data:rows,error:stockErr}=await supabase.from("stock_items")
    .select("*").eq("workspace_id",activeWorkspaceId).order("name",{ascending:true}).range(0,999);
  if(stockErr) throw stockErr;
  const items=(rows||[]).map(cloudRowToItem);
  knownCloudLegacyIds=new Set(items.map(item=>String(item.id)));
  window.VSP_ACTIVE_USER_KEY="van-stock-pro-items-user-"+currentSession.user.id;
  window.VSP_SET_ITEMS?.(items);
  window.VSP_CLOUD_SAVE=(nextItems)=>{
    if(!activeWorkspaceId||activeWorkspaceRole==="viewer") throw new Error("This account has read-only stock access.");
    const workspaceId=activeWorkspaceId, next=Array.isArray(nextItems)?nextItems:[];
    const nextIds=new Set(next.map(item=>String(item.id)));
    const payload=next.map(item=>({workspace_id:workspaceId,legacy_id:String(item.id),
      name:String(item.name||"").trim(),sku:String(item.sku||""),barcode:String(item.barcode||""),
      category:String(item.category||"Other"),qty:Number(item.qty||0),min_qty:Number(item.minQty||0),
      max_qty:item.maxQty==null||item.maxQty===""?null:Number(item.maxQty),
      location:String(item.location||""),supplier:String(item.supplier||""),
      supplier_url:String(item.supplierUrl||""),notes:String(item.notes||item.description||"")}));
    cloudSaveQueue=cloudSaveQueue.then(async()=>{
      for(let i=0;i<payload.length;i+=50){
        const {error}=await supabase.from("stock_items").upsert(payload.slice(i,i+50),{onConflict:"workspace_id,legacy_id"});
        if(error) throw error;
      }
      const removed=[...knownCloudLegacyIds].filter(id=>!nextIds.has(id));
      for(let i=0;i<removed.length;i+=100){
        const {error}=await supabase.from("stock_items").delete().eq("workspace_id",workspaceId).in("legacy_id",removed.slice(i,i+100));
        if(error) throw error;
      }
      knownCloudLegacyIds=nextIds; return true;
    });
    return cloudSaveQueue;
  };
  window.VSP_CLOUD_READY=true;
  message("Workspace: "+(workspace?.name||"Van Stock Pro")+". Loaded "+items.length+" stock item(s) for your account only.","success");
  document.body.classList.remove("cloud-loading");
  if(activeWorkspaceRole==="viewer") document.querySelectorAll("#entryPanel input,#entryPanel select,#entryPanel button,#stockPanel [data-adjust],#stockPanel [data-edit],#stockPanel [data-usejob]").forEach(el=>{el.disabled=true;});
}
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
  if (schemaReady) { try { await refreshWorkspaceStock(); await refreshAccessPanel(); } catch (error) { message("Could not safely load your workspace stock: " + (error?.message || "Unknown error") + ". The stock screen remains locked to prevent another user's data appearing.", "error"); } }
} else { document.body.classList.remove("cloud-loading"); }

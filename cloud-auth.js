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
  const previousUserId = currentSession?.user?.id || null;
  const nextUserId = session?.user?.id || null;
  currentSession = session;
  if (previousUserId !== nextUserId) {
    activeStockWorkspaceId = null;
    activeWorkspaceId = null; activeWorkspaceRole = null;
    document.body.classList.add("cloud-loading");
    workspaceImport.hidden = true;
    window.VSP_STOCK_BRIDGE?.setItems([]);
    try { localStorage.setItem("van-stock-pro-movements-v2","[]"); localStorage.setItem("van-stock-pro-usage-v1","[]"); } catch {}
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
    if (workspaceError.code === "42P01" || /relation .* does not exist|schema cache/i.test(workspaceError.message || "")) {
      message("Your Supabase project is reachable, but the Van Stock Pro database schema has not been installed yet. Install the schema before using cloud stock.", "warning");
    } else if (workspaceError.code === "PGRST301" || workspaceError.code === "42501") {
      message("Signed in, but database access is not ready. Check the Van Stock Pro schema and row-level security policies.", "warning");
    } else {
      message("Connected to Supabase, but the workspace check failed: " + workspaceError.message, "warning");
    }
    return false;
  }
  // Fail before allowing a user to add cloud stock if the ownership migration
  // (including the composite upsert key) has not been installed.
  const { error: stockError } = await supabase.from("stock_items")
    .select("id,workspace_id,owner_user_id,legacy_id").limit(1);
  if (stockError) {
    const detail = stockError.message || "Unknown stock schema error";
    if (/owner_user_id|legacy_id|column .* does not exist|schema cache/i.test(detail)) {
      message("Cloud stock is not ready: the per-user stock ownership migration has not been applied. In GitHub open supabase/migrations/20261112_user_stock_cloud_sync.sql, copy the full SQL into Supabase SQL Editor and run it. Existing stock is retained; do not run any reset or delete script.", "error");
    } else {
      message("Cloud stock schema check failed: " + detail + ". No cloud stock has been changed.", "error");
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
      if (data.session) await refreshAccessPanel();
      message(data.session
        ? "Account created and signed in. Next, initialise your Van Stock Pro workspace."
        : "Account created. Check your email to confirm the account, then sign in here.");
    } else {
      const { data, error } = await supabase.auth.signInWithPassword({ email: mail, password: pass });
      if (error) throw error;
      setSession(data.session);
      message("Signed in. Checking your workspace setup…");
      const schemaReady = await checkSchema();
      if (schemaReady) { await refreshAccessPanel(); await loadWorkspaceStock(); }
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

// Workspace stock isolation and synchronisation.
let activeStockWorkspaceId = null;
let stockQueue = Promise.resolve();
let workspaceImportAllowed = false;
const workspaceImport = document.createElement("button");
workspaceImport.type = "button"; workspaceImport.className = "secondary";
workspaceImport.textContent = "Import this device's existing stock into this workspace";
workspaceImport.hidden = true; workspaceImport.style.marginTop = "10px";
status?.insertAdjacentElement("afterend", workspaceImport);
const STOCK_KEY = "van-stock-pro-items-v1";
function cloudStockMessage(t,k="info"){ message(t,k); }
function stockToRow(item, workspaceId, userId, photoPath=null) {
 return {workspace_id:workspaceId,owner_user_id:userId,legacy_id:String(item.id),name:String(item.name||"Unnamed item"),sku:String(item.sku||""),barcode:String(item.barcode||""),category:String(item.category||""),qty:Number(item.qty)||0,min_qty:Number(item.minQty)||0,max_qty:item.maxQty==null||item.maxQty===""?null:Number(item.maxQty),location:String(item.location||""),supplier:String(item.supplier||""),supplier_url:String(item.supplierUrl||""),notes:String(item.notes||""),photo_path:photoPath};
}
function decodePhoto(dataUrl){
 const m=String(dataUrl||"").match(/^data:(image\/(?:jpeg|png|webp));base64,([\s\S]+)$/i);
 if(!m) return null;
 const bytes=Uint8Array.from(atob(m[2]),c=>c.charCodeAt(0));
 return {blob:new Blob([bytes],{type:m[1]}),ext:m[1].split("/")[1]==="jpeg"?"jpg":m[1].split("/")[1]};
}
async function uploadItemPhoto(item,workspaceId){
 if(!item.photo || !String(item.photo).startsWith("data:")) return null;
 const parsed=decodePhoto(item.photo);
 if(!parsed) throw new Error("An item photo is not a supported JPEG, PNG or WebP image. No stock sync was completed.");
 if(parsed.blob.size>5*1024*1024) throw new Error("Photo for "+item.name+" is over the 5 MB cloud limit. Reduce the photo size first.");
 const path=workspaceId+"/"+encodeURIComponent(String(item.id))+"."+parsed.ext;
 const {error}=await supabase.storage.from("van-stock-item-photos").upload(path,parsed.blob,{upsert:true,contentType:parsed.blob.type});
 if(error) throw error;
 return path;
}
async function syncWorkspaceItems(list,workspaceId=activeStockWorkspaceId,expectedUserId=currentSession?.user?.id){
 const userId=currentSession?.user?.id;
 if(!Array.isArray(list)) throw new Error("Stock save event did not contain a valid item list.");
 if(!workspaceId) throw new Error("No personal workspace is active for this account. Tap Set up workspace, finish setup, then retry the save.");
 if(!expectedUserId||!userId||userId!==expectedUserId) throw new Error("The signed-in account changed before the stock save completed. Sign in again and retry.");
 if(activeStockWorkspaceId!==workspaceId) throw new Error("The active workspace changed before the stock save completed. Reload the workspace and retry.");
 const {data:existing,error:readError}=await supabase.from("stock_items").select("id,legacy_id,photo_path").eq("workspace_id",workspaceId).eq("owner_user_id",userId);
 if(readError)throw readError;
 const oldById=new Map((existing||[]).map(row=>[String(row.legacy_id),row]));
 const rows=[];
 for(const item of list){
  const old=oldById.get(String(item.id));
  const photoPath=item.photo ? (await uploadItemPhoto(item,workspaceId) || old?.photo_path || null) : null;
  rows.push(stockToRow(item,workspaceId,userId,photoPath));
 }
 if(rows.length){const {error}=await supabase.from("stock_items").upsert(rows,{onConflict:"workspace_id,owner_user_id,legacy_id"});if(error)throw error;}
 // Only reconcile rows inside this workspace; preserve records if deletion permission is denied.
 if(readError)throw readError;
 const keep=new Set(list.map(x=>String(x.id)));
 for(const row of existing||[]) if(!keep.has(String(row.legacy_id))){
  const {error}=await supabase.from("stock_items").delete().eq("workspace_id",workspaceId).eq("owner_user_id",userId).eq("id",row.id);
  if(error)throw new Error("Stock saved, but removed items could not be deleted under the current workspace permissions: "+error.message);
 }
 cloudStockMessage("Cloud stock saved: "+list.length+" item(s).","success");
}
async function loadWorkspaceStock(){
 if(!currentSession?.user)return;
 const userId=currentSession.user.id;
 document.body.classList.add("cloud-loading");
 const {data:members,error:me}=await supabase.from("workspace_members")
   .select("workspace_id,role,created_at").eq("user_id",userId)
   .order("created_at",{ascending:true}).limit(20);
 if(me)throw me;
 if(currentSession?.user?.id!==userId)return;
 if(!members?.length){
  activeStockWorkspaceId=null;workspaceImport.hidden=true;
  window.VSP_STOCK_BRIDGE?.setItems([]);
  cloudStockMessage("No workspace is assigned to this account. Ask the administrator to authorise you, or create your own workspace.","warning");
  document.body.classList.remove("cloud-loading");
  return;
 }
 const workspaceIds=[...new Set(members.map(m=>m.workspace_id))];
 const {data:workspaces,error:workspaceError}=await supabase.from("workspaces")
   .select("id,created_by,name").in("id",workspaceIds);
 if(workspaceError)throw workspaceError;
 // Never fall back to a shared administrator workspace. Every account must use
 // a workspace it created, so authorised users cannot see the administrator's stock.
 const ownedWorkspace=(workspaces||[]).find(w=>w.created_by===userId);
 if(!ownedWorkspace){
  activeStockWorkspaceId=null;workspaceImportAllowed=false;workspaceImport.hidden=true;
  window.VSP_STOCK_BRIDGE?.setItems([]);
  cloudStockMessage("This account does not have a personal workspace yet. Tap Set up workspace to create your own stock area. Shared administrator stock is not displayed.","warning");
  document.body.classList.remove("cloud-loading");
  return;
 }
 const membership=members.find(m=>m.workspace_id===ownedWorkspace.id);
 if(!membership)throw new Error("Your personal workspace membership could not be verified.");
 activeStockWorkspaceId=ownedWorkspace.id;
 const selectedWorkspace=ownedWorkspace;
 if(currentSession?.user?.id!==userId)return;
 workspaceImportAllowed=["owner","admin"].includes(membership.role);
 const {data:rows,error}=await supabase.from("stock_items")
   .select("id,legacy_id,name,sku,barcode,category,qty,min_qty,max_qty,location,supplier,supplier_url,notes,photo_path")
   .eq("workspace_id",activeStockWorkspaceId).eq("owner_user_id",userId).order("name");
 if(error)throw error;
 if(currentSession?.user?.id!==userId)return;
 const list=[];
 for(const row of rows||[]){
  let photo="";
  if(row.photo_path){
   const {data:signed,error:photoError}=await supabase.storage.from("van-stock-item-photos").createSignedUrl(row.photo_path,3600);
   if(!photoError)photo=signed?.signedUrl||"";
  }
  list.push({id:String(row.legacy_id||row.id),name:row.name||"",sku:row.sku||"",barcode:row.barcode||"",
   category:row.category||"",qty:Number(row.qty)||0,minQty:Number(row.min_qty)||0,
   maxQty:row.max_qty==null?null:Number(row.max_qty),location:row.location||"",supplier:row.supplier||"",
   supplierUrl:row.supplier_url||"",notes:row.notes||"",photo});
 }
 window.VSP_STOCK_BRIDGE?.setItems(list);
 workspaceImport.hidden=!!list.length||!workspaceImportAllowed;
 cloudStockMessage("Workspace: "+(selectedWorkspace?.name||"Van Stock Pro")+". Loaded "+list.length+" stock item(s) from "+(ownedWorkspace?"your own workspace":"your authorised workspace")+".","success");
 const [moves,usage]=await Promise.all([
  supabase.from("stock_movements").select("legacy_id,legacy_item_id,item_name,sku,action,change_qty,balance_after,note,created_at").eq("workspace_id",activeStockWorkspaceId).order("created_at",{ascending:false}).limit(1000),
  supabase.from("job_usage").select("legacy_id,legacy_item_id,item_name,sku,quantity,job_reference,notes,created_at").eq("workspace_id",activeStockWorkspaceId).order("created_at",{ascending:false}).limit(2000)
 ]);
 if(moves.error)throw moves.error;if(usage.error)throw usage.error;
 if(currentSession?.user?.id!==userId)return;
 localStorage.setItem("van-stock-pro-movements-v2",JSON.stringify((moves.data||[]).map(x=>({id:x.legacy_id,date:x.created_at,itemId:x.legacy_item_id||"",itemName:x.item_name||"",sku:x.sku||"",action:x.action||"adjustment",change:Number(x.change_qty)||0,balance:Number(x.balance_after)||0,note:x.note||""}))));
 localStorage.setItem("van-stock-pro-usage-v1",JSON.stringify((usage.data||[]).map(x=>({id:x.legacy_id,date:x.created_at,usageDate:String(x.created_at||"").slice(0,10),job:x.job_reference||"",itemId:x.legacy_item_id||"",itemName:x.item_name||"",sku:x.sku||"",quantity:Number(x.quantity)||0,notes:x.notes||""}))));
 document.body.classList.remove("cloud-loading");
}
window.addEventListener("vsp-stock-save",e=>{
 const snapshot=Array.isArray(e.detail?.items)?e.detail.items.map(x=>({...x})):null;
 const wid=activeStockWorkspaceId;
 const uid=currentSession?.user?.id||null;
 if(!currentSession?.user){cloudStockMessage("This item is only saved on this device. Sign in to a personal workspace to save it to the cloud.","warning");return;}
 stockQueue=stockQueue.then(()=>syncWorkspaceItems(snapshot,wid,uid)).catch(err=>{
  cloudStockMessage("CLOUD SAVE FAILED — this item is only on this device until sync succeeds. "+(err?.message||String(err)),"error");
 });
});
async function syncActivity(table,entry,wid,userId){
 if(!wid||!entry?.id)return;
 const row=table==="stock_movements"?{workspace_id:wid,legacy_id:String(entry.id),legacy_item_id:String(entry.itemId||""),item_name:String(entry.itemName||""),sku:String(entry.sku||""),action:String(entry.action||"adjustment"),change_qty:Number(entry.change)||0,balance_after:Number(entry.balance)||0,note:String(entry.note||""),job_reference:/job/i.test(entry.action||"")?String(entry.action).replace(/^.*?:\s*/,""):"",created_at:entry.date||new Date().toISOString(),created_by:userId}:{workspace_id:wid,legacy_id:String(entry.id),legacy_item_id:String(entry.itemId||""),item_name:String(entry.itemName||""),sku:String(entry.sku||""),quantity:Number(entry.quantity)||0,job_reference:String(entry.job||""),notes:String(entry.notes||""),created_at:entry.date||new Date().toISOString(),created_by:userId};
 const {error}=await supabase.from(table).upsert(row,{onConflict:"workspace_id,legacy_id"});if(error)throw error;
}
for(const [eventName,table] of [["vsp-movement","stock_movements"],["vsp-job-usage","job_usage"]])window.addEventListener(eventName,e=>{const entry=e.detail?.entry,wid=activeStockWorkspaceId,uid=currentSession?.user?.id;stockQueue=stockQueue.then(()=>syncActivity(table,entry,wid,uid)).catch(err=>cloudStockMessage("Activity is saved on this phone, but cloud sync failed: "+err.message,"error"));});
workspaceImport.addEventListener("click",async()=>{if(!activeStockWorkspaceId||!workspaceImportAllowed)return;const list=window.VSP_STOCK_BRIDGE?.getPreCloudItems()||[];if(!list.length)return cloudStockMessage("No saved pre-cloud stock was found on this device.","warning");if(!confirm("Import "+list.length+" items from this device into this empty workspace?"))return;workspaceImport.disabled=true;try{await syncWorkspaceItems(list);await loadWorkspaceStock();cloudStockMessage("Imported "+list.length+" items into this workspace.","success");}catch(e){cloudStockMessage("Import failed: "+e.message,"error");}finally{workspaceImport.disabled=false;}});

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
      .from("workspace_members").select("workspace_id, role").eq("user_id", uid).limit(20);
    if (memberError) throw memberError;
    let personalWorkspace = null;
    if (memberships?.length) {
      const ids = [...new Set(memberships.map(m => m.workspace_id))];
      const { data: workspaces, error: workspaceListError } = await supabase
        .from("workspaces").select("id, created_by").in("id", ids);
      if (workspaceListError) throw workspaceListError;
      personalWorkspace = (workspaces || []).find(w => w.created_by === uid) || null;
    }
    if (!personalWorkspace) {
      const { data: workspace, error: workspaceError } = await supabase
        .from("workspaces").insert({ name: "My Van Stock", created_by: uid }).select("id").single();
      if (workspaceError) throw workspaceError;
      const { error: membershipError } = await supabase.from("workspace_members").insert({
        workspace_id: workspace.id, user_id: uid, role: "owner"
      });
      if (membershipError) {
        // Keep the created workspace for diagnosis; do not delete anything automatically.
        throw new Error("Your personal workspace was created but owner membership did not finish: " + membershipError.message);
      }
      personalWorkspace = workspace;
    }
    message("Your personal workspace is ready. Loading your separate stock…", "success");
    await refreshAccessPanel();
    await loadWorkspaceStock();
  } catch (error) {
    message(error?.message || "Workspace setup failed.", "error");
  } finally {
    setupButton.disabled = false;
  }
});
supabase.auth.onAuthStateChange((_event, session) => {
  setSession(session);
  if (session?.user) { checkSchema().then(ok=>ok&&loadWorkspaceStock()).catch(e=>message("Workspace load failed: "+e.message,"error")); }
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
      .select("workspace_id, role, created_at").eq("user_id", currentSession.user.id)
      .order("created_at", { ascending: true }).limit(20);
    if (mineError) throw mineError;
    if (!mine?.length) { accessPanel.hidden = true; activeWorkspaceId = null; activeWorkspaceRole = null; return; }
    const ids = [...new Set(mine.map(m => m.workspace_id))];
    const { data: owned, error: ownedError } = await supabase.from("workspaces")
      .select("id, created_by").in("id", ids);
    if (ownedError) throw ownedError;
    const own = (owned || []).find(w => w.created_by === currentSession.user.id);
    const selected = own ? mine.find(m => m.workspace_id === own.id) : mine[0];
    if (!["owner", "admin"].includes(selected.role)) {
      accessPanel.hidden = true; activeWorkspaceId = null; activeWorkspaceRole = selected.role; return;
    }
    activeWorkspaceId = selected.workspace_id;
    activeWorkspaceRole = selected.role;
    accessPanel.hidden = false;
    accessRoleLabel.textContent = selected.role.toUpperCase();
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
  if (schemaReady) { await refreshAccessPanel(); await loadWorkspaceStock(); }
}

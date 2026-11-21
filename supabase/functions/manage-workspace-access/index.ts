import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !anonKey || !serviceKey) return reply({ error: "Server authentication is not configured." }, 500);

    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return reply({ error: "Sign in is required." }, 401);

    const callerClient = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: authData, error: authError } = await callerClient.auth.getUser(token);
    const caller = authData?.user;
    if (authError || !caller) return reply({ error: "Your session is invalid. Sign in again." }, 401);

    const admin = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");
    const workspaceId = String(body.workspaceId || "");
    const userId = String(body.userId || "");
    const role = String(body.role || "member");

    if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) return reply({ error: "A valid workspace is required." }, 400);

    const { data: membership, error: membershipError } = await admin
      .from("workspace_members").select("role")
      .eq("workspace_id", workspaceId).eq("user_id", caller.id).maybeSingle();
    if (membershipError) throw membershipError;
    if (!membership || !["owner", "admin"].includes(membership.role)) {
      return reply({ error: "Only workspace owners and administrators can manage registrations." }, 403);
    }
    const callerRole = membership.role;

    if (action === "list") {
      const { data: memberRows, error: memberError } = await admin
        .from("workspace_members").select("user_id, role, created_at").eq("workspace_id", workspaceId);
      if (memberError) throw memberError;
      const { data: rejectedRows, error: rejectedError } = await admin
        .from("workspace_access_decisions").select("user_id")
        .eq("workspace_id", workspaceId).eq("status", "rejected");
      if (rejectedError) throw rejectedError;
      const existing = new Set((memberRows || []).map((row: {user_id:string}) => row.user_id));
      const rejected = new Set((rejectedRows || []).map((row: {user_id:string}) => row.user_id));
      const pending = [];
      const emailByUserId = new Map<string, string>();
      const lastSignInByUserId = new Map<string, string | null>();
      for (let page = 1; page <= 50; page++) {
        const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
        if (error) throw error;
        const users = data?.users || [];
        for (const user of users) {
          if (user.email) emailByUserId.set(user.id, user.email);
          lastSignInByUserId.set(user.id, user.last_sign_in_at || null);
          if (user.id !== caller.id && !existing.has(user.id) && !rejected.has(user.id)) {
            pending.push({
              user_id: user.id,
              email: user.email || "(no email)",
              created_at: user.created_at,
              email_confirmed_at: user.email_confirmed_at || null,
            });
          }
        }
        if (users.length < 1000) break;
      }
      const members = (memberRows || []).map((row: {user_id:string; role?:string; created_at?:string}) => ({
        user_id: row.user_id,
        email: emailByUserId.get(row.user_id) || "(email unavailable)",
        role: row.role || "member",
        created_at: row.created_at || null,
        last_sign_in_at: lastSignInByUserId.get(row.user_id) || null,
      }));
      pending.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      return reply({ pending, members });
    }

    if (action === "approve" || action === "reject") {
      if (!/^[0-9a-f-]{36}$/i.test(userId) || userId === caller.id) {
        return reply({ error: "Choose a valid other user account." }, 400);
      }
      if (!["member", "viewer", "admin"].includes(role)) return reply({ error: "Invalid permission level." }, 400);
      if (callerRole === "admin" && !["member", "viewer"].includes(role)) {
        return reply({ error: "Administrators can approve Members and Viewers. Only the owner can grant Admin access." }, 403);
      }

      const { data: targetResult, error: targetError } = await admin.auth.admin.getUserById(userId);
      if (targetError || !targetResult?.user) return reply({ error: "That registered account could not be found." }, 404);
      if (action === "approve" && !targetResult.user.email_confirmed_at) {
        return reply({ error: "This person must confirm their email address before approval." }, 409);
      }

      if (action === "approve") {
        const { error: insertError } = await admin.from("workspace_members").upsert(
          { workspace_id: workspaceId, user_id: userId, role },
          { onConflict: "workspace_id,user_id" },
        );
        if (insertError) throw insertError;
        const { error: clearError } = await admin.from("workspace_access_decisions")
          .delete().eq("workspace_id", workspaceId).eq("user_id", userId);
        if (clearError) throw clearError;
        return reply({ success: true, message: "User approved as " + role + "." });
      }

      const { error: rejectError } = await admin.from("workspace_access_decisions").upsert(
        { workspace_id: workspaceId, user_id: userId, status: "rejected", reviewed_by: caller.id, reviewed_at: new Date().toISOString() },
        { onConflict: "workspace_id,user_id" },
      );
      if (rejectError) throw rejectError;
      return reply({ success: true, message: "Registration rejected. Their account has not been deleted." });
    }

    return reply({ error: "Unknown action." }, 400);
  } catch (error) {
    console.error("manage-workspace-access:", error);
    return reply({ error: error?.message || "Could not manage workspace access." }, 500);
  }
});

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

/**
 * يعمل عبر cron كل دقيقة.
 * يبحث عن طلبات pending مجدولة للاعتماد (auto_approval_scheduled_at <= now)
 * ويعتمدها تلقائياً + يفعّل الاشتراك + يسجل في auto_approval_log + يُشعر الإدمن.
 */
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    const now = new Date().toISOString();

    // 1) جلب الطلبات المؤهلة
    const { data: due, error: dueErr } = await admin
      .from("payment_requests")
      .select("*")
      .eq("status", "pending")
      .not("auto_approval_scheduled_at", "is", null)
      .lte("auto_approval_scheduled_at", now)
      .limit(50);

    if (dueErr) throw dueErr;

    const results: Array<{ id: string; ok: boolean; reason?: string }> = [];

    for (const pr of due ?? []) {
      try {
        // 2) إعادة التحقق من الشروط الصارمة قبل الاعتماد
        const cleanFraud = pr.fraud_status === "clean";
        const recipientOk = pr.recipient_match === true;
        const amountMatch =
          pr.expected_amount != null &&
          pr.extracted_amount != null &&
          Number(pr.expected_amount) === Number(pr.extracted_amount);

        if (!cleanFraud || !recipientOk || !amountMatch) {
          // إلغاء الجدولة إذا تغيّرت الحالة
          await admin
            .from("payment_requests")
            .update({ auto_approval_scheduled_at: null })
            .eq("id", pr.id);
          results.push({ id: pr.id, ok: false, reason: "conditions_changed" });
          continue;
        }

        // 3) التحقق من المبلغ القياسي
        const { data: stdAmounts } = await admin.rpc("get_standard_plan_amounts");
        const standardSet = new Set(
          (stdAmounts ?? []).map((r: { amount: number }) => Number(r.amount))
        );
        if (!standardSet.has(Number(pr.amount))) {
          await admin
            .from("payment_requests")
            .update({ auto_approval_scheduled_at: null })
            .eq("id", pr.id);
          results.push({ id: pr.id, ok: false, reason: "non_standard_amount" });
          continue;
        }

        // 4) اعتماد الطلب (مع override صريح للـ trigger الواقي)
        const { error: updErr } = await admin
          .from("payment_requests")
          .update({
            status: "approved",
            reviewed_at: now,
            approval_override: true,
            override_reason: "اعتماد تلقائي: سند سليم + مستلم مطابق + مبلغ مطابق + مبلغ قياسي",
            auto_approved: true,
            auto_approval_scheduled_at: null,
            admin_notes: pr.admin_notes
              ? pr.admin_notes + "\n[نظام] اعتماد تلقائي"
              : "[نظام] اعتماد تلقائي بعد فحص شامل ناجح",
          })
          .eq("id", pr.id)
          .eq("status", "pending"); // حماية race condition

        if (updErr) {
          results.push({ id: pr.id, ok: false, reason: updErr.message });
          continue;
        }

        // 5) تفعيل الاشتراك
        if (pr.subscription_id) {
          const startsAt = new Date();
          const expiresAt = new Date();
          expiresAt.setMonth(expiresAt.getMonth() + 5);

          await admin
            .from("subscriptions")
            .update({
              status: "active",
              starts_at: startsAt.toISOString(),
              expires_at: expiresAt.toISOString(),
            })
            .eq("id", pr.subscription_id);
        }

        // 6) سجل العملية
        await admin.from("auto_approval_log").insert({
          payment_request_id: pr.id,
          user_id: pr.user_id,
          amount: pr.amount,
          expected_amount: pr.expected_amount,
          extracted_amount: pr.extracted_amount,
          extracted_recipient: pr.extracted_recipient,
          extracted_sender: pr.extracted_sender,
          recipient_match: pr.recipient_match,
          fraud_status: pr.fraud_status,
          receipt_hash: pr.receipt_hash,
        });

        // 7) إشعار كل الإدمن
        const { data: admins } = await admin
          .from("user_roles")
          .select("user_id")
          .eq("role", "admin");

        if (admins && admins.length > 0) {
          const notifications = admins.map((a: { user_id: string }) => ({
            user_id: a.user_id,
            title: "اعتماد تلقائي لطلب دفع",
            message: `تم اعتماد طلب بمبلغ ${pr.amount} ${pr.currency} تلقائياً بعد اجتياز الفحص الشامل.`,
            type: "info",
            link: "/admin/payments",
          }));
          await admin.from("notifications").insert(notifications);
        }

        results.push({ id: pr.id, ok: true });
      } catch (e) {
        console.error("auto-approve failure for", pr.id, e);
        results.push({
          id: pr.id,
          ok: false,
          reason: e instanceof Error ? e.message : "unknown",
        });
      }
    }

    return new Response(
      JSON.stringify({ processed: results.length, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("auto-approve-payments fatal:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

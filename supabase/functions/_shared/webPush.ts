// One Web Push loop for every function that buzzes a phone — chat-push
// for the crew, scheduled-sends for the person whose send went or failed.
// VAPID from the project's secrets, the send, and the prune: a push
// service answering 404/410 is the browser saying that endpoint is dead
// for good, and the row goes; anything else is one phone missing one
// buzz, never a failure of the rest. Talks to supabase-js and web-push,
// so it sits outside the import-free guard list like backupCommon.ts.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

export interface PushSub { id: string; endpoint: string; p256dh: string; auth: string }

export async function sendPush(admin: SupabaseClient, subs: PushSub[], payload: unknown): Promise<{ sent: number; pruned: number }> {
  if (!subs.length) return { sent: 0, pruned: 0 };
  webpush.setVapidDetails(
    Deno.env.get("VAPID_SUBJECT") ?? "mailto:blacklabndt@gmail.com",
    Deno.env.get("VAPID_PUBLIC_KEY")!,
    Deno.env.get("VAPID_PRIVATE_KEY")!
  );
  const body = JSON.stringify(payload);
  let sent = 0;
  const dead: string[] = [];
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        body,
        { TTL: 3600 }
      );
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number } | null)?.statusCode;
      if (code === 404 || code === 410) dead.push(s.id);
    }
  }));
  if (dead.length) await admin.from("push_subscriptions").delete().in("id", dead);
  return { sent, pruned: dead.length };
}

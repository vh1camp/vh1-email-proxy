/**
 * VH1 Camp — Web Push Send Function
 *
 * POST /.netlify/functions/send-push
 *   { title, body, url?, tag?, user_id?, user_ids? }
 *
 * If user_id (string) or user_ids (array) is provided, the push fans out only
 * to push_subscriptions rows for those user(s). With neither, fans out to all
 * subscribers (broadcast).
 *
 * Env vars (set in Netlify dashboard):
 *   VAPID_PUBLIC_KEY
 *   VAPID_PRIVATE_KEY
 *   VAPID_SUBJECT          (e.g. mailto:admin@vh1basketball.com)
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY
 */

const webpush = require('web-push');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return resp(405, { ok: false, error: 'Method not allowed' });
  }

  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) {
    return resp(500, { ok: false, error: 'VAPID_* env vars not configured' });
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return resp(500, { ok: false, error: 'SUPABASE_URL/SUPABASE_ANON_KEY not configured' });
  }

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return resp(400, { ok: false, error: 'Invalid JSON body' });
  }

  const { title, body, url, tag, user_id, user_ids } = payload;
  if (!title || !body) return resp(400, { ok: false, error: 'Missing title or body' });

  const supaHeaders = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  };

  // Build user-scoped filter if requested. Otherwise broadcast to everyone.
  const targetIds = []
    .concat(user_id ? [user_id] : [])
    .concat(Array.isArray(user_ids) ? user_ids : [])
    .map((x) => String(x))
    .filter(Boolean);
  let filter = '';
  if (targetIds.length === 1) {
    filter = `&user_id=eq.${encodeURIComponent(targetIds[0])}`;
  } else if (targetIds.length > 1) {
    const list = targetIds.map((id) => `"${id}"`).join(',');
    filter = `&user_id=in.(${encodeURIComponent(list)})`;
  }

  const subsRes = await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?select=id,endpoint,p256dh,auth${filter}`, {
    headers: supaHeaders,
  });
  if (!subsRes.ok) {
    return resp(502, { ok: false, error: `Supabase fetch failed: ${subsRes.status}` });
  }
  const subs = await subsRes.json();
  if (!Array.isArray(subs) || subs.length === 0) {
    return resp(200, { ok: true, sent: 0, total: 0, note: 'no subscriptions' });
  }

  const message = JSON.stringify({
    title,
    body,
    url: url || '/',
    tag: tag || 'vh1-camp',
  });

  let sent = 0;
  const stale = [];

  await Promise.all(
    subs.map(async (s) => {
      const sub = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
      try {
        await webpush.sendNotification(sub, message, { TTL: 60 * 60 * 24 });
        sent++;
      } catch (err) {
        // 404/410 — subscription gone (uninstalled, denied). Drop it.
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          stale.push(s.id);
        }
      }
    })
  );

  // Clean up dead subscriptions
  if (stale.length) {
    const ids = stale.map((id) => `"${id}"`).join(',');
    await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?id=in.(${ids})`, {
      method: 'DELETE',
      headers: supaHeaders,
    }).catch(() => {});
  }

  return resp(200, { ok: true, sent, total: subs.length, dropped: stale.length });
};

function resp(statusCode, body) {
  return { statusCode, headers: { ...corsHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

/**
 * VH1 Camp — JotForm Backfill (manual fallback for the live webhook).
 *
 * Pulls every submission from the configured JotForm form via the public API
 * and runs each one through an extract → dedupe-by-email → insert pipeline
 * that mirrors VH1's in-page XLSX import (index.html `parseXLSXRows`). The
 * resulting `campers` rows match what the Excel import produces. Idempotent:
 * existing rows (by email) are skipped, so this is safe to re-run.
 *
 * The live webhook is a separate Supabase Edge Function in a different repo;
 * this function is a parallel, independent path and never touches it.
 *
 * Env vars (set in Netlify dashboard):
 *   JOTFORM_API_KEY    — JotForm API key
 *   JOTFORM_FORM_ID    — the form ID to pull submissions from
 *   JOTFORM_MIN_DATE   — optional cutoff (e.g. 2026-01-01). Submissions older
 *                        than this are filtered server-side via the JotForm
 *                        API filter param and again client-side as a safety
 *                        net. Defaults to 2026-01-01 to keep a re-used form
 *                        from importing previous-year campers.
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY
 *
 * Returns: { ok, fetched, skipped_old, created, duplicates, invalid, errors,
 *            min_date, details }
 */

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
    return json(405, { ok: false, error: 'POST only' });
  }

  const apiKey = process.env.JOTFORM_API_KEY;
  const formId = process.env.JOTFORM_FORM_ID;
  if (!apiKey || !formId) {
    return json(500, { ok: false, error: 'JOTFORM_API_KEY or JOTFORM_FORM_ID not configured' });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    return json(500, { ok: false, error: 'SUPABASE_URL or SUPABASE_ANON_KEY not configured' });
  }

  const minDateStr = (process.env.JOTFORM_MIN_DATE || '2026-01-01').trim();
  const minDate = new Date(minDateStr + 'T00:00:00Z');
  const filterJson = JSON.stringify({ 'created_at:gt': minDateStr + ' 00:00:00' });

  // Page through submissions in batches of 1000 (JotForm API max).
  const all = [];
  let offset = 0;
  const limit = 1000;
  for (;;) {
    const url = `https://api.jotform.com/form/${formId}/submissions?apiKey=${encodeURIComponent(apiKey)}&limit=${limit}&offset=${offset}&orderby=created_at&filter=${encodeURIComponent(filterJson)}`;
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      return json(502, { ok: false, error: `JotForm API fetch failed`, body: e && e.message ? e.message : String(e) });
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return json(502, { ok: false, error: `JotForm API error ${res.status}`, body });
    }
    const data = await res.json().catch(() => null);
    const page = (data && Array.isArray(data.content)) ? data.content : [];
    all.push(...page);
    if (page.length < limit) break;
    offset += page.length;
    if (offset > 10000) break; // safety stop
  }

  const summary = {
    fetched: all.length,
    skipped_old: 0,
    created: 0,
    duplicates: 0,
    invalid: 0,
    errors: 0,
    min_date: minDateStr,
    details: [],
  };

  for (const sub of all) {
    // Client-side safety filter in case the JotForm filter param ever drifts.
    // sub.created_at format: 'YYYY-MM-DD HH:MM:SS' (UTC per JotForm docs).
    if (sub.created_at) {
      const subDate = new Date(sub.created_at.replace(' ', 'T') + 'Z');
      if (!isNaN(subDate.getTime()) && subDate < minDate) {
        summary.skipped_old++;
        continue;
      }
    }

    let camper;
    try {
      const row = flattenSubmission(sub);
      camper = extractCamperFromXlsxRow(row);
    } catch (e) {
      summary.errors++;
      summary.details.push({ sub_id: sub.id, email: '', name: '', result: 'error', reason: 'extract failed: ' + (e && e.message ? e.message : String(e)) });
      continue;
    }

    const result = await insertCamper(camper);
    if (result.status === 'created') summary.created++;
    else if (result.status === 'duplicate') summary.duplicates++;
    else if (result.status === 'invalid') summary.invalid++;
    else summary.errors++;

    if (result.status !== 'duplicate') {
      summary.details.push({
        sub_id: sub.id,
        email: camper.email || '',
        name: `${camper.first_name || ''} ${camper.last_name || ''}`.trim(),
        result: result.status,
        reason: result.reason,
      });
    }
  }

  return json(200, { ok: true, ...summary });
};

// Flatten a JotForm API submission (`sub.answers` keyed by qid → { name, text, answer })
// into a row object whose keys match the column headers VH1's XLSX import expects
// (e.g. 'First Name', 'E-mail', 'City, State', "Current RMAC Men's Staff", etc.).
// Composite answers (Full Name, Phone Number, Address) are split into the
// individual XLSX-style sub-columns.
function flattenSubmission(sub) {
  const row = {};
  const answers = sub && sub.answers ? sub.answers : {};
  for (const item of Object.values(answers)) {
    if (!item) continue;
    const label = (item.text || item.name || '').toString().trim();
    const ans = item.answer;
    if (ans == null || ans === '') continue;

    if (Array.isArray(ans)) {
      if (label) row[label] = ans.filter(Boolean).join(', ');
      continue;
    }

    if (typeof ans === 'object') {
      // Full Name composite: { first, middle, last }
      if ('first' in ans || 'last' in ans) {
        if (ans.first != null && String(ans.first).trim()) row['First Name'] = String(ans.first).trim();
        if (ans.last != null && String(ans.last).trim()) row['Last Name'] = String(ans.last).trim();
        continue;
      }
      // Phone composite: { full, area, phone }
      if ('full' in ans || ('area' in ans && 'phone' in ans)) {
        const fullStr = ans.full != null ? String(ans.full).trim() : '';
        const phone = fullStr || `${ans.area || ''}${ans.phone || ''}`.trim();
        if (phone) row[label || 'Phone Number'] = phone;
        continue;
      }
      // Address composite: { addr_line1, addr_line2, city, state, postal, country }
      if ('city' in ans || 'state' in ans || 'addr_line1' in ans) {
        if (ans.city) row['City'] = String(ans.city).trim();
        if (ans.state) row['State'] = String(ans.state).trim();
        if (ans.city && ans.state) row['City, State'] = `${String(ans.city).trim()}, ${String(ans.state).trim()}`;
        continue;
      }
      // Generic object — flatten by joining truthy values.
      const joined = Object.values(ans).filter(Boolean).join(' ').trim();
      if (label && joined) row[label] = joined;
      continue;
    }

    if (label) row[label] = String(ans);
  }
  return row;
}

// Mirror of VH1's `parseXLSXRows` in index.html (~line 2177). Produces a
// camper record identical to what the in-page Excel importer creates.
function extractCamperFromXlsxRow(row) {
  const titleCase = (s) => (s || '').toString().trim().replace(/\w\S*/g, (t) => t.charAt(0).toUpperCase() + t.substr(1).toLowerCase());

  const first = titleCase((row['First Name'] || '').toString());
  const last = titleCase((row['Last Name'] || '').toString());
  const email = (row['E-mail'] || row['Email'] || '').toString().trim().toLowerCase();

  // City/State — prefer combined "City, State", else fall back to separate
  // City + State (set when JotForm sends a structured address composite).
  let city = '', state = '';
  const cityState = (row['City, State'] || '').toString().trim();
  if (cityState) {
    if (cityState.includes(',')) {
      const parts = cityState.split(',');
      city = parts[0].trim();
      const rawState = parts[1].trim();
      const stateMap = { 'Colorado': 'CO', 'Utah': 'UT', 'Wyoming': 'WY', 'California': 'CA', 'Nebraska': 'NE', 'Montana': 'MT', 'Kansas': 'KS', 'New Mexico': 'NM', 'Arizona': 'AZ', 'Nevada': 'NV', 'Idaho': 'ID', 'Oregon': 'OR', 'Washington': 'WA', 'Texas': 'TX', 'Florida': 'FL', 'Minnesota': 'MN', 'Missouri': 'MO', 'Iowa': 'IA', 'Illinois': 'IL', 'Indiana': 'IN', 'Ohio': 'OH', 'Michigan': 'MI', 'Wisconsin': 'WI', 'Pennsylvania': 'PA', 'New York': 'NY', 'North Carolina': 'NC', 'South Carolina': 'SC', 'Georgia': 'GA', 'Virginia': 'VA', 'Maryland': 'MD', 'Massachusetts': 'MA', 'Connecticut': 'CT', 'New Jersey': 'NJ' };
      state = stateMap[rawState] || rawState.substring(0, 2).toUpperCase();
    } else {
      city = cityState;
    }
  } else {
    city = (row['City'] || '').toString().trim();
    const st = (row['State'] || '').toString().trim();
    state = st.length === 2 ? st.toUpperCase() : (st ? st.substring(0, 2).toUpperCase() : '');
  }

  const rmacVal = (row["Current RMAC Men's Staff"] || '').toString().toUpperCase();
  const rmac = rmacVal === 'YES' || rmacVal === 'TRUE' || rmacVal === '1';

  const retVal = (row['Returning Camper?'] || '').toString().toUpperCase();
  const is_returning = retVal === 'YES' || retVal === 'TRUE' || retVal === '1';

  const levels = (row['Officiating Level of Experience (Check all that apply)'] || row['Officiating Level'] || '').toString();
  let type = 'Non-Staff';
  if (rmac) type = 'Staff';
  else if (levels.toLowerCase().includes('womens college')) type = 'Womens College';
  else if (levels.toLowerCase().includes('mens college')) type = 'Mens College';
  else if (levels.toLowerCase().includes('high school')) type = 'High School';

  const photoRaw = (row['Profile picture (head shot)'] || row['Profile Picture'] || row['Photo'] || '').toString().trim();
  const photoEnc = photoRaw.replace(/\s+/g, '%20');
  const photo = photoEnc && photoEnc.startsWith('http') ? photoEnc : null;

  return {
    first_name: first,
    last_name: last,
    email: email || null,
    city,
    state,
    phone: (row['Phone Number'] || '').toString().trim() || null,
    bio: (row['Bio'] || '').toString().trim() || null,
    conference: (row['Conference'] || '').toString().trim() || null,
    levels: levels.trim() || null,
    photo,
    rmac,
    is_returning,
    type,
    pin: String(Math.floor(1000 + Math.random() * 9000)),
  };
}

function supabaseHeaders() {
  return {
    apikey: process.env.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
  };
}

async function insertCamper(camper) {
  if (!camper.first_name || !camper.last_name) {
    return { status: 'invalid', reason: 'missing name' };
  }
  if (!camper.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(camper.email)) {
    return { status: 'invalid', reason: 'invalid or missing email' };
  }

  // Normalize email to lowercase before BOTH dup check and insert. The
  // original Ben/Jason duplicates happened because JotForm sometimes
  // returns mixed-case ('BendObmeier8@...') while existing rows stored
  // the lowercase form, and the previous case-sensitive eq match treated
  // them as different campers.
  camper.email = camper.email.trim().toLowerCase();

  // Case-insensitive match via PostgREST's ilike.
  const existsUrl = `${process.env.SUPABASE_URL}/rest/v1/campers?email=ilike.${encodeURIComponent(camper.email)}&select=id`;
  let existsRes;
  try {
    existsRes = await fetch(existsUrl, { headers: supabaseHeaders() });
  } catch (e) {
    return { status: 'error', reason: 'dupcheck network error: ' + (e && e.message ? e.message : String(e)) };
  }
  if (!existsRes.ok) {
    const body = await existsRes.text().catch(() => '');
    return { status: 'error', reason: `dupcheck failed (${existsRes.status})`, body };
  }
  const existing = await existsRes.json().catch(() => []);
  if (Array.isArray(existing) && existing.length > 0) {
    return { status: 'duplicate' };
  }

  let insRes;
  try {
    insRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/campers`, {
      method: 'POST',
      headers: { ...supabaseHeaders(), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(camper),
    });
  } catch (e) {
    return { status: 'error', reason: 'insert network error: ' + (e && e.message ? e.message : String(e)) };
  }
  if (!insRes.ok) {
    const body = await insRes.text().catch(() => '');
    return { status: 'error', reason: `insert failed (${insRes.status})`, body };
  }
  return { status: 'created' };
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

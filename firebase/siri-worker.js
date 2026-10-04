/**
 * Daybook Siri logger + active calories — Cloudflare Worker
 *
 * Takes what you said, has Claude turn it into foods with calories and
 * macros, writes them straight into your Daybook Firebase log, and answers
 * with one sentence for Siri to read out. The Shortcut is three actions:
 * Dictate Text -> Get Contents of URL -> Speak Text.
 *
 * SETUP (all in the Cloudflare dashboard, no command line)
 * 1. Workers & Pages -> Create -> Create Worker. Name it daybook-siri, Deploy.
 * 2. Edit code, replace everything with this file, Deploy.
 * 3. Settings -> Variables and Secrets -> Add, one at a time, type Secret:
 *      ANTHROPIC_KEY    your Anthropic API key (a separate "Siri" key is best)
 *      FIREBASE_URL     the sync URL from Daybook's Settings
 *      FIREBASE_SA      the whole service-account JSON (see below)
 *      LOG_TOKEN        any long random string; the Shortcut sends it too
 *    Optional: MODEL, to use something other than Claude Haiku 4.5.
 *
 * FIREBASE ACCESS
 * The worker signs in to Firebase as a service account, which is how a
 * server is meant to do it: Firebase console -> Project settings -> Service
 * accounts -> Generate new private key. Open the downloaded .json file, copy
 * everything in it, and paste it as the FIREBASE_SA secret. Keep the file out
 * of chats and out of Git. Service accounts sit outside the database rules, so
 * the rules can say "only my own account" and the worker still gets in.
 *
 * Until FIREBASE_SA is set, the worker falls back to the old FIREBASE_SECRET
 * (the legacy database secret) if that is still present. That is only so the
 * switch-over can be done in steps: once FIREBASE_SA works, delete
 * FIREBASE_SECRET here and revoke the secret in Firebase.
 *
 * ACTIVE CALORIES FROM APPLE HEALTH
 * A "Daybook Moved" Shortcut reads today's Active Energy from Health and
 * POSTs it to /active with the same x-log-token header the Siri Shortcut
 * uses, as JSON: {"active": 412, "date": "2026-09-22"}. The date comes from
 * the phone because only the phone knows which day it is where you are.
 * Nothing else to set up here.
 *
 * Entries are written without a date or a meal on purpose: Firebase stamps
 * `updated` with its own clock, and the app files each entry by that time in
 * your time zone, which this worker doesn't know.
 *
 * Every answer is a 200 with a plain sentence, errors included, because the
 * Shortcut speaks whatever comes back -- a failure should be heard, not
 * swallowed. Answers carry CORS headers so the Daybook app can read them too
 * (the Shortcut ignores them). Nothing is opened up by that: every route that
 * does anything still needs the LOG_TOKEN.
 */

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
// Shown on the "running" page, so you can tell which code Cloudflare is serving.
const VERSION = '2026-10-04 auth-1';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-log-token',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env) {
    // A browser asks first before sending anything non-trivial.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    const url = new URL(request.url);
    // "/active/", "/Active" and "/active" all mean the same thing.
    const path = url.pathname.replace(/\/+$/, '').toLowerCase() || '/';
    if (path === '/active') return logActive(request, env, await readJSON(request));
    if (request.method !== 'POST') {
      return say('Daybook Siri logger is running (version ' + VERSION + '). ' +
        (path === '/' ? 'The Shortcut sends a POST.' : 'There’s nothing at ' + url.pathname + ' — check the address.'));
    }
    const body = await readJSON(request);
    // An active-calorie body sent to the main address is still an active-
    // calorie update -- so a Shortcut copied from the Siri one works even if
    // its URL never got /active on the end.
    if (body && body.active !== undefined && !body.text) return logActive(request, env, body);
    if (!env.LOG_TOKEN || !sameString(request.headers.get('x-log-token') || '', env.LOG_TOKEN)) {
      return say('That shortcut isn’t allowed to log food. Check the token.');
    }
    for (const k of ['ANTHROPIC_KEY', 'FIREBASE_URL']) {
      if (!env[k]) return say('The worker is missing its ' + k + ' setting.');
    }
    if (!hasFirebaseAccess(env)) return say('The worker is missing its FIREBASE_SA setting.');

    let text = String((body && body.text) || '').trim();
    if (!text) return say('I didn’t catch any food to log.');
    text = text.slice(0, 500);

    let items;
    try { items = await estimate(text, env); }
    catch (e) { return say('Claude couldn’t estimate that. ' + e.message); }
    if (!items.length) return say('I couldn’t work out any food from that.');

    // One multi-path write, so a meal lands whole or not at all.
    const patch = {};
    for (const it of items) {
      const id = 'siri-' + crypto.randomUUID();
      patch[id] = {
        id, name: it.name, cal: it.cal, portion: it.portion,
        src: 'Siri', deleted: 0,
        ...it.mac,
        updated: { '.sv': 'timestamp' },
      };
    }
    let r;
    try {
      r = await fbFetch(env, '/entries.json', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
    } catch (e) {
      return say('I estimated it but couldn’t reach your log. ' + (e && e.fbAuth ? e.message : ''));
    }
    if (!r.ok) return say('I estimated it but your log refused it. Firebase said ' + r.status + '.');

    return say(sentence(items));
  },
};

async function readJSON(request) {
  try { return await request.json(); } catch (e) { return null; }
}

function say(msg) {
  return new Response(msg, {
    status: 200,
    headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function sameString(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/* ---------- Firebase access ----------
   With FIREBASE_SA the worker is a service account: it signs a short JWT with
   the account's private key, trades it at Google for an access token (good
   for an hour), and sends that as a Bearer header. The token is kept in
   memory and reused until a minute before it runs out; Cloudflare may recycle
   the worker at any time, in which case the next request just signs again.
   Without FIREBASE_SA it falls back to the legacy secret in the URL. */
const SCOPES = 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
let tokenCache = null;      // { key: client_email, token, until }
let tokenPending = null;    // { key, promise }

function fbRoot(env) {
  return String(env.FIREBASE_URL || '').trim().replace(/\/+$/, '').replace(/\.json$/i, '');
}

function readSA(env) {
  const raw = env.FIREBASE_SA;
  if (!raw) return null;
  let sa = raw;
  if (typeof raw === 'string') {
    try { sa = JSON.parse(raw); } catch (e) { throw authError('FIREBASE_SA isn’t valid JSON. Paste the whole downloaded file.'); }
  }
  if (!sa || !sa.client_email || !sa.private_key) {
    throw authError('FIREBASE_SA is missing client_email or private_key. Paste the whole downloaded file.');
  }
  return sa;
}

function authError(msg) { const e = new Error(msg); e.fbAuth = true; return e; }

export function hasFirebaseAccess(env) {
  return !!(env.FIREBASE_SA || env.FIREBASE_SECRET);
}

const b64url = bytes => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const utf8 = s => new TextEncoder().encode(s);

async function signJWT(sa, now) {
  const pem = String(sa.private_key).replace(/\\n/g, '\n');
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const head = b64url(utf8(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = b64url(utf8(JSON.stringify({
    iss: sa.client_email, scope: SCOPES, aud: TOKEN_URL,
    iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 3600,
  })));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, utf8(head + '.' + claims));
  return head + '.' + claims + '.' + b64url(new Uint8Array(sig));
}

/* A valid access token for Firebase, or null when the worker has no service
   account (so the caller uses the legacy secret). Throws, with fbAuth set, if
   a service account is configured but Google won't sign it in. */
export async function fbAccess(env, force) {
  const sa = readSA(env);
  if (!sa) return null;
  const now = Date.now();
  if (!force && tokenCache && tokenCache.key === sa.client_email && tokenCache.until > now) return tokenCache.token;
  if (tokenPending && tokenPending.key === sa.client_email) return tokenPending.promise;
  const promise = (async () => {
    let r, j = null;
    try {
      r = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: await signJWT(sa, now),
        }),
      });
    } catch (e) {
      if (e && e.fbAuth) throw e;
      throw authError('Couldn’t sign in to Firebase: ' + (e && e.message || 'no answer from Google') + '.');
    }
    try { j = await r.json(); } catch (e) {}
    if (!r.ok || !j || !j.access_token) {
      throw authError('Google refused the service account (' + ((j && (j.error_description || j.error)) || r.status) + ').');
    }
    tokenCache = { key: sa.client_email, token: j.access_token, until: Date.now() + Math.max(60, (Number(j.expires_in) || 3600) - 60) * 1000 };
    return tokenCache.token;
  })();
  tokenPending = { key: sa.client_email, promise };
  try { return await promise; } finally { tokenPending = null; }
}

/* fetch() against the Firebase database. `path` starts with a slash and ends
   in .json, e.g. '/entries.json'. */
export async function fbFetch(env, path, init) {
  init = init || {};
  const token = await fbAccess(env);
  if (token) {
    const send = t => fetch(fbRoot(env) + path, { ...init, headers: { ...(init.headers || {}), Authorization: 'Bearer ' + t } });
    let r = await send(token);
    // A token Google has just retired: sign in once more and retry once.
    if (r.status === 401) r = await send(await fbAccess(env, true));
    return r;
  }
  if (!env.FIREBASE_SECRET) throw authError('The worker has no FIREBASE_SA or FIREBASE_SECRET.');
  return fetch(fbRoot(env) + path + (path.includes('?') ? '&' : '?') + 'auth=' + encodeURIComponent(env.FIREBASE_SECRET), init);
}

/* Same instructions the app itself uses for an estimate. */
function prompt(desc) {
  return 'Estimate the calories and macronutrients in this food or meal: "' + desc + '".\n' +
    'If it lists separate foods (for example "2 eggs, toast and a latte"), return each as its own item. ' +
    'A single dish, however many ingredients it has, is one item.\n' +
    'Assume typical preparation and typical restaurant or home portion sizes unless the description says otherwise.\n' +
    'Macros are grams for the portion: protein, total carbohydrate, fat, and total sugars (natural plus added).\n' +
    'Respond with ONLY a JSON object, no markdown fences and no other text:\n' +
    '{"items":[{"name":"short food name","calories":integer,"portion":"the portion you assumed",' +
    '"protein_g":number,"carbs_g":number,"fat_g":number,"sugar_g":number}]}';
}

async function estimate(desc, env) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: env.MODEL || DEFAULT_MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt(desc) }],
    }),
  });
  if (!r.ok) {
    let msg = 'Anthropic said ' + r.status + '.';
    try { const j = await r.json(); if (j.error && j.error.message) msg = j.error.message; } catch (e) {}
    throw new Error(msg);
  }
  const j = await r.json();
  const raw = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return parseItems(raw);
}

/* Tolerant of fences or a stray sentence around the JSON. Macros are all or
   nothing on protein: an entry without them reads as "unknown" in the app,
   never as zero. */
export function parseItems(raw) {
  const s = String(raw || ''), a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return [];
  let j;
  try { j = JSON.parse(s.slice(a, b + 1)); } catch (e) { return []; }
  const list = Array.isArray(j.items) ? j.items : [j];
  const num = v => { const n = Number(v); return v !== null && v !== '' && isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : undefined; };
  return list.map(it => {
    const cal = Math.round(Number(it && it.calories));
    if (!isFinite(cal) || cal < 0) return null;
    const mac = {};
    if (num(it.protein_g) !== undefined) {
      mac.p = num(it.protein_g);
      [['c', 'carbs_g'], ['f', 'fat_g'], ['s', 'sugar_g']].forEach(([k, f]) => {
        const v = num(it[f]); if (v !== undefined) mac[k] = v;
      });
    }
    return {
      name: String(it.name || 'Siri entry').trim().slice(0, 80),
      cal, portion: String(it.portion || '').slice(0, 80), mac,
    };
  }).filter(Boolean);
}

/* "Logged eggs, toast and a latte: 540 calories, 27 grams of protein." */
export function sentence(items) {
  const names = items.map(i => i.name.toLowerCase());
  const list = names.length === 1 ? names[0]
    : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  const cal = items.reduce((a, i) => a + i.cal, 0);
  const known = items.filter(i => i.mac.p !== undefined);
  const p = Math.round(known.reduce((a, i) => a + i.mac.p, 0));
  return 'Logged ' + list + ': ' + cal.toLocaleString('en-US') + ' calories' +
    (known.length ? ', ' + p + ' gram' + (p === 1 ? '' : 's') + ' of protein.' : '.');
}

/* ---------- active calories from the Health Shortcut ----------
   Written exactly like the app's own day rows -- days/<date> with the moved
   figure and a server timestamp -- so every device picks it up on its next
   pull, and last write wins against a number typed by hand. The value is
   taken as sent: a sum of Active Energy. Shortcuts sometimes sends it as text
   with a unit ("412.6 kcal"), so the number is read out of whatever arrives. */
async function logActive(request, env, b) {
  if (request.method !== 'POST') return say('POST {"active": number, "date": "YYYY-MM-DD"} here.');
  if (!env.LOG_TOKEN || !sameString(request.headers.get('x-log-token') || '', env.LOG_TOKEN)) {
    return say('That shortcut isn’t allowed to update your log. Check the token.');
  }
  if (!env.FIREBASE_URL || !hasFirebaseAccess(env)) return say('The worker is missing its Firebase settings.');
  if (!b || typeof b !== 'object') return say('Send the number as JSON: {"active": 412, "date": "2026-09-22"}.');
  // Field names forgive capitals and stray spaces: "Date " is still date.
  b = Object.fromEntries(Object.entries(b).map(([k, v]) => [String(k).trim().toLowerCase(), v]));
  const m = String(b.active ?? '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  const cal = m ? Math.round(Number(m[0])) : NaN;
  if (!isFinite(cal) || cal < 0 || cal > 20000) return say('That didn’t look like a calorie number: ' + String(b.active ?? 'nothing') + '.');
  /* The phone's own date is best. Without one, Cloudflare knows the time
     zone of the network the request came from, which is right unless you're
     on a VPN -- and only matters in the hour around midnight anyway. */
  let date = String(b.date ?? '').trim();
  let guessed = false;
  if (!date) {
    const tz = request.cf && request.cf.timezone;
    if (!tz) return say('No date came with the number, and I couldn’t tell your time zone. Add a date field: yyyy-MM-dd.');
    try { date = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
    catch (e) { return say('No date came with the number. Add a date field: yyyy-MM-dd.'); }
    guessed = true;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return say('The date needs to be yyyy-MM-dd, like 2026-09-22. Got: ' + date + '.');
  try {
    const r = await fbFetch(env, '/days/' + date + '.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, active: cal, updated: { '.sv': 'timestamp' } }),
    });
    if (!r.ok) return say('Your log refused it. Firebase said ' + r.status + '.');
  } catch (e) { return say(e && e.fbAuth ? e.message : 'Couldn’t reach your log.'); }
  return say('Moved: ' + cal.toLocaleString('en-US') + ' active calories for ' + date +
    (guessed ? ' (date from your time zone)' : '') + '.');
}

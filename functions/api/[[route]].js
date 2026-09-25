// We Deploy — functions/api/[[route]].js
// ONE file for the new server features (see also GROWTH section: real business search, radar, seasons, challenges, feed, wins, referrals):
//   /api/wd/*       site settings, roles/levels, leaderboard, owner admin
//   /api/data/blob  syncs each user's data across devices (used by app-sync.js)
// Your existing /api/auth/* and /api/invoices/* files keep working as before.
// Database tables are created automatically — no SQL setup needed.

const OWNER_EMAIL = 'delonmayne@gmail.com';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const DEFAULT_SITE = {
  name: 'We Deploy',
  version: '',
  tagline: 'Lead Finder Pro — find businesses without websites, anywhere in the world',
  banner: '',
  bannerOn: false,
  maintenance: false,
  maintenanceMsg: 'We Deploy is getting an upgrade. Back soon!',
  allowSignups: true,
  leaderboardOn: true,
  tip: '',
};

const BADGES = ['', '⭐ Verified', '💎 VIP', '🛡 Staff', '🚀 Founder', '🏆 Champion', '🔥 Top Closer', '🎓 Trainee'];
const SORTS = { xp: 'p.xp', leads: 'p.leads', contacts: 'p.contacts', deals: 'p.deals', sales: 'p.sales', level: 'p.xp', week: 'p.week_xp', streak: 'p.streak', badges: 'p.badges' };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}
const int = (v, max = 1e9) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));
const str = (v, max = 120) => String(v == null ? '' : v).slice(0, max);

async function ensureTables(DB) {
  await DB.batch([
    DB.prepare('CREATE TABLE IF NOT EXISTS wd_site (k TEXT PRIMARY KEY, v TEXT)'),
    DB.prepare('CREATE TABLE IF NOT EXISTS wd_profiles (user_id TEXT PRIMARY KEY, role TEXT, path TEXT, ind TEXT, market TEXT, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 1, leads INTEGER DEFAULT 0, contacts INTEGER DEFAULT 0, deals INTEGER DEFAULT 0, sales REAL DEFAULT 0, proposals INTEGER DEFAULT 0, updated INTEGER)'),
    DB.prepare('CREATE TABLE IF NOT EXISTS wd_flags (user_id TEXT PRIMARY KEY, hidden INTEGER DEFAULT 0, banned INTEGER DEFAULT 0, badge TEXT DEFAULT \'\')'),
  ]);
}

async function getSite(DB) {
  const row = await DB.prepare("SELECT v FROM wd_site WHERE k = 'config'").first();
  let cfg = {};
  try { cfg = row ? JSON.parse(row.v) : {}; } catch (e) { cfg = {}; }
  return { ...DEFAULT_SITE, ...cfg };
}

async function authUser(request, DB) {
  const sid = request.headers.get('Authorization')?.replace('Bearer ', '');
  if (!sid) return null;
  const s = await DB.prepare('SELECT user_id FROM sessions WHERE id = ? AND expires > ?').bind(sid, Date.now()).first();
  if (!s) return null;
  const u = await DB.prepare('SELECT id, name, email, biz, created FROM users WHERE id = ?').bind(s.user_id).first();
  if (!u) return null;
  u.isOwner = String(u.email || '').toLowerCase() === OWNER_EMAIL;
  return u;
}

async function handleWd(context, segs) {
  const { request, env } = context;
  const params = { path: segs };
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  const DB = env.DB;
  const path = (params.path || []).join('/');
  const m = request.method;

  try {
    await ensureTables(DB);

    // ---------- public: site settings ----------
    if (path === 'site' && m === 'GET') {
      return json({ ok: true, site: await getSite(DB) });
    }
    if (path === 'pulse' && m === 'GET') return handlePulse(DB);

    const me = await authUser(request, DB);
    if (!me) return json({ error: 'Please sign in again' }, 401);
    const flags = (await DB.prepare('SELECT hidden, banned, badge FROM wd_flags WHERE user_id = ?').bind(me.id).first()) || { hidden: 0, banned: 0, badge: '' };
    if (flags.banned && !me.isOwner) return json({ error: 'This account has been suspended' }, 403);

    if (path === 'me' && m === 'GET') {
      return json({ ok: true, owner: me.isOwner, badge: flags.badge || '', hidden: !!flags.hidden, name: me.name });
    }

    const grown = await handleGrowth({ request, env, DB, path, m, me });
    if (grown) return grown;

    // ---------- owner: update site settings ----------
    if (path === 'site' && m === 'PUT') {
      if (!me.isOwner) return json({ error: 'Owner only' }, 403);
      const b = await request.json();
      const cur = await getSite(DB);
      const next = {
        name: str(b.name ?? cur.name, 40).trim() || DEFAULT_SITE.name,
        version: str(b.version ?? cur.version, 20).trim(),
        tagline: str(b.tagline ?? cur.tagline, 140),
        banner: str(b.banner ?? cur.banner, 280),
        bannerOn: !!(b.bannerOn ?? cur.bannerOn),
        maintenance: !!(b.maintenance ?? cur.maintenance),
        maintenanceMsg: str(b.maintenanceMsg ?? cur.maintenanceMsg, 200),
        allowSignups: !!(b.allowSignups ?? cur.allowSignups),
        leaderboardOn: !!(b.leaderboardOn ?? cur.leaderboardOn),
        tip: str(b.tip ?? cur.tip, 280),
      };
      await DB.prepare("INSERT INTO wd_site (k, v) VALUES ('config', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(JSON.stringify(next)).run();
      return json({ ok: true, site: next });
    }

    // ---------- user: save profile / stats ----------
    if (path === 'profile' && m === 'PUT') {
      await ensureGrowth(DB);
      const b = await request.json();
      const wk = weekKey();
      const old = await DB.prepare('SELECT week_key, week_xp, last_week_key, last_week_xp FROM wd_profiles WHERE user_id = ?').bind(me.id).first();
      let lastKey = old ? old.last_week_key : null, lastXp = old ? old.last_week_xp : 0;
      if (old && old.week_key && old.week_key !== wk) { lastKey = old.week_key; lastXp = old.week_xp || 0; }   // new week → archive last week's score
      const weekXp = String(b.week_key || '') === wk ? int(b.week_xp) : 0;
      await DB.prepare(
        'INSERT INTO wd_profiles (user_id, role, path, ind, market, xp, level, leads, contacts, deals, sales, proposals, updated, week_key, week_xp, last_week_key, last_week_xp, streak, badges, city) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ' +
        'ON CONFLICT(user_id) DO UPDATE SET role=excluded.role, path=excluded.path, ind=excluded.ind, market=excluded.market, xp=excluded.xp, level=excluded.level, leads=excluded.leads, contacts=excluded.contacts, deals=excluded.deals, sales=excluded.sales, proposals=excluded.proposals, updated=excluded.updated, week_key=excluded.week_key, week_xp=excluded.week_xp, last_week_key=excluded.last_week_key, last_week_xp=excluded.last_week_xp, streak=excluded.streak, badges=excluded.badges, city=excluded.city'
      ).bind(me.id, str(b.role, 120), str(b.path, 40), str(b.ind, 60), str(b.market, 60),
        int(b.xp), Math.max(1, int(b.level, 999)), int(b.leads), int(b.contacts), int(b.deals),
        Math.max(0, Math.min(1e10, Number(b.sales) || 0)), int(b.proposals), Date.now(),
        wk, weekXp, lastKey, lastXp, int(b.streak, 100000), int(b.badges, 1000), str(b.city, 60)).run();
      return json({ ok: true, week: wk });
    }

    // ---------- user: leaderboard ----------
    if (path === 'leaderboard' && m === 'GET') {
      await ensureGrowth(DB);
      const site = await getSite(DB);
      if (!site.leaderboardOn && !me.isOwner) return json({ ok: true, off: true, rows: [] });
      const url = new URL(request.url);
      const by = SORTS[url.searchParams.get('by')] ? url.searchParams.get('by') : 'xp';
      const limit = Math.min(100, Math.max(5, int(url.searchParams.get('limit')) || 50));
      const url0 = new URL(request.url);
      const weekOnly = url0.searchParams.get('by') === 'week' ? " AND p.week_key = '" + weekKey() + "'" : '';
      const hideWhere = (me.isOwner ? 'WHERE 1=1' : 'WHERE COALESCE(f.hidden,0) = 0 AND COALESCE(f.banned,0) = 0') + weekOnly + (weekOnly ? ' AND p.week_xp > 0' : '');
      const res = await DB.prepare(
        'SELECT u.id, u.name, u.biz, p.role, p.level, p.xp, p.leads, p.contacts, p.deals, p.sales, p.proposals, p.updated, p.week_xp AS week, p.streak, p.badges, p.city, COALESCE(f.badge,\'\') AS badge, COALESCE(f.hidden,0) AS hidden ' +
        'FROM wd_profiles p JOIN users u ON u.id = p.user_id LEFT JOIN wd_flags f ON f.user_id = p.user_id ' + hideWhere +
        ' ORDER BY ' + SORTS[by] + ' DESC, p.xp DESC LIMIT ?'
      ).bind(limit).all();
      const rows = (res.results || []).map((r, i) => ({ rank: i + 1, you: r.id === me.id, ...r }));
      const mine = await DB.prepare('SELECT ' + SORTS[by] + ' AS v FROM wd_profiles p WHERE p.user_id = ?' + weekOnly).bind(me.id).first();
      let myRank = null;
      if (mine) {
        const ahead = await DB.prepare('SELECT COUNT(*) AS n FROM wd_profiles p LEFT JOIN wd_flags f ON f.user_id = p.user_id WHERE ' + SORTS[by] + ' > ? AND COALESCE(f.hidden,0) = 0 AND COALESCE(f.banned,0) = 0' + weekOnly).bind(mine.v).first();
        myRank = (ahead ? ahead.n : 0) + 1;
      }
      const total = await DB.prepare('SELECT COUNT(*) AS n FROM wd_profiles').first();
      return json({ ok: true, by, rows, myRank, total: total ? total.n : rows.length });
    }

    // ---------- owner admin ----------
    if (path.startsWith('admin/')) {
      if (!me.isOwner) return json({ error: 'Owner only' }, 403);

      if (path === 'admin/users' && m === 'GET') {
        const res = await DB.prepare(
          'SELECT u.id, u.name, u.email, u.biz, u.created, p.role, p.level, p.xp, p.leads, p.contacts, p.deals, p.sales, p.proposals, p.updated, ' +
          'COALESCE(f.hidden,0) AS hidden, COALESCE(f.banned,0) AS banned, COALESCE(f.badge,\'\') AS badge, ' +
          '(SELECT MAX(created) FROM sessions s WHERE s.user_id = u.id) AS last_login ' +
          'FROM users u LEFT JOIN wd_profiles p ON p.user_id = u.id LEFT JOIN wd_flags f ON f.user_id = u.id ORDER BY u.created DESC LIMIT 1000'
        ).all();
        return json({ ok: true, users: res.results || [], badges: BADGES });
      }

      if (path === 'admin/stats' && m === 'GET') {
        const week = Date.now() - 7 * 864e5;
        const q = async (sql, ...a) => (await DB.prepare(sql).bind(...a).first()) || {};
        const users = await q('SELECT COUNT(*) AS n FROM users');
        const newWeek = await q('SELECT COUNT(*) AS n FROM users WHERE created > ?', week);
        const active = await q('SELECT COUNT(*) AS n FROM wd_profiles WHERE updated > ?', week);
        const sums = await q('SELECT COALESCE(SUM(leads),0) AS leads, COALESCE(SUM(contacts),0) AS contacts, COALESCE(SUM(deals),0) AS deals, COALESCE(SUM(sales),0) AS sales, COALESCE(SUM(proposals),0) AS proposals FROM wd_profiles');
        const banned = await q('SELECT COUNT(*) AS n FROM wd_flags WHERE banned = 1');
        return json({ ok: true, stats: { users: users.n || 0, newWeek: newWeek.n || 0, activeWeek: active.n || 0, banned: banned.n || 0, ...sums } });
      }

      if (path === 'admin/user' && m === 'POST') {
        const b = await request.json();
        const id = str(b.id, 80);
        const target = await DB.prepare('SELECT id, email FROM users WHERE id = ?').bind(id).first();
        if (!target) return json({ error: 'User not found' }, 404);
        if (String(target.email).toLowerCase() === OWNER_EMAIL && (b.action === 'ban' || b.action === 'hide')) return json({ error: "You can't ban or hide the owner account" }, 400);
        await DB.prepare('INSERT OR IGNORE INTO wd_flags (user_id) VALUES (?)').bind(id).run();
        const set = {
          hide: ['UPDATE wd_flags SET hidden = 1 WHERE user_id = ?', [id]],
          unhide: ['UPDATE wd_flags SET hidden = 0 WHERE user_id = ?', [id]],
          ban: ['UPDATE wd_flags SET banned = 1 WHERE user_id = ?', [id]],
          unban: ['UPDATE wd_flags SET banned = 0 WHERE user_id = ?', [id]],
          badge: ['UPDATE wd_flags SET badge = ? WHERE user_id = ?', [BADGES.includes(b.badge) ? b.badge : str(b.badge, 24), id]],
          reset: ['UPDATE wd_profiles SET xp = 0, level = 1, leads = 0, contacts = 0, deals = 0, sales = 0, proposals = 0, updated = ? WHERE user_id = ?', [Date.now(), id]],
        }[b.action];
        if (!set) return json({ error: 'Unknown action' }, 400);
        await DB.prepare(set[0]).bind(...set[1]).run();
        if (b.action === 'ban') await DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id).run();
        return json({ ok: true });
      }
    }

    return json({ error: 'Not found' }, 404);
  } catch (err) {
    return json({ error: err.message || 'Server error' }, 500);
  }
}

// ───────────── GROWTH: real business search, radar, claims, seasons, challenges, feed, wins, referrals ─────────────
const OSM_UA = 'WeDeploy-LeadFinder/1.0 (+https://we-deploy.pages.dev)';
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const OSM_SEL = {
  'Restaurants & Food': ['["amenity"~"^(restaurant|cafe|fast_food|bar|pub|food_court|ice_cream)$"]', '["shop"~"^(bakery|butcher|deli|confectionery|beverages|pastry)$"]'],
  'Home Services': ['["craft"~"^(plumber|electrician|carpenter|painter|hvac|roofer|locksmith|gardener|tiler|glaziery|window_construction)$"]', '["shop"~"^(hardware|doityourself|paint|curtain|flooring)$"]'],
  'Health & Wellness': ['["amenity"~"^(clinic|doctors|dentist|pharmacy|veterinary)$"]', '["leisure"~"^(fitness_centre|sports_centre)$"]', '["shop"~"^(chemist|optician|herbalist|medical_supply)$"]'],
  'Auto Services': ['["shop"~"^(car|car_repair|car_parts|tyres|motorcycle)$"]', '["amenity"~"^(car_wash|car_rental)$"]', '["craft"="car_repair"]'],
  'Retail & Shops': ['["shop"~"^(clothes|shoes|supermarket|convenience|furniture|jewelry|gift|books|variety_store|department_store|boutique|sports|toys|bag|fabric|florist|stationery)$"]'],
  'Legal & Finance': ['["office"~"^(lawyer|accountant|financial|insurance|tax_advisor|notary|financial_advisor)$"]', '["amenity"="bureau_de_change"]'],
  'Beauty & Grooming': ['["shop"~"^(hairdresser|beauty|cosmetics|massage|tattoo|nail_salon|barber)$"]'],
  'Real Estate': ['["office"~"^(estate_agent|property_management)$"]', '["shop"="estate_agent"]'],
  'Education': ['["amenity"~"^(school|college|kindergarten|language_school|driving_school|music_school|training|prep_school)$"]'],
  'Hotels & Travel': ['["tourism"~"^(hotel|guest_house|hostel|motel|apartment|chalet|camp_site)$"]', '["shop"="travel_agency"]', '["office"="travel_agent"]'],
  'Technology': ['["shop"~"^(computer|electronics|mobile_phone|telecommunication)$"]', '["office"~"^(it|telecommunication)$"]'],
  'Construction': ['["craft"~"^(builder|roofer|stonemason|plasterer|scaffolder|metal_construction)$"]', '["office"="construction_company"]', '["shop"~"^(trade|building_materials)$"]'],
};
const TAG_IND = [
  [/^(restaurant|cafe|fast_food|bar|pub|food_court|ice_cream|bakery|butcher|deli|confectionery|beverages|pastry)$/, 'Restaurants & Food'],
  [/^(plumber|electrician|carpenter|painter|hvac|locksmith|gardener|tiler|glaziery|hardware|doityourself|paint|curtain|flooring|window_construction)$/, 'Home Services'],
  [/^(clinic|doctors|dentist|pharmacy|veterinary|fitness_centre|sports_centre|chemist|optician|herbalist|medical_supply)$/, 'Health & Wellness'],
  [/^(car|car_repair|car_parts|tyres|motorcycle|car_wash|car_rental)$/, 'Auto Services'],
  [/^(lawyer|accountant|financial|insurance|tax_advisor|notary|financial_advisor|bureau_de_change)$/, 'Legal & Finance'],
  [/^(hairdresser|beauty|cosmetics|massage|tattoo|nail_salon|barber)$/, 'Beauty & Grooming'],
  [/^(estate_agent|property_management)$/, 'Real Estate'],
  [/^(school|college|kindergarten|language_school|driving_school|music_school|training|prep_school)$/, 'Education'],
  [/^(hotel|guest_house|hostel|motel|apartment|chalet|camp_site|travel_agency|travel_agent)$/, 'Hotels & Travel'],
  [/^(computer|electronics|mobile_phone|telecommunication|it)$/, 'Technology'],
  [/^(builder|roofer|stonemason|plasterer|scaffolder|metal_construction|construction_company|trade|building_materials)$/, 'Construction'],
];
function guessInd(t) {
  for (const k of ['amenity', 'shop', 'craft', 'office', 'tourism', 'leisure', 'healthcare']) {
    const v = t[k]; if (!v) continue;
    for (const [re, ind] of TAG_IND) if (re.test(v)) return ind;
  }
  return t.shop ? 'Retail & Shops' : 'Retail & Shops';
}
function weekKey(ts) { const d = new Date(ts || Date.now()); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); }
function prevWeekKey() { return weekKey(Date.now() - 7 * 864e5); }

let GROWTH_READY = false;
async function ensureGrowth(DB) {
  if (GROWTH_READY) return;
  await DB.batch([
    DB.prepare('CREATE TABLE IF NOT EXISTS wd_places (k TEXT PRIMARY KEY, data TEXT, created INTEGER)'),
    DB.prepare('CREATE TABLE IF NOT EXISTS wd_scans (id INTEGER PRIMARY KEY AUTOINCREMENT, city TEXT, country TEXT, industry TEXT, total INTEGER, nosite INTEGER, user_id TEXT, created INTEGER)'),
    DB.prepare('CREATE TABLE IF NOT EXISTS wd_claims (lead_key TEXT, user_id TEXT, kind TEXT, created INTEGER, PRIMARY KEY (lead_key, user_id))'),
    DB.prepare('CREATE TABLE IF NOT EXISTS wd_feed (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, kind TEXT, text TEXT, created INTEGER)'),
    DB.prepare('CREATE TABLE IF NOT EXISTS wd_wins (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, text TEXT, amount REAL, currency TEXT, city TEXT, created INTEGER, hidden INTEGER DEFAULT 0)'),
    DB.prepare('CREATE TABLE IF NOT EXISTS wd_reacts (win_id INTEGER, user_id TEXT, emoji TEXT, PRIMARY KEY (win_id, user_id, emoji))'),
    DB.prepare('CREATE TABLE IF NOT EXISTS wd_challenges (id TEXT PRIMARY KEY, from_id TEXT, to_id TEXT, metric TEXT, hours INTEGER, status TEXT, created INTEGER, start INTEGER, end INTEGER, from_base INTEGER, to_base INTEGER, from_score INTEGER, to_score INTEGER, winner TEXT)'),
    DB.prepare('CREATE TABLE IF NOT EXISTS wd_referrals (new_user TEXT PRIMARY KEY, referrer TEXT, created INTEGER, claimed_ref INTEGER DEFAULT 0, claimed_new INTEGER DEFAULT 0)'),
  ]);
  for (const col of ['week_key TEXT', 'week_xp INTEGER DEFAULT 0', 'last_week_key TEXT', 'last_week_xp INTEGER DEFAULT 0', 'streak INTEGER DEFAULT 0', 'badges INTEGER DEFAULT 0', 'city TEXT']) {
    try { await DB.prepare('ALTER TABLE wd_profiles ADD COLUMN ' + col).run(); } catch (e) { /* already there */ }
  }
  GROWTH_READY = true;
}

async function osmFetchJSON(url, opts) {
  const r = await fetch(url, { ...opts, headers: { 'User-Agent': OSM_UA, 'Accept': 'application/json', ...(opts && opts.headers || {}) } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
async function findPlaces(city, country, ind) {
  const geo = await osmFetchJSON('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' + encodeURIComponent(city + ', ' + country), {});
  if (!geo || !geo[0]) return { error: 'City not found on the map' };
  const g = geo[0], lat = Number(g.lat), lon = Number(g.lon);
  let [s, n, w, e] = (g.boundingbox || []).map(Number);
  const R = 0.12; // cap the search box to ~13 km around the centre so big cities stay fast
  if (!(s < n) || n - s > 2 * R) { s = lat - R; n = lat + R; }
  if (!(w < e) || e - w > 2 * R) { w = lon - R; e = lon + R; }
  const bbox = [s, w, n, e].map(x => x.toFixed(5)).join(',');
  const sels = ind && OSM_SEL[ind] ? OSM_SEL[ind] : Object.values(OSM_SEL).flat();
  const q = '[out:json][timeout:25];(' + sels.map(sel => 'nwr' + sel + '["name"](' + bbox + ');').join('') + ');out center tags 300;';
  let data = null, lastErr = null;
  for (const url of OVERPASS) {
    try { data = await osmFetchJSON(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }); break; }
    catch (err) { lastErr = err; }
  }
  if (!data) return { error: 'Map service busy — try again in a minute (' + (lastErr && lastErr.message) + ')' };
  const seen = new Set(), out = [];
  for (const el of data.elements || []) {
    const t = el.tags || {};
    if (!t.name) continue;
    const key = 'osm-' + el.type + '-' + el.id;
    const dedupe = (t.name + '|' + (t['addr:street'] || '')).toLowerCase();
    if (seen.has(key) || seen.has(dedupe)) continue;
    seen.add(key); seen.add(dedupe);
    const web = t.website || t['contact:website'] || t.url || '';
    const social = t['contact:facebook'] || t.facebook || t['contact:instagram'] || t.instagram || '';
    out.push({
      key, name: String(t.name).slice(0, 80), ind: ind || guessInd(t),
      phone: String(t.phone || t['contact:phone'] || t['contact:mobile'] || t.mobile || '').split(';')[0].trim().slice(0, 30),
      website: String(web).slice(0, 120), social: String(social).slice(0, 120), email: String(t.email || t['contact:email'] || '').slice(0, 80),
      addr: [t['addr:housenumber'], t['addr:street'], t['addr:suburb'] || t['addr:city']].filter(Boolean).join(' ').slice(0, 120),
      hours: String(t.opening_hours || '').slice(0, 80),
      lat: el.lat != null ? el.lat : (el.center && el.center.lat), lon: el.lon != null ? el.lon : (el.center && el.center.lon),
    });
  }
  return { places: out, center: { lat, lon }, label: g.display_name };
}

async function handleGrowth(ctx) {
  const { request, env, DB, path, m, me } = ctx;
  const url = new URL(request.url);
  await ensureGrowth(DB);
  const q = async (sql, ...a) => (await DB.prepare(sql).bind(...a).first()) || {};
  const all = async (sql, ...a) => ((await DB.prepare(sql).bind(...a).all()).results || []);

  // ---------- real business search ----------
  if (path === 'places' && m === 'GET') {
    const city = str(url.searchParams.get('city'), 60).trim(), country = str(url.searchParams.get('country'), 60).trim();
    const ind = OSM_SEL[url.searchParams.get('ind')] ? url.searchParams.get('ind') : '';
    if (!city || !country) return json({ error: 'Pick a country and a city' }, 400);
    const k = (city + '|' + country + '|' + ind).toLowerCase();
    let cached = await DB.prepare('SELECT data, created FROM wd_places WHERE k = ?').bind(k).first();
    let result = null, fromCache = false;
    if (cached && Date.now() - cached.created < 7 * 864e5) { try { result = JSON.parse(cached.data); fromCache = true; } catch (e) { result = null; } }
    if (!result) {
      const recent = await q('SELECT COUNT(*) AS n FROM wd_scans WHERE user_id = ? AND created > ?', me.id, Date.now() - 3600e3);
      if ((recent.n || 0) >= 40 && !me.isOwner) return json({ error: 'You have searched a lot this hour — take a short break and try again soon.' }, 429);
      result = await findPlaces(city, country, ind);
      if (result.error) return json({ error: result.error }, 502);
      await DB.prepare('INSERT INTO wd_places (k, data, created) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET data = excluded.data, created = excluded.created').bind(k, JSON.stringify(result), Date.now()).run();
      const nosite = result.places.filter(p => !p.website).length;
      await DB.prepare('INSERT INTO wd_scans (city, country, industry, total, nosite, user_id, created) VALUES (?,?,?,?,?,?,?)').bind(city, country, ind || 'All', result.places.length, nosite, me.id, Date.now()).run();
    }
    // community: how many OTHER users already contacted each business
    const keys = result.places.map(p => p.key);
    const claims = {};
    for (let i = 0; i < keys.length; i += 90) {
      const chunk = keys.slice(i, i + 90);
      const rows = await all('SELECT lead_key, COUNT(*) AS n, MAX(created) AS last FROM wd_claims WHERE user_id <> ? AND lead_key IN (' + chunk.map(() => '?').join(',') + ') GROUP BY lead_key', me.id, ...chunk);
      rows.forEach(r => { claims[r.lead_key] = { n: r.n, last: r.last }; });
    }
    return json({ ok: true, cached: fromCache, ...result, claims });
  }

  // ---------- community lead claims ----------
  if (path === 'claims' && m === 'POST') {
    const b = await request.json().catch(() => ({}));
    const keys = (Array.isArray(b.keys) ? b.keys : []).filter(k => /^osm-(node|way|relation)-\d+$/.test(k)).slice(0, 50);
    const kind = ['contacted', 'pipeline', 'won'].includes(b.kind) ? b.kind : 'contacted';
    for (const k of keys) await DB.prepare('INSERT INTO wd_claims (lead_key, user_id, kind, created) VALUES (?,?,?,?) ON CONFLICT(lead_key, user_id) DO UPDATE SET kind = excluded.kind, created = excluded.created').bind(k, me.id, kind, Date.now()).run();
    return json({ ok: true, saved: keys.length });
  }

  // ---------- opportunity radar ----------
  if (path === 'radar' && m === 'GET') {
    const rows = await all('SELECT city, country, SUM(t) AS total, SUM(n) AS nosite, MAX(c) AS updated FROM (SELECT city, country, industry, MAX(total) AS t, MAX(nosite) AS n, MAX(created) AS c FROM wd_scans GROUP BY LOWER(city), LOWER(country), industry) GROUP BY LOWER(city), LOWER(country) ORDER BY nosite DESC LIMIT 30');
    const inds = await all('SELECT industry, SUM(n) AS nosite, SUM(t) AS total FROM (SELECT city, country, industry, MAX(total) AS t, MAX(nosite) AS n FROM wd_scans WHERE industry <> \'All\' GROUP BY LOWER(city), LOWER(country), industry) GROUP BY industry ORDER BY nosite DESC LIMIT 12');
    const tot = await q('SELECT COUNT(DISTINCT LOWER(city) || \'|\' || LOWER(country)) AS cities, COUNT(*) AS scans FROM wd_scans');
    return json({ ok: true, cities: rows, industries: inds, totals: tot });
  }

  // ---------- weekly seasons: champions ----------
  if (path === 'champions' && m === 'GET') {
    const pw = prevWeekKey();
    const rows = await all('SELECT u.name, p.role, p.level, CASE WHEN p.week_key = ? THEN p.week_xp WHEN p.last_week_key = ? THEN p.last_week_xp ELSE 0 END AS score FROM wd_profiles p JOIN users u ON u.id = p.user_id LEFT JOIN wd_flags f ON f.user_id = p.user_id WHERE COALESCE(f.hidden,0) = 0 AND COALESCE(f.banned,0) = 0 ORDER BY score DESC LIMIT 3', pw, pw);
    return json({ ok: true, week: pw, champions: rows.filter(r => r.score > 0) });
  }

  // ---------- live activity feed ----------
  if (path === 'feed' && m === 'GET') {
    const rows = await all('SELECT fd.id, fd.kind, fd.text, fd.created, u.name, fd.user_id = ? AS mine FROM wd_feed fd JOIN users u ON u.id = fd.user_id LEFT JOIN wd_flags f ON f.user_id = fd.user_id WHERE COALESCE(f.banned,0) = 0 ORDER BY fd.id DESC LIMIT 40', me.id);
    return json({ ok: true, items: rows });
  }
  if (path === 'feed' && m === 'POST') {
    const b = await request.json().catch(() => ({}));
    const kinds = ['deal', 'level', 'rank', 'badge', 'streak', 'challenge', 'mission', 'win', 'join', 'search'];
    if (!kinds.includes(b.kind)) return json({ error: 'Bad kind' }, 400);
    const today = await q('SELECT COUNT(*) AS n FROM wd_feed WHERE user_id = ? AND created > ?', me.id, Date.now() - 864e5);
    if ((today.n || 0) >= 25) return json({ ok: true, skipped: true });
    await DB.prepare('INSERT INTO wd_feed (user_id, kind, text, created) VALUES (?,?,?,?)').bind(me.id, b.kind, str(b.text, 140), Date.now()).run();
    return json({ ok: true });
  }

  // ---------- win wall ----------
  if (path === 'wins' && m === 'GET') {
    const rows = await all('SELECT w.id, w.text, w.amount, w.currency, w.city, w.created, u.name, w.user_id = ? AS mine FROM wd_wins w JOIN users u ON u.id = w.user_id WHERE w.hidden = 0 ORDER BY w.id DESC LIMIT 40', me.id);
    const ids = rows.map(r => r.id);
    const reacts = ids.length ? await all('SELECT win_id, emoji, COUNT(*) AS n, SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS me FROM wd_reacts WHERE win_id IN (' + ids.map(() => '?').join(',') + ') GROUP BY win_id, emoji', me.id, ...ids) : [];
    rows.forEach(r => { r.reacts = {}; r.myReacts = []; });
    reacts.forEach(x => { const r = rows.find(y => y.id === x.win_id); if (r) { r.reacts[x.emoji] = x.n; if (x.me) r.myReacts.push(x.emoji); } });
    return json({ ok: true, wins: rows });
  }
  if (path === 'wins' && m === 'POST') {
    const b = await request.json().catch(() => ({}));
    const text = str(b.text, 280).trim();
    if (text.length < 3) return json({ error: 'Write a few words about your win' }, 400);
    const today = await q('SELECT COUNT(*) AS n FROM wd_wins WHERE user_id = ? AND created > ?', me.id, Date.now() - 864e5);
    if ((today.n || 0) >= 5) return json({ error: 'Max 5 wins per day — save some for tomorrow!' }, 429);
    await DB.prepare('INSERT INTO wd_wins (user_id, text, amount, currency, city, created) VALUES (?,?,?,?,?,?)').bind(me.id, text, Math.max(0, Math.min(1e9, Number(b.amount) || 0)), str(b.currency, 8), str(b.city, 60), Date.now()).run();
    return json({ ok: true });
  }
  if (path === 'wins/react' && m === 'POST') {
    const b = await request.json().catch(() => ({}));
    const emoji = ['🔥', '👏', '💰', '🚀'].includes(b.emoji) ? b.emoji : null;
    const id = int(b.id);
    if (!emoji || !id) return json({ error: 'Bad reaction' }, 400);
    const had = await DB.prepare('SELECT 1 AS x FROM wd_reacts WHERE win_id = ? AND user_id = ? AND emoji = ?').bind(id, me.id, emoji).first();
    if (had) await DB.prepare('DELETE FROM wd_reacts WHERE win_id = ? AND user_id = ? AND emoji = ?').bind(id, me.id, emoji).run();
    else await DB.prepare('INSERT INTO wd_reacts (win_id, user_id, emoji) VALUES (?,?,?)').bind(id, me.id, emoji).run();
    return json({ ok: true, on: !had });
  }
  if (path === 'wins/delete' && m === 'POST') {
    const b = await request.json().catch(() => ({}));
    const w = await DB.prepare('SELECT user_id FROM wd_wins WHERE id = ?').bind(int(b.id)).first();
    if (!w) return json({ error: 'Not found' }, 404);
    if (w.user_id !== me.id && !me.isOwner) return json({ error: 'Not yours' }, 403);
    await DB.prepare('UPDATE wd_wins SET hidden = 1 WHERE id = ?').bind(int(b.id)).run();
    return json({ ok: true });
  }

  // ---------- 1v1 challenges ----------
  const METRIC = { contacts: 'contacts', leads: 'leads', deals: 'deals', xp: 'xp' };
  const score = async (uid, metric) => ((await q('SELECT ' + METRIC[metric] + ' AS v FROM wd_profiles WHERE user_id = ?', uid)).v || 0);
  async function resolveDue() {
    const due = await all("SELECT * FROM wd_challenges WHERE status = 'active' AND end < ? AND (from_id = ? OR to_id = ?)", Date.now(), me.id, me.id);
    for (const c of due) {
      const a = (await score(c.from_id, c.metric)) - c.from_base, b2 = (await score(c.to_id, c.metric)) - c.to_base;
      const winner = a > b2 ? c.from_id : b2 > a ? c.to_id : 'draw';
      await DB.prepare("UPDATE wd_challenges SET status = 'done', from_score = ?, to_score = ?, winner = ? WHERE id = ?").bind(a, b2, winner, c.id).run();
      if (winner !== 'draw') {
        const wn = await q('SELECT name FROM users WHERE id = ?', winner);
        const ln = await q('SELECT name FROM users WHERE id = ?', winner === c.from_id ? c.to_id : c.from_id);
        await DB.prepare('INSERT INTO wd_feed (user_id, kind, text, created) VALUES (?,?,?,?)').bind(winner, 'challenge', 'won a ' + c.metric + ' challenge vs ' + (ln.name || 'a rival') + ' (' + Math.max(a, b2) + '–' + Math.min(a, b2) + ')', Date.now()).run();
      }
    }
    await DB.prepare("UPDATE wd_challenges SET status = 'expired' WHERE status = 'pending' AND created < ?").bind(Date.now() - 2 * 864e5).run();
  }
  if (path === 'challenges' && m === 'GET') {
    await resolveDue();
    const rows = await all('SELECT c.*, uf.name AS from_name, ut.name AS to_name FROM wd_challenges c JOIN users uf ON uf.id = c.from_id JOIN users ut ON ut.id = c.to_id WHERE c.from_id = ? OR c.to_id = ? ORDER BY c.created DESC LIMIT 30', me.id, me.id);
    for (const c of rows) {
      c.mine = c.from_id === me.id ? 'from' : 'to';
      if (c.status === 'active') { c.from_now = (await score(c.from_id, c.metric)) - c.from_base; c.to_now = (await score(c.to_id, c.metric)) - c.to_base; }
      c.youWon = c.winner === me.id;
      delete c.from_id; delete c.to_id; delete c.winner;
    }
    return json({ ok: true, challenges: rows });
  }
  if (path === 'challenges' && m === 'POST') {
    const b = await request.json().catch(() => ({}));
    const to = str(b.to, 80), metric = METRIC[b.metric] ? b.metric : 'contacts', hours = [24, 72, 168].includes(Number(b.hours)) ? Number(b.hours) : 24;
    if (!to || to === me.id) return json({ error: "You can't challenge yourself" }, 400);
    const target = await q('SELECT id FROM users WHERE id = ?', to);
    if (!target.id) return json({ error: 'User not found' }, 404);
    const open = await q("SELECT COUNT(*) AS n FROM wd_challenges WHERE (from_id = ? OR to_id = ?) AND status IN ('pending','active')", me.id, me.id);
    if ((open.n || 0) >= 5) return json({ error: 'You already have 5 open challenges — finish those first' }, 429);
    const id = 'c' + Date.now() + Math.random().toString(36).slice(2, 6);
    await DB.prepare("INSERT INTO wd_challenges (id, from_id, to_id, metric, hours, status, created) VALUES (?,?,?,?,?,'pending',?)").bind(id, me.id, to, metric, hours, Date.now()).run();
    return json({ ok: true, id });
  }
  if (path === 'challenges/respond' && m === 'POST') {
    const b = await request.json().catch(() => ({}));
    const c = await DB.prepare("SELECT * FROM wd_challenges WHERE id = ? AND to_id = ? AND status = 'pending'").bind(str(b.id, 60), me.id).first();
    if (!c) return json({ error: 'Challenge not found' }, 404);
    if (!b.accept) { await DB.prepare("UPDATE wd_challenges SET status = 'declined' WHERE id = ?").bind(c.id).run(); return json({ ok: true }); }
    const now = Date.now();
    await DB.prepare("UPDATE wd_challenges SET status = 'active', start = ?, end = ?, from_base = ?, to_base = ? WHERE id = ?")
      .bind(now, now + c.hours * 3600e3, await score(c.from_id, c.metric), await score(c.to_id, c.metric), c.id).run();
    return json({ ok: true });
  }

  // ---------- referrals ----------
  if (path === 'referral' && m === 'POST') {
    const b = await request.json().catch(() => ({}));
    const ref = str(b.code, 80);
    const mine = await q('SELECT created FROM users WHERE id = ?', me.id);
    if (!ref || ref === me.id) return json({ error: 'Invalid invite' }, 400);
    if (!mine.created || Date.now() - mine.created > 7 * 864e5) return json({ error: 'Invites only count for new accounts' }, 400);
    const r = await q('SELECT id FROM users WHERE id = ?', ref);
    if (!r.id) return json({ error: 'Invite not found' }, 404);
    await DB.prepare('INSERT OR IGNORE INTO wd_referrals (new_user, referrer, created) VALUES (?,?,?)').bind(me.id, ref, Date.now()).run();
    return json({ ok: true });
  }
  if (path === 'referral/claim' && m === 'POST') {
    const asRef = await all('SELECT r.new_user, u.name FROM wd_referrals r JOIN users u ON u.id = r.new_user WHERE r.referrer = ? AND r.claimed_ref = 0', me.id);
    const asNew = await q('SELECT r.referrer, u.name FROM wd_referrals r JOIN users u ON u.id = r.referrer WHERE r.new_user = ? AND r.claimed_new = 0', me.id);
    await DB.prepare('UPDATE wd_referrals SET claimed_ref = 1 WHERE referrer = ?').bind(me.id).run();
    await DB.prepare('UPDATE wd_referrals SET claimed_new = 1 WHERE new_user = ?').bind(me.id).run();
    const total = await q('SELECT COUNT(*) AS n FROM wd_referrals WHERE referrer = ?', me.id);
    return json({ ok: true, invited: asRef.map(x => x.name), invitedBy: asNew.referrer ? asNew.name : null, totalInvites: total.n || 0 });
  }

  // ---------- owner moderation ----------
  if (path === 'admin/feed-delete' && m === 'POST' && me.isOwner) {
    const b = await request.json().catch(() => ({}));
    await DB.prepare('DELETE FROM wd_feed WHERE id = ?').bind(int(b.id)).run();
    return json({ ok: true });
  }
  return null;
}

async function handlePulse(DB) {
  await ensureGrowth(DB);
  const q = async (sql) => (await DB.prepare(sql).first()) || {};
  const u = await q('SELECT COUNT(*) AS n FROM users');
  const p = await q('SELECT COALESCE(SUM(leads),0) AS leads, COALESCE(SUM(contacts),0) AS contacts, COALESCE(SUM(deals),0) AS deals FROM wd_profiles');
  const s = await q('SELECT COUNT(*) AS scans, COALESCE(SUM(nosite),0) AS nosite FROM (SELECT MAX(nosite) AS nosite FROM wd_scans GROUP BY LOWER(city), LOWER(country), industry)');
  const c = await q('SELECT COUNT(DISTINCT LOWER(city) || \'|\' || LOWER(country)) AS cities FROM wd_scans');
  return json({ ok: true, users: u.n || 0, leads: p.leads || 0, contacts: p.contacts || 0, deals: p.deals || 0, noWebsite: s.nosite || 0, cities: c.cities || 0 });
}

// ───────────── user data sync ─────────────
const MAX_BYTES = 900000; // D1 rows must stay under ~1 MB


async function handleData(context, segs) {
  const { request, env } = context;
  const params = { path: segs };
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  const DB = env.DB;
  const path = (params.path || []).join('/');
  if (path !== 'blob') return json({ error: 'Not found' }, 404);

  try {
    await DB.prepare('CREATE TABLE IF NOT EXISTS user_data (user_id TEXT PRIMARY KEY, data TEXT, updated INTEGER)').run();

    const sid = request.headers.get('Authorization')?.replace('Bearer ', '');
    if (!sid) return json({ error: 'No session' }, 401);
    const s = await DB.prepare('SELECT user_id FROM sessions WHERE id = ? AND expires > ?').bind(sid, Date.now()).first();
    if (!s) return json({ error: 'Session expired' }, 401);
    const uid = s.user_id;

    if (request.method === 'GET') {
      const row = await DB.prepare('SELECT data, updated FROM user_data WHERE user_id = ?').bind(uid).first();
      if (!row) return json({ ok: true, data: null, updated: null });
      let data = null;
      try { data = JSON.parse(row.data); } catch (e) { data = null; }
      return json({ ok: true, data, updated: row.updated });
    }

    if (request.method === 'PUT') {
      const body = await request.json();
      if (!body || typeof body.data !== 'object' || body.data === null) return json({ error: 'Missing data' }, 400);
      const text = JSON.stringify(body.data);
      if (text.length > MAX_BYTES) return json({ error: 'Data too large to sync — delete old leads or notes' }, 413);
      const now = Date.now();
      await DB.prepare('INSERT INTO user_data (user_id, data, updated) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated = excluded.updated')
        .bind(uid, text, now).run();
      return json({ ok: true, updated: now });
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (err) {
    return json({ error: err.message || 'Server error' }, 500);
  }
}


export async function onRequest(context) {
  const segs = context.params.route || [];
  if (context.request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (segs[0] === 'wd') return handleWd(context, segs.slice(1));
  if (segs[0] === 'data') return handleData(context, segs.slice(1));
  return json({ error: 'Not found' }, 404);
}

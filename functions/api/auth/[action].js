// We Deploy — /api/auth/[action]
// Handles: signup, login, me, logout, ping

export async function onRequest(context) {
  const { request, env, params } = context;
  const action = params.action;

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: cors });
  }

  try {
    // ========== PING (connection test) ==========
    if (action === 'ping' && request.method === 'GET') {
      const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
      return json({ ok: true, users: row.n }, 200, cors);
    }

    // ========== SIGNUP ==========
    if (action === 'signup' && request.method === 'POST') {
      const body = await request.json();
      const { name, email, biz, password } = body;

      if (!name || !email || !password || password.length < 6) {
        return json({ error: 'Name, email and password (min 6 chars) required' }, 400, cors);
      }

      if (!(await signupsOpen(env)) && email.toLowerCase() !== OWNER_EMAIL) {
        return json({ error: 'New sign-ups are closed right now' }, 403, cors);
      }

      if (email.toLowerCase() !== OWNER_EMAIL) {
        const ipWhy = await ipBlockMsg(env, clientIp(request));
        if (ipWhy) return json({ error: ipWhy }, 403, cors);
      }
      // anti-spam: max 20 new accounts per network per hour (mobile networks share IPs)
      const ip = clientIp(request);
      await ensureSec(env);
      const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM wd_auth_fail WHERE k = ? AND t > ?').bind('su:' + ip, Date.now() - 3600e3).first();
      if (recent && recent.n >= 20 && email.toLowerCase() !== OWNER_EMAIL) {
        return json({ error: 'Too many new accounts from this network. Please try again in an hour.' }, 429, cors);
      }

      const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email.toLowerCase()).first();
      if (existing) {
        return json({ error: 'Email already registered' }, 409, cors);
      }

      const id = 'u' + Date.now() + randHex(3);
      const salt = randHex(16);
      const hash = await hashPassword(password, salt);

      await env.DB.prepare(
        'INSERT INTO users (id, email, name, biz, salt, hash, created) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(id, email.toLowerCase(), name, biz || '', salt, hash, Date.now()).run();

      await env.DB.prepare('INSERT INTO wd_auth_fail (k, t) VALUES (?, ?)').bind('su:' + ip, Date.now()).run();
      const sessionId = await createSession(env, id);
      await recordLogin(env, request, id, 'signup');
      return json({ ok: true, user: { id, name, email: email.toLowerCase(), biz }, session: sessionId }, 200, cors);
    }

    // ========== LOGIN ==========
    if (action === 'login' && request.method === 'POST') {
      const body = await request.json();
      const { email, password } = body;

      if (!email || !password) {
        return json({ error: 'Email and password required' }, 400, cors);
      }

      // brute-force protection: 5 wrong passwords on one account = 15 min lock; 100 fails from one network = 15 min lock
      await ensureSec(env);
      const em = email.toLowerCase(), ip = clientIp(request), since = Date.now() - LOCK_MS;
      const fe = await env.DB.prepare('SELECT COUNT(*) AS n, MIN(t) AS first FROM wd_auth_fail WHERE k = ? AND t > ?').bind('e:' + em, since).first();
      const fi = await env.DB.prepare('SELECT COUNT(*) AS n, MIN(t) AS first FROM wd_auth_fail WHERE k = ? AND t > ?').bind('ip:' + ip, since).first();
      const locked = (fe && fe.n >= MAX_FAILS_EMAIL) ? fe : (fi && fi.n >= MAX_FAILS_IP) ? fi : null;
      if (locked) {
        const mins = Math.max(1, Math.ceil((locked.first + LOCK_MS - Date.now()) / 60000));
        return json({ error: 'Too many wrong attempts. For your safety this sign-in is locked for ' + mins + ' minute' + (mins === 1 ? '' : 's') + '.', locked: true, minutes: mins }, 429, cors);
      }
      const fail = async () => {
        await env.DB.batch([
          env.DB.prepare('INSERT INTO wd_auth_fail (k, t) VALUES (?, ?)').bind('e:' + em, Date.now()),
          env.DB.prepare('INSERT INTO wd_auth_fail (k, t) VALUES (?, ?)').bind('ip:' + ip, Date.now())
        ]);
        if (Math.random() < 0.05) await env.DB.prepare('DELETE FROM wd_auth_fail WHERE t < ?').bind(Date.now() - 864e5 * 2).run();
        const left = MAX_FAILS_EMAIL - ((fe && fe.n) || 0) - 1;
        return left > 0 && left <= 2 ? ' — ' + left + ' attempt' + (left === 1 ? '' : 's') + ' left before a 15-minute lock' : '';
      };

      const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(em).first();
      if (!user) {
        const w = await fail();
        return json({ error: 'Incorrect email or password' + w }, 401, cors);
      }

      const hash = await hashPassword(password, user.salt);
      if (hash !== user.hash) {
        const w = await fail();
        return json({ error: 'Incorrect email or password' + w, exists: true }, 401, cors);
      }
      await env.DB.prepare('DELETE FROM wd_auth_fail WHERE k = ?').bind('e:' + em).run();

      const why = await blockMsg(env, user);
      if (why) return json({ error: why, blocked: true, locked: true }, 403, cors);
      if (String(user.email || '').toLowerCase() !== OWNER_EMAIL) {
        const ipWhy = await ipBlockMsg(env, ip);
        if (ipWhy) return json({ error: ipWhy, blocked: true, locked: true }, 403, cors);
      }

      const sessionId = await createSession(env, user.id);
      await recordLogin(env, request, user.id, 'login');
      return json({
        ok: true,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          biz: user.biz,
          owner_unlocked: !!user.owner_unlocked
        },
        session: sessionId
      }, 200, cors);
    }

    // ========== ME (check session) ==========
    if (action === 'me' && request.method === 'GET') {
      const sessionId = request.headers.get('Authorization')?.replace('Bearer ', '');
      if (!sessionId) return json({ error: 'No session' }, 401, cors);

      const session = await env.DB.prepare('SELECT * FROM sessions WHERE id = ? AND expires > ?')
        .bind(sessionId, Date.now()).first();
      if (!session) return json({ error: 'Session expired' }, 401, cors);

      const user = await env.DB.prepare('SELECT id, name, email, biz, owner_unlocked FROM users WHERE id = ?')
        .bind(session.user_id).first();
      if (!user) return json({ error: 'User not found' }, 404, cors);
      if (await isBanned(env, user)) return json({ error: 'This account has been suspended' }, 403, cors);

      return json({ ok: true, user }, 200, cors);
    }

    // ========== LOGOUT ==========
    if (action === 'logout' && request.method === 'POST') {
      const sessionId = request.headers.get('Authorization')?.replace('Bearer ', '');
      if (sessionId) {
        await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
      }
      return json({ ok: true }, 200, cors);
    }

    return json({ error: 'Not found' }, 404, cors);

  } catch (err) {
    return json({ error: err.message || 'Server error' }, 500, cors);
  }
}

// Helper functions
const OWNER_EMAIL = 'delonmayne@gmail.com';

// Owner switches live in wd_site (created by /api/wd). Missing table = defaults.
async function signupsOpen(env) {
  try {
    const row = await env.DB.prepare("SELECT v FROM wd_site WHERE k = 'config'").first();
    if (!row) return true;
    return JSON.parse(row.v).allowSignups !== false;
  } catch (e) { return true; }
}
async function isBanned(env, user) { return !!(await blockMsg(env, user)); }
// why this account can't sign in right now (banned forever / suspended for a while) — or null
async function blockMsg(env, user) {
  if (String(user.email || '').toLowerCase() === OWNER_EMAIL) return null;
  let f = null;
  try { f = await env.DB.prepare('SELECT * FROM wd_flags WHERE user_id = ?').bind(user.id).first(); } catch (e) { return null; }
  if (!f) return null;
  const why = f.reason ? ' Reason: ' + f.reason : '';
  if (f.banned) return '⛔ This account has been banned.' + why;
  const until = Number(f.suspended_until || 0);
  if (until > Date.now()) {
    if (until >= 9e15) return '⏸ This account is suspended.' + why;
    const ms = until - Date.now(), d = Math.floor(ms / 864e5), h = Math.floor(ms % 864e5 / 36e5), m = Math.ceil(ms % 36e5 / 6e4);
    return '⏸ This account is suspended for another ' + ((d ? d + 'd ' : '') + (h ? h + 'h ' : '') + (!d ? m + 'min' : '')).trim() + '.' + why;
  }
  return null;
}
async function ipBlockMsg(env, ip) {
  if (!ip || ip === 'unknown') return null;
  try {
    const r = await env.DB.prepare('SELECT until FROM wd_ip_blocks WHERE ip = ? AND until > ?').bind(ip, Date.now()).first();
    return r ? '🚫 Access from your network has been blocked by the site owner.' : null;
  } catch (e) { return null; }
}

function json(data, status = 200, cors = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors }
  });
}

async function hashPassword(pw, salt) {
  const data = new TextEncoder().encode('wd·' + salt + '·' + pw + '·' + salt);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------- security helpers ----------
const LOCK_MS = 15 * 60 * 1000, MAX_FAILS_EMAIL = 5, MAX_FAILS_IP = 100;
function randHex(bytes) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes))).map(b => b.toString(16).padStart(2, '0')).join('');
}
function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim() || 'unknown';
}
function maskIp(ip) {
  if (!ip || ip === 'unknown') return 'unknown';
  if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':') + ':…';
  const p = ip.split('.'); return p.length === 4 ? p[0] + '.' + p[1] + '.' + p[2] + '.x' : ip;
}
function deviceName(ua) {
  ua = String(ua || '');
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iOS/i.test(ua) ? 'iPhone/iPad' : /Windows/i.test(ua) ? 'Windows' : /Mac OS X|Macintosh/i.test(ua) ? 'Mac' : /Linux/i.test(ua) ? 'Linux' : 'Unknown device';
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return br + ' on ' + os;
}
let _secReady = false;
async function ensureSec(env) {
  if (_secReady) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS wd_auth_fail (k TEXT, t INTEGER)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS wd_auth_fail_k ON wd_auth_fail (k, t)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS wd_logins (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, t INTEGER, ip TEXT, country TEXT, city TEXT, device TEXT, kind TEXT)')
  ]);
  try { await env.DB.prepare('ALTER TABLE wd_logins ADD COLUMN ip_full TEXT').run(); } catch (e) {}
  _secReady = true;
}
async function recordLogin(env, request, userId, kind) {
  try {
    await ensureSec(env);
    const cf = request.cf || {};
    // ip = shortened (shown to the user), ip_full = full address (visible only to the owner, for security)
    await env.DB.prepare('INSERT INTO wd_logins (user_id, t, ip, country, city, device, kind, ip_full) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(userId, Date.now(), maskIp(clientIp(request)), cf.country || '', cf.city || '', deviceName(request.headers.get('User-Agent')), kind, clientIp(request)).run();
  } catch (e) {}
}

async function createSession(env, userId) {
  const id = 's' + randHex(24);   // 192-bit random session key (unguessable)
  const expires = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days
  await env.DB.prepare('INSERT INTO sessions (id, user_id, created, expires) VALUES (?, ?, ?, ?)')
    .bind(id, userId, Date.now(), expires).run();
  return id;
}

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

      const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email.toLowerCase()).first();
      if (existing) {
        return json({ error: 'Email already registered' }, 409, cors);
      }

      const id = 'u' + Date.now() + Math.random().toString(36).slice(2, 6);
      const salt = Math.random().toString(36).slice(2, 10);
      const hash = await hashPassword(password, salt);

      await env.DB.prepare(
        'INSERT INTO users (id, email, name, biz, salt, hash, created) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(id, email.toLowerCase(), name, biz || '', salt, hash, Date.now()).run();

      const sessionId = await createSession(env, id);
      return json({ ok: true, user: { id, name, email: email.toLowerCase(), biz }, session: sessionId }, 200, cors);
    }

    // ========== LOGIN ==========
    if (action === 'login' && request.method === 'POST') {
      const body = await request.json();
      const { email, password } = body;

      if (!email || !password) {
        return json({ error: 'Email and password required' }, 400, cors);
      }

      const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email.toLowerCase()).first();
      if (!user) {
        return json({ error: 'Incorrect email or password' }, 401, cors);
      }

      const hash = await hashPassword(password, user.salt);
      if (hash !== user.hash) {
        return json({ error: 'Incorrect email or password' }, 401, cors);
      }

      const sessionId = await createSession(env, user.id);
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

async function createSession(env, userId) {
  const id = 's' + Date.now() + Math.random().toString(36).slice(2, 8);
  const expires = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days
  await env.DB.prepare('INSERT INTO sessions (id, user_id, created, expires) VALUES (?, ?, ?, ?)')
    .bind(id, userId, Date.now(), expires).run();
  return id;
}

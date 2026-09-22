// We Deploy — /api/invoices/[[path]]
// Handles: list, create, get, update, delete (all session-protected)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const TEXTF = ['num','date','due_date','client_name','client_email','client_phone','client_addr','client_country','currency','notes','payment_instructions','stripe_link','paypal_link','qr_target','status'];
const REALF = ['subtotal','discount_pct','tax_pct','shipping','total'];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS }
  });
}

function num(v, d = 0) {
  const n = parseFloat(v);
  return isNaN(n) ? d : n;
}

function itemId(now, i) {
  return 'ii' + now + '_' + i + '_' + Math.random().toString(36).slice(2, 5);
}

export async function onRequest(context) {
  const { request, env, params } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }

  try {
    // ---------- AUTH: session -> user ----------
    const sessionId = request.headers.get('Authorization')?.replace('Bearer ', '');
    if (!sessionId) return json({ error: 'No session' }, 401);

    const session = await env.DB.prepare('SELECT * FROM sessions WHERE id = ? AND expires > ?')
      .bind(sessionId, Date.now()).first();
    if (!session) return json({ error: 'Session expired' }, 401);

    const userId = session.user_id;

    // ---------- ROUTING ----------
    const tail = params.path || [];
    const id = tail[0] || null;
    const now = Date.now();

    // ===== LIST all invoices for this user =====
    if (!id && request.method === 'GET') {
      const invRes = await env.DB.prepare('SELECT * FROM invoices WHERE user_id = ? ORDER BY created DESC')
        .bind(userId).all();
      const invRows = invRes.results || [];

      const itemRes = await env.DB.prepare('SELECT * FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE user_id = ?)')
        .bind(userId).all();
      const byInv = {};
      for (const it of (itemRes.results || [])) {
        (byInv[it.invoice_id] = byInv[it.invoice_id] || []).push(it);
      }

      const out = invRows.map(inv => ({ ...inv, items: byInv[inv.id] || [] }));
      return json({ ok: true, invoices: out });
    }

    // ===== CREATE new invoice =====
    if (!id && request.method === 'POST') {
      const body = await request.json();
      const get = (k, d = null) => (body[k] === undefined || body[k] === null) ? d : body[k];

      const newId = 'inv' + now + Math.random().toString(36).slice(2, 6);

      await env.DB.prepare(
        'INSERT INTO invoices (id, user_id, num, date, due_date, client_name, client_email, client_phone, client_addr, client_country, currency, subtotal, discount_pct, tax_pct, shipping, total, notes, payment_instructions, stripe_link, paypal_link, qr_target, status, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
      ).bind(
        newId, userId,
        get('num') || ('INV-' + now),
        get('date'), get('due_date'),
        get('client_name'), get('client_email'), get('client_phone'), get('client_addr'), get('client_country'),
        get('currency', 'USD $'),
        num(get('subtotal')), num(get('discount_pct')), num(get('tax_pct')), num(get('shipping')), num(get('total')),
        get('notes'), get('payment_instructions'), get('stripe_link'), get('paypal_link'), get('qr_target'),
        get('status', 'draft'), now, now
      ).run();

      const items = Array.isArray(body.items) ? body.items : [];
      if (items.length) {
        const stmt = env.DB.prepare('INSERT INTO invoice_items (id, invoice_id, description, qty, rate, amount) VALUES (?,?,?,?,?,?)');
        await env.DB.batch(items.map((it, i) =>
          stmt.bind(itemId(now, i), newId, it.description || '', num(it.qty, 1), num(it.rate), num(it.amount))
        ));
      }

      return json({ ok: true, id: newId }, 200);
    }

    // ===== Everything below needs an invoice id =====
    if (!id) return json({ error: 'Not found' }, 404);

    // ===== GET one invoice =====
    if (request.method === 'GET') {
      const inv = await env.DB.prepare('SELECT * FROM invoices WHERE id = ? AND user_id = ?')
        .bind(id, userId).first();
      if (!inv) return json({ error: 'Invoice not found' }, 404);

      const itemRes = await env.DB.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY rowid')
        .bind(id).all();
      return json({ ok: true, invoice: { ...inv, items: itemRes.results || [] } });
    }

    // ===== UPDATE invoice =====
    if (request.method === 'PUT') {
      const existing = await env.DB.prepare('SELECT id FROM invoices WHERE id = ? AND user_id = ?')
        .bind(id, userId).first();
      if (!existing) return json({ error: 'Invoice not found' }, 404);

      const body = await request.json();
      const sets = [], vals = [];

      for (const f of TEXTF) {
        if (body[f] !== undefined) { sets.push(f + ' = ?'); vals.push(body[f] === null ? null : String(body[f])); }
      }
      for (const f of REALF) {
        if (body[f] !== undefined) { sets.push(f + ' = ?'); vals.push(num(body[f])); }
      }

      if (sets.length) {
        sets.push('updated = ?'); vals.push(now);
        vals.push(id, userId);
        await env.DB.prepare('UPDATE invoices SET ' + sets.join(', ') + ' WHERE id = ? AND user_id = ?')
          .bind(...vals).run();
      }

      if (Array.isArray(body.items)) {
        await env.DB.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').bind(id).run();
        if (body.items.length) {
          const stmt = env.DB.prepare('INSERT INTO invoice_items (id, invoice_id, description, qty, rate, amount) VALUES (?,?,?,?,?,?)');
          await env.DB.batch(body.items.map((it, i) =>
            stmt.bind(itemId(now, i), id, it.description || '', num(it.qty, 1), num(it.rate), num(it.amount))
          ));
        }
      }

      const inv = await env.DB.prepare('SELECT * FROM invoices WHERE id = ?').bind(id).first();
      const itemRes = await env.DB.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY rowid').bind(id).all();
      return json({ ok: true, invoice: { ...inv, items: itemRes.results || [] } });
    }

    // ===== DELETE invoice =====
    if (request.method === 'DELETE') {
      const existing = await env.DB.prepare('SELECT id FROM invoices WHERE id = ? AND user_id = ?')
        .bind(id, userId).first();
      if (!existing) return json({ error: 'Invoice not found' }, 404);

      await env.DB.batch([
        env.DB.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').bind(id),
        env.DB.prepare('DELETE FROM invoice_reminders WHERE invoice_id = ?').bind(id),
        env.DB.prepare('DELETE FROM invoices WHERE id = ? AND user_id = ?').bind(id, userId)
      ]);
      return json({ ok: true });
    }

    return json({ error: 'Not found' }, 404);

  } catch (err) {
    return json({ error: err.message || 'Server error' }, 500);
  }
}

// We Deploy — functions/_middleware.js (v3)
// 1) Adds security headers to every response (anti-clickjacking, anti-sniffing, HTTPS-only, privacy).
// 2) Injects backend bridge + data sync scripts into every HTML page.

const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',          // HTTPS only
  'X-Frame-Options': 'DENY',                                                    // nobody can put the site inside their page (clickjacking)
  'Content-Security-Policy': "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; upgrade-insecure-requests",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',                         // don't leak full URLs to other sites
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
  'X-Permitted-Cross-Domain-Policies': 'none'
};

function secure(res, extra) {
  const headers = new Headers(res.headers);
  for (const k in SECURITY_HEADERS) headers.set(k, SECURITY_HEADERS[k]);
  if (extra) extra(headers);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export async function onRequest(context) {
  const { request, next } = context;
  const res = await next();

  const url = new URL(request.url);
  const ct = res.headers.get('content-type') || '';
  if (url.pathname.startsWith('/api/')) return secure(res, h => h.set('Cache-Control', 'no-store'));
  if (!ct.includes('text/html')) return secure(res);

  try {
    let html = await res.text();
    const tag = '<script src="/app-api.js"></script><script src="/app-sync.js"></script>';
    if (!html.includes('app-api.js')) {
      const idx = html.lastIndexOf('</body>');
      if (idx !== -1) html = html.slice(0, idx) + tag + html.slice(idx);
      else html += tag;
    }
    const headers = new Headers(res.headers);
    headers.delete('content-encoding');
    headers.delete('content-length');
    headers.delete('etag');
    for (const k in SECURITY_HEADERS) headers.set(k, SECURITY_HEADERS[k]);
    return new Response(html, { status: res.status, headers });
  } catch (e) {
    return secure(res);
  }
}

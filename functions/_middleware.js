// We Deploy — functions/_middleware.js (v2)
// Injects backend bridge + data sync scripts into every HTML page.

export async function onRequest(context) {
  const { request, next } = context;
  const res = await next();

  const url = new URL(request.url);
  const ct = res.headers.get('content-type') || '';
  if (url.pathname.startsWith('/api/')) return res;
  if (!ct.includes('text/html')) return res;

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
    return new Response(html, { status: res.status, headers });
  } catch (e) {
    return res;
  }
}    return res;
  }
}

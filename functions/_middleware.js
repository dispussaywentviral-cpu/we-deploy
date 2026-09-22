// We Deploy — functions/_middleware.js
// Injects <script src="/app-api.js"></script> into every HTML page
// so the backend bridge loads WITHOUT ever editing index.html.

export async function onRequest(context) {
  const { request, next } = context;

  const res = await next();

  const url = new URL(request.url);
  const ct = res.headers.get('content-type') || '';

  // Only touch HTML pages — leave API routes and static files alone
  if (url.pathname.startsWith('/api/')) return res;
  if (!ct.includes('text/html')) return res;

  try {
    let html = await res.text();
    const tag = '<script src="/app-api.js"></script>';

    if (!html.includes('app-api.js')) {
      const idx = html.lastIndexOf('</body>');
      if (idx !== -1) {
        html = html.slice(0, idx) + tag + html.slice(idx);
      } else {
        html += tag;
      }
    }

    const headers = new Headers(res.headers);
    headers.delete('content-encoding');
    headers.delete('content-length');
    headers.delete('etag');

    return new Response(html, { status: res.status, headers });
  } catch (e) {
    return res;
  }
}

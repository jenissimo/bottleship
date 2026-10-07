// Versioned internal chunk responses are stored as 200: Cache API refuses 206.
interface Env { APPS: R2Bucket }

export const onRequest: PagesFunction<Env> = async ({ params, request, env, waitUntil }) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const key = (Array.isArray(params.path) ? params.path : [params.path]).join("/");
  const meta = await env.APPS.head(key);
  if (!meta) return new Response(null, { status: 404 });
  const headers = new Headers();
  meta.writeHttpMetadata(headers);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("ETag", meta.httpEtag);
  headers.set("Cache-Control", /\.[a-f0-9]{64}\.wgb$/i.test(key)
    ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate");
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/octet-stream");
  headers.set("Content-Length", String(meta.size));
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });

  const ifRange = request.headers.get("If-Range");
  const rangeHeader = !ifRange || ifRange === meta.httpEtag ? request.headers.get("Range") : null;
  const match = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null;
  let start = 0, end = meta.size - 1;
  if (match) {
    start = match[1] ? Number(match[1]) : Math.max(0, meta.size - Number(match[2]));
    end = match[1] && match[2] ? Math.min(Number(match[2]), meta.size - 1) : meta.size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= meta.size
        || (!match[1] && (!match[2] || Number(match[2]) === 0))) {
      headers.set("Content-Range", `bytes */${meta.size}`);
      headers.delete("Content-Length");
      return new Response(null, { status: 416, headers });
    }
  }
  const ranged = match !== null;
  const length = end - start + 1;
  const cache = (caches as CacheStorage & { default: Cache }).default;
  let cacheKey: Request | null = null;
  if (ranged && length <= 16 * 1024 * 1024) {
    const url = new URL(request.url);
    url.searchParams.set("__wgb_etag", meta.httpEtag);
    url.searchParams.set("__wgb_range", `${start}-${end}`);
    cacheKey = new Request(url.toString());
    const hit = await cache.match(cacheKey);
    if (hit) {
      headers.set("X-WGB-Cache", "HIT");
      headers.set("Content-Range", `bytes ${start}-${end}/${meta.size}`);
      headers.set("Content-Length", String(length));
      return new Response(hit.body, { status: 206, headers });
    }
  }
  let object = await env.APPS.get(key, ranged ? { range: { offset: start, length } } : undefined);
  if (!object) return new Response(null, { status: 404 });
  if (object.httpEtag !== meta.httpEtag) {
    // Metadata and data must belong to the same R2 version, including deployment races.
    await object.body.cancel();
    object = await env.APPS.get(key);
    if (!object) return new Response(null, { status: 404 });
    headers.set("ETag", object.httpEtag);
    headers.set("Content-Length", String(object.size));
    return new Response(object.body, { status: 200, headers });
  }
  if (!ranged) return new Response(object.body, { status: 200, headers });
  headers.set("Content-Range", `bytes ${start}-${end}/${meta.size}`);
  headers.set("Content-Length", String(length));
  headers.set("X-WGB-Cache", cacheKey ? "MISS" : "BYPASS");
  const response = new Response(object.body, { status: 206, headers });
  if (cacheKey) {
    const internalHeaders = new Headers(headers);
    internalHeaders.delete("Content-Range");
    internalHeaders.set("Cache-Control", "public, max-age=3600");
    const copy = response.clone();
    waitUntil(cache.put(cacheKey, new Response(copy.body, { status: 200, headers: internalHeaders })).catch(() => {}));
  }
  return response;
};

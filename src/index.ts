export interface Env {
  ASSETS: Fetcher;
  TRACKS_BUCKET: R2Bucket;
  UPLOAD_PASSCODE: string;
}

const MAX_TRACK_BYTES = 200 * 1024 * 1024; // 200 MB, generous headroom above the old 150 MB warning threshold

function isSafeKey(key: string): boolean {
  return key.length > 0 && !key.includes("..") && !key.startsWith("/") && /\.gpx$/i.test(key);
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  // GET /api/tracks — list the track library
  if (url.pathname === "/api/tracks" && request.method === "GET") {
    const listed = await env.TRACKS_BUCKET.list({ limit: 1000 });
    const tracks = listed.objects
      .filter((o) => /\.gpx$/i.test(o.key))
      .map((o) => ({ key: o.key, name: o.key, size: o.size, uploaded: o.uploaded }))
      .sort((a, b) => new Date(b.uploaded).getTime() - new Date(a.uploaded).getTime());
    return Response.json({ tracks });
  }

  const trackMatch = url.pathname.match(/^\/api\/tracks\/(.+)$/);
  if (trackMatch) {
    const key = decodeURIComponent(trackMatch[1]);
    if (!isSafeKey(key)) {
      return Response.json({ error: "Invalid track key" }, { status: 400 });
    }

    if (request.method === "GET") {
      const obj = await env.TRACKS_BUCKET.get(key);
      if (!obj) return Response.json({ error: "Not found" }, { status: 404 });
      return new Response(obj.body, {
        headers: { "content-type": "application/gpx+xml" },
      });
    }

    if (request.method === "PUT") {
      let passcode = "";
      try {
        passcode = decodeURIComponent(request.headers.get("x-upload-passcode") || "");
      } catch {
        // Malformed percent-encoding — treat as wrong passcode rather than a server error.
      }
      if (!env.UPLOAD_PASSCODE || passcode !== env.UPLOAD_PASSCODE) {
        return Response.json({ error: "Invalid passcode" }, { status: 401 });
      }

      const contentLength = Number(request.headers.get("content-length") || "0");
      if (contentLength > MAX_TRACK_BYTES) {
        return Response.json({ error: "File too large" }, { status: 413 });
      }
      await env.TRACKS_BUCKET.put(key, request.body, {
        httpMetadata: { contentType: "application/gpx+xml" },
      });
      return Response.json({ key, ok: true });
    }
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }
    return env.ASSETS.fetch(request);
  },
};

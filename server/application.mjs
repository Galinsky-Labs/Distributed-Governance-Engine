import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { createServer } from "node:https";

const security = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};
export function createEngineApplication({
  accounts,
  origin,
  product = "civic",
  assetDirectory = new URL("../dist/", import.meta.url),
  readiness = null,
}) {
  if (
    !["civic", "charter"].includes(product) ||
    new URL(origin).origin !== origin ||
    !origin.startsWith("https://")
  )
    throw Error("Invalid application configuration");
  const assets = new Map([
      ["/", ["index.html", "text/html; charset=utf-8"]],
      ["/account", ["index.html", "text/html; charset=utf-8"]],
      ["/governance", ["index.html", "text/html; charset=utf-8"]],
      ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
      ["/app.css", ["app.css", "text/css; charset=utf-8"]],
    ]),
    cache = new Map();
  return async (request, context) => {
    const url = new URL(request.url);
    if (url.origin !== origin)
      return new Response("Invalid origin", { status: 400, headers: security });
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/"))
      return accounts(request, context);
    if (!["GET", "HEAD"].includes(request.method))
      return new Response("Method not allowed", {
        status: 405,
        headers: security,
      });
    if (url.pathname === "/healthz")
      return Response.json({ status: "ok" }, { headers: security });
    if(url.pathname === "/readyz") {
      try {
        if(typeof readiness!=="function")throw Error("Readiness unavailable");
        await readiness();
        return Response.json({status:"ready"},{headers:security});
      }catch{return Response.json({status:"unavailable"},{status:503,headers:security});}
    }
    const entry = assets.get(url.pathname);
    if (!entry)
      return new Response("Not found", { status: 404, headers: security });
    try {
      if (!cache.has(entry[0])) {
        let bytes = await readFile(new URL(entry[0], assetDirectory));
        if (bytes.byteLength > 2000000) throw Error("Asset too large");
        if (entry[0] === "index.html")
          bytes = Buffer.from(
            bytes
              .toString("utf8")
              .replace(/ data-quill-product="(?:civic|charter)"/g, "")
              .replace(
                "<html",
                '<html data-account-enabled="true" data-quill-product="' +
                  product +
                  '"',
              ),
          );
        cache.set(entry[0], bytes);
      }
      return new Response(
        request.method === "HEAD" ? null : cache.get(entry[0]),
        { headers: { ...security, "content-type": entry[1] } },
      );
    } catch {
      return new Response("Application build unavailable", {
        status: 503,
        headers: security,
      });
    }
  };
}

/** PUBLIC_ORIGIN and socket identity are trusted configuration, never forwarded headers. */
export function nodeListener({
  application,
  origin,
  requireTLS = true,
  bodyLimit = () => 8192,
}) {
  const site = new URL(origin);
  return async (req, res) => {
    try {
      if (requireTLS && !req.socket.encrypted) {
        res.writeHead(400, security);
        res.end("TLS required");
        return;
      }
      if (
        req.headers.host !== site.host ||
        !req.url?.startsWith("/") ||
        req.url.startsWith("//") ||
        req.url.includes("\\") ||
        req.url.length > 4096
      ) {
        res.writeHead(400, security);
        res.end("Invalid request");
        return;
      }
      const maxBytes = bodyLimit(req.url.split("?")[0]);
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 4000000)
        throw Error("Invalid request budget");
      if (Number(req.headers["content-length"] ?? 0) > maxBytes) {
        res.writeHead(413, security);
        res.end("Body too large", () => req.destroy());
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBytes) {
          res.writeHead(413, security);
          res.end("Body too large", () => req.destroy());
          return;
        }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      const request = new Request(origin + req.url, {
        method: req.method,
        headers: req.headers,
        ...(body.length && !["GET", "HEAD"].includes(req.method)
          ? { body }
          : {}),
      });
      const response = await application(request, {
        peerAddress: req.socket.remoteAddress,
      });
      res.statusCode = response.status;
      for (const [name, value] of response.headers)
        if (name !== "set-cookie") res.setHeader(name, value);
      const cookies = response.headers.getSetCookie();
      if (cookies.length) res.setHeader("set-cookie", cookies);
      if (!response.body || req.method === "HEAD") res.end();
      else
        Readable.fromWeb(response.body)
          .on("error", () => res.destroy())
          .pipe(res);
    } catch {
      if (!res.headersSent) {
        res.writeHead(503, security);
        res.end("Service unavailable");
      } else res.destroy();
    }
  };
}
export function createEngineServer({
  application,
  origin,
  key,
  cert,
  bodyLimit,
}) {
  if (!key || !cert) throw Error("TLS certificate and key are required");
  const server = createServer(
    { key, cert, minVersion: "TLSv1.3", ALPNProtocols: ["http/1.1"] },
    nodeListener({ application, origin, bodyLimit }),
  );
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 64;
  server.maxRequestsPerSocket = 100;
  return server;
}

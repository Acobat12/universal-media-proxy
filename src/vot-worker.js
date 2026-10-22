const VERSION = "1.1.14-protobuf-envelope-validated";
const DIAG_ENABLED = process.env.VOT_DIAGNOSTICS !== "false";
const diag = (label, details) => { if (DIAG_ENABLED) console.log(label, JSON.stringify(details)); };
const hexSHA256 = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");

const YANDEX_USER_AGENT =

  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 YaBrowser/26.8.0.0 Safari/537.36";

const CORS_HEADERS = {

  "Access-Control-Allow-Origin": "*",

  "Access-Control-Allow-Headers": "*",

  "Access-Control-Allow-Methods": "POST, GET, PUT, HEAD, OPTIONS",

  "Access-Control-Max-Age": "86400",

  "Access-Control-Expose-Headers": "X-Yandex-Status, X-VOT-SERVER-ID",

};

const CORS_HEADERS_KEYS = Object.keys(CORS_HEADERS);

const HOP_BY_HOP_HEADERS = ["upgrade", "transfer-encoding"];

const PROTOBUF_MEDIA_TYPE = "application/x-protobuf";

const JSON_MEDIA_TYPE = "application/json";
const ENVELOPE_MEDIA_TYPE = "application/x-vot-envelope+protobuf";

const FILTERED_UPSTREAM_HEADERS = new Set([

  "host",

  "content-length",

  "connection",

  "transfer-encoding",

]);

function mediaTypeOf(value) {

  if (typeof value !== "string") return "";

  return value.split(";")[0].trim().toLowerCase();

}

function isByteRouteContentType(contentType) {

  const mediaType = mediaTypeOf(contentType);

  return mediaType === PROTOBUF_MEDIA_TYPE || mediaType === ENVELOPE_MEDIA_TYPE;

}

const S3_URLS = {

  audio: "vtrans.s3-private.mds.yandex.net/tts/prod/",

  subs: "brosubs.s3-private.mds.yandex.net/vtrans/",

};

// Upstream for VOT API routes. Local development sets*

// `env.YANDEX_API_URL` (e.g. `--var YANDEX_API_URL:http://127.0.0.1:3001` in*

// `wrangler dev`); production falls back to the real Yandex host.*

const DEFAULT_YANDEX_API_URL = "https://api.browser.yandex.ru";

// Normalize the configured origin to `<origin><path>` without a trailing slash*

// (unset/invalid values fall back to production), so joining an absolute*

// pathname with `new URL` can never produce a double slash.*

function normalizeYandexApiUrl(value) {

  const raw = typeof value === "string" && value.length > 0 ? value : DEFAULT_YANDEX_API_URL;

  try {

    const url = new URL(raw);

    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;

  } catch {

    return DEFAULT_YANDEX_API_URL;

  }

}

function yandexRequestUrl(base, pathname) {

  return new URL(pathname, `${base}/`).toString();

}

function errorResponse(message) {

  return new Response(null, {

    status: 204,

    headers: {

      ...CORS_HEADERS,

      "X-Yandex-Status": message,

    },

  });

}

function healthResponse() {

  return new Response(

    JSON.stringify({

      status: "ok",

      version: VERSION,

    }),

    {

      status: 200,

      headers: {

        ...CORS_HEADERS,

        "Content-Type": "application/json",

      },

    },

  );

}

function badRequestResponse() {

  return new Response("Bad Request", {

    status: 400,

    headers: {

      ...CORS_HEADERS,

      "Content-Type": "application/json",

    },

  });

}

// Diagnostic information about the exact Request handed to fetch().*

// Does not print signature, tokens, cookies, or protobuf payload.*

async function logYandexRequest(request) {

  const url = new URL(request.url);

  if (!["/video-translation/translate", "/session/create", "/video-translation/cache"].includes(url.pathname)) return;

  try {

    const body = await request.clone().arrayBuffer();

    const sha256 = await hexSHA256(body);

    diag("[VOT DEBUG] outgoing", {

      method: request.method,

      destination: url.origin,

      pathname: url.pathname,

      bodyBytes: body.byteLength,

      bodySHA256: sha256,

      headerNames: Array.from(request.headers.keys()).sort(),

      contentType: request.headers.get("content-type"),

      userAgent: request.headers.get("user-agent"),

      signaturePresent: request.headers.has("vtrans-signature"),

      signatureLength: request.headers.get("vtrans-signature")?.length ?? 0,

      acceptLanguage: request.headers.get("accept-language"),
      headerCount: Array.from(request.headers.keys()).length,
      authorizationPresent: request.headers.has("authorization"),
      secVtransSkPresent: request.headers.has("sec-vtrans-sk"),
      secVtransTokenPresent: request.headers.has("sec-vtrans-token")
    });

  } catch (error) {

    console.error("[VOT DEBUG] inspection failed", String(error));

  }

}

async function makeRequest(request) {

  let upstream;

  try {

    await logYandexRequest(request);
    const startedAt = performance.now();
    upstream = await fetch(request);
    diag("[VOT UPSTREAM]", {path: new URL(request.url).pathname, status: upstream.status, elapsedMs: Math.round(performance.now() - startedAt), responseHeaderNames: Array.from(upstream.headers.keys()).sort(), contentType: upstream.headers.get("content-type"), contentLength: upstream.headers.get("content-length"), contentEncoding: upstream.headers.get("content-encoding") ?? "none"});

    console.log(

      "[VOT] Yandex response",

      new URL(request.url).pathname,

      "status:", upstream.status,

      "content-type:", upstream.headers.get("content-type")

    );

    // Read a CLONE only: the original Protobuf stream remains untouched.

    // Diagnostics do not log response payload, tokens or signed audio URLs.

    const responsePath = new URL(request.url).pathname;

    if (responsePath === "/video-translation/translate" || responsePath === "/session/create" || responsePath === "/video-translation/cache") {

      try {

        const responseBytes = new Uint8Array(await upstream.clone().arrayBuffer());

        diag("[VOT RESPONSE]", {

          path: responsePath,

          status: upstream.status,

          bytes: responseBytes.byteLength,

          contentType: upstream.headers.get("content-type"),

          contentEncoding: upstream.headers.get("content-encoding") ?? "none",

          contentLengthHeader: upstream.headers.get("content-length"),

          empty: responseBytes.byteLength === 0,

          firstFieldNumber: responseBytes.byteLength && mediaTypeOf(upstream.headers.get("content-type")) === PROTOBUF_MEDIA_TYPE ? (responseBytes[0] >>> 3) : null,
          firstWireType: responseBytes.byteLength && mediaTypeOf(upstream.headers.get("content-type")) === PROTOBUF_MEDIA_TYPE ? (responseBytes[0] & 7) : null,
          bodySHA256: await hexSHA256(responseBytes)
        });

      } catch (diagnosticError) {

        console.log("[VOT RESPONSE] inspection-error", String(diagnosticError));

      }

    }

    if (!upstream.ok && new URL(request.url).pathname === "/video-translation/translate") {

      const type = mediaTypeOf(upstream.headers.get("content-type"));

      if (type === "text/plain") {

        // Never print the upstream body: it may contain session tokens or identifiers.
        // Record only its length, hash and a tightly controlled diagnostic category.
        try {
          const bytes = new Uint8Array(await upstream.clone().arrayBuffer());
          const { createHash } = await import("node:crypto");
          const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
          const category = /(?:payment|required.to.pay|subscription|quota|billing)/i.test(text)
            ? "payment-or-quota"
            : /(?:signature|invalid.sign|bad.sign)/i.test(text)
              ? "signature"
              : /(?:unauthorized|authorization|invalid.token|expired.token|forbidden)/i.test(text)
                ? "authorization"
                : /(?:rate.limit|too.many.requests|throttl)/i.test(text)
                  ? "rate-limit"
                  : /(?:captcha|robot|blocked|denied)/i.test(text)
                    ? "access-denied"
                    : "unclassified";
          console.log("[VOT DEBUG] upstream text/plain diagnostic", JSON.stringify({
            status: upstream.status,
            bytes: bytes.byteLength,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            category
          }));
        } catch (diagnosticError) {
          console.log("[VOT DEBUG] upstream text/plain inspection failed", String(diagnosticError));
        }

      }

    }

  } catch (error) {

    console.error("[VOT] Yandex fetch failed:", String(error));

    return errorResponse("error-internal");

  }

  const response = new Response(upstream.body, upstream);

  response.headers.delete("date");

  for (const hopByHopHeader of HOP_BY_HOP_HEADERS) {

    response.headers.delete(hopByHopHeader);

  }

  for (const corsHeaderKey of CORS_HEADERS_KEYS) {

    response.headers.delete(corsHeaderKey);

    response.headers.set(corsHeaderKey, CORS_HEADERS[corsHeaderKey]);

  }

  response.headers.set("X-Yandex-Status", "success");

  return response;

}

function safeUpstreamHeaders(source) {

  const headers = new Headers(source);

  for (const name of [

    ...FILTERED_UPSTREAM_HEADERS,

    "accept-encoding", "cf-connecting-ip", "cf-ipcountry",

    "cf-ray", "cf-visitor", "cdn-loop", "x-forwarded-for",

    "x-forwarded-proto", "x-real-ip", "origin", "referer"

  ]) headers.delete(name);

  return headers;

}

// Via GM_xmlhttpRequest may JSON-serialize Uint8Array as {"0":10,"1":...}.
// Restore only this exact numeric-key representation; never accept legacy
// {headers,body} envelopes or X-VOT-Headers metadata.
function restoreViaNumericBytes(raw) {
  if (raw.length < 2 || raw[0] !== 0x7b) return null;
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length === 0 || !keys.every((key, index) => key === String(index))) return null;
  const bytes = new Uint8Array(keys.length);
  for (let index = 0; index < keys.length; index++) {
    const value = parsed[keys[index]];
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    bytes[index] = value;
  }
  return bytes;
}

// Single-request Protobuf envelope, field 1 = map headers, 2 = body, 3 = path.
// No KV binding is needed for this transport. Legacy two-step remains available.
function decodeVotEnvelope(bytes) {
  let offset = 0;
  const decoder = new TextDecoder("utf-8", {fatal: true,  ignoreBOM: false});
  const readVarint = (limit) => {
    let value = 0, multiplier = 1;
    for (let i = 0; i < 8; i++) {
      if (offset >= limit) throw new Error("Truncated varint");
      const byte = bytes[offset++];
      value += (byte & 127) * multiplier;
      if (!Number.isSafeInteger(value)) throw new Error("Varint overflow");
      if (!(byte & 128)) return value;
      multiplier *= 128;
    }
    throw new Error("Invalid varint");
  };
  const readField = (limit) => {
    const tag = readVarint(limit);
    if ((tag & 7) !== 2 || (tag >>> 3) === 0) throw new Error("Invalid envelope wire type");
    const length = readVarint(limit);
    if (length > limit - offset) throw new Error("Invalid envelope length");
    const start = offset;
    offset += length;
    return {field: tag >>> 3, start, end: offset};
  };
  const headers = {};
  let body = null, path = null, count = 0;
  while (offset < bytes.length) {
    const {field, start, end} = readField(bytes.length);
    if (field === 1) {
      if (++count > 64 || end - start > 9000) throw new Error("Too many or oversized headers");
      offset = start;
      let key = null, value = null;
      while (offset < end) {
        const item = readField(end);
        if (item.field === 1) key = decoder.decode(bytes.subarray(item.start, item.end));
        else if (item.field === 2) value = decoder.decode(bytes.subarray(item.start, item.end));
        else throw new Error("Invalid map entry");
      }
      if (key === null || value === null || !META_ALLOWED.test(key) || value.length > 4096 || /[\r\n]/.test(value) || Object.hasOwn(headers, key)) throw new Error("Invalid envelope header");
      headers[key] = value;
    } else if (field === 2) {
      if (body !== null) throw new Error("Duplicate body");
      body = bytes.subarray(start, end);
    } else if (field === 3) {
      if (path !== null) throw new Error("Duplicate path");
      path = decoder.decode(bytes.subarray(start, end));
    } else throw new Error("Unexpected envelope field");
    offset = end;
  }
  if (body === null || path === null) throw new Error("Missing envelope fields");
  return {headers, body, path};
}
async function handleEnvelopeRequest(request, pathname, yandexApiUrl) {
  const raw = new Uint8Array(await request.arrayBuffer());
  const restored = restoreViaNumericBytes(raw);
  const payload = restored ?? raw;
  let envelope;
  try { envelope = decodeVotEnvelope(payload); }
  catch (err) { console.warn("[VOT ENVELOPE] invalid", err.message); return metadataError("Invalid envelope"); }
  if (envelope.path !== pathname) return metadataError("Envelope path mismatch");
  // Validate decoded metadata before constructing Headers. Never log secrets.
  const cleanHeaders = new Headers();
  for (const [name, value] of Object.entries(envelope.headers)) {
    if (typeof value !== "string" || /[\x00-\x1f\x7f]/.test(value)) {
      console.warn("[VOT ENVELOPE] invalid header bytes", JSON.stringify({name, length: String(value).length}));
      return metadataError("Invalid envelope header: " + name);
    }
    try { cleanHeaders.set(name, value); }
    catch (err) {
      console.warn("[VOT ENVELOPE] rejected header", JSON.stringify({name, length: value.length, error: err.message}));
      return metadataError("Invalid envelope header: " + name);
    }
  }
  const headers = safeUpstreamHeaders(cleanHeaders);
  headers.set("Content-Type", PROTOBUF_MEDIA_TYPE);
  if (!headers.has("user-agent")) headers.set("User-Agent", YANDEX_USER_AGENT);
  diag("[VOT ENVELOPE]", {path: pathname, envelopeBytes: payload.length, envelopeSHA256: await hexSHA256(payload), bodyBytes: envelope.body.length, bodySHA256: await hexSHA256(envelope.body), headerCount: Object.keys(envelope.headers).length, viaRestored: restored !== null, headerNames: Object.keys(envelope.headers).sort()});
  return makeRequest(new Request(yandexRequestUrl(yandexApiUrl, pathname), {method: request.method, headers, body: envelope.body}));
}

// Two-step transport: metadata is stored briefly in Cloudflare KV, never in URLs.
// Bind KV namespace as VOT_META_KV. This route must be protected by normal
// Cloudflare abuse controls before public deployment.
const META_PREFIX = "vot-meta:";
const META_TTL_SECONDS = 60;
const META_ALLOWED = /^(?:sec-vtrans-[a-z0-9-]+|sec-vsubs-[a-z0-9-]+|vtrans-[a-z0-9-]+|vsubs-[a-z0-9-]+|sec-ch-ua(?:-[a-z0-9-]+)?|accept-language|authorization|pragma|cache-control)$/;
function metadataError(message, status = 400) {
  return new Response(JSON.stringify({error: message}), {status, headers: {...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store"}});
}
async function handleMetadata(request, env) {
  if (!env?.VOT_META_KV) return metadataError("VOT_META_KV binding is missing", 503);
  if (mediaTypeOf(request.headers.get("content-type")) !== JSON_MEDIA_TYPE) return metadataError("Expected JSON");
  const text = await request.text();
  if (text.length > 12000) return metadataError("Metadata too large", 413);
  let input;
  try { input = JSON.parse(text); } catch { return metadataError("Invalid JSON"); }
  if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.path !== "string" || !input.headers || typeof input.headers !== "object" || Array.isArray(input.headers)) return metadataError("Invalid metadata");
  const allowedPaths = ["/session/create", "/video-translation/translate", "/video-translation/cache", "/video-subtitles/get-subtitles", "/stream-translation/translate-stream", "/stream-translation/ping-stream", "/video-translation/audio"];
  if (!allowedPaths.includes(input.path)) return metadataError("Invalid path");
  const clean = {};
  for (const [name, value] of Object.entries(input.headers)) {
    const key = name.toLowerCase();
    if (!META_ALLOWED.test(key) || typeof value !== "string" || value.length > 4096 || /[\r\n]/.test(value)) return metadataError("Invalid header");
    clean[key] = value;
  }
  const id = crypto.randomUUID();
  await env.VOT_META_KV.put(META_PREFIX + id, JSON.stringify({path: input.path, headers: clean}), {expirationTtl: META_TTL_SECONDS});
  return new Response(JSON.stringify({id}), {status: 200, headers: {...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store"}});
}
async function handleTwoStepRequest(request, pathname, yandexApiUrl, env) {
  if (!env?.VOT_META_KV) return metadataError("VOT_META_KV binding is missing", 503);
  if (mediaTypeOf(request.headers.get("content-type")) !== PROTOBUF_MEDIA_TYPE) return metadataError("Expected Protobuf");
  const id = request.headers.get("x-vot-request-id");
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) return metadataError("Missing request id");
  const record = await env.VOT_META_KV.get(META_PREFIX + id);
  if (!record) return metadataError("Metadata not found or expired", 409);
  let meta;
  try { meta = JSON.parse(record); } catch { return metadataError("Invalid stored metadata"); }
  if (meta.path !== pathname) return metadataError("Path mismatch");
  const raw = new Uint8Array(await request.arrayBuffer());
  // Via's GM transport sometimes converts typed arrays into numeric-key JSON.
  const restored = restoreViaNumericBytes(raw);
  const payload = restored ?? raw;
  const headers = safeUpstreamHeaders(new Headers(meta.headers));
  headers.set("Content-Type", PROTOBUF_MEDIA_TYPE);
  if (!headers.has("user-agent")) headers.set("User-Agent", YANDEX_USER_AGENT);
  console.log("[VOT TWO-STEP]", JSON.stringify({path: pathname, bytes: payload.byteLength, viaRestored: restored !== null, metadataFound: true}));
  return await makeRequest(new Request(yandexRequestUrl(yandexApiUrl, pathname), {method: request.method, headers, body: payload}));
}

async function handleYandexRequest(request, pathname, yandexApiUrl) {
  if (mediaTypeOf(request.headers.get("content-type")) !== PROTOBUF_MEDIA_TYPE)
    return errorResponse("error-content");

  const raw = new Uint8Array(await request.arrayBuffer());
  const restored = restoreViaNumericBytes(raw);
  const payload = restored ?? raw;
  const metadataHeaders = safeUpstreamHeaders(request.headers);
  if (!metadataHeaders.has("user-agent")) metadataHeaders.set("User-Agent", YANDEX_USER_AGENT);
  metadataHeaders.set("Content-Type", PROTOBUF_MEDIA_TYPE);

  console.log("[VOT META]", JSON.stringify({
    route: pathname, transport: "direct", metadataSource: "direct",
    hasSecVtransSk: metadataHeaders.has("sec-vtrans-sk"),
    hasSecVtransToken: metadataHeaders.has("sec-vtrans-token"),
    hasSignature: metadataHeaders.has("vtrans-signature"),
    hasSecChUa: metadataHeaders.has("sec-ch-ua"),
    hasSecChUaFullVersionList: metadataHeaders.has("sec-ch-ua-full-version-list")
  }));
  console.log("[VOT DEBUG] body inspection", JSON.stringify({
    incomingBytes: raw.byteLength, forwardedBytes: payload.byteLength,
    unwrapped: restored !== null, format: restored !== null ? "numeric-keys" : "binary-direct",
    first8Hex: Array.from(raw.slice(0, 8), b => b.toString(16).padStart(2, "0")).join(" ")
  }));

  const yandexRequest = new Request(yandexRequestUrl(yandexApiUrl, pathname), {
    body: payload, method: request.method, headers: metadataHeaders
  });
  return await makeRequest(yandexRequest);
}

async function handleS3ProxyRequest(type, pathname, search, method, range) {

  if (!search) return errorResponse("error-request");

  const fileName = pathname.split("/").slice(3).join("/");

  const audioRequest = new Request(`https://${S3_URLS[type]}${fileName}${search}`, {

    method,

    headers: {

      "User-Agent": YANDEX_USER_AGENT,

      ...(range ? { Range: range } : {}),

    },

  });

  return await makeRequest(audioRequest);

}

async function handleYAJSONRequest(request, pathname, yandexApiUrl) {
  if (mediaTypeOf(request.headers.get("content-type")) !== JSON_MEDIA_TYPE)
    return errorResponse("error-content");
  const headers = safeUpstreamHeaders(request.headers);
  if (!headers.has("user-agent")) headers.set("User-Agent", YANDEX_USER_AGENT);
  headers.set("Content-Type", JSON_MEDIA_TYPE);
  const upstreamRequest = new Request(yandexRequestUrl(yandexApiUrl, pathname), {
    body: await request.arrayBuffer(), method: request.method, headers
  });
  return await makeRequest(upstreamRequest);
}

const route = {

  async fetch(request, env) {

    const yandexApiUrl = normalizeYandexApiUrl(env?.YANDEX_API_URL);

    diag("[VOT] incoming", {method: request.method, path: new URL(request.url).pathname, contentType: mediaTypeOf(request.headers.get("content-type")), contentLength: request.headers.get("content-length"), transport: mediaTypeOf(request.headers.get("content-type")) === ENVELOPE_MEDIA_TYPE ? "protobuf-envelope" : "other"});

    if (request.method == "OPTIONS")

      return new Response(null, {

        headers: {

          ...CORS_HEADERS,

          Allow: "GET, POST, PUT, OPTIONS",

        },

      });

    const url = new URL(request.url);

    // Normalize repeated slashes in incoming VOT routes.*

    url.pathname = url.pathname.replace(/\/{2,}/g, "/");

    if (url.pathname === "/vot/metadata" && request.method === "POST") return await handleMetadata(request, env);
    if (

      [

        "/video-translation/translate",

        "/video-translation/cache",

        "/video-subtitles/get-subtitles",

        "/stream-translation/translate-stream",

        "/stream-translation/ping-stream",

        "/session/create",

      ].includes(url.pathname)

    ) {

      // translate endpoint (POST)*

      if (request.method !== "POST") return errorResponse("error-path");

      if (!isByteRouteContentType(request.headers.get("content-type")))

        return errorResponse("error-content");

      return mediaTypeOf(request.headers.get("content-type")) === ENVELOPE_MEDIA_TYPE
        ? await handleEnvelopeRequest(request, url.pathname, yandexApiUrl)
        : await handleTwoStepRequest(request, url.pathname, yandexApiUrl, env);

    } else if (url.pathname === "/video-translation/audio") {

      // translate endpoint (PUT)*

      if (request.method !== "PUT") return errorResponse("error-path");

      if (!isByteRouteContentType(request.headers.get("content-type")))

        return errorResponse("error-content");

      return mediaTypeOf(request.headers.get("content-type")) === ENVELOPE_MEDIA_TYPE
        ? await handleEnvelopeRequest(request, url.pathname, yandexApiUrl)
        : await handleTwoStepRequest(request, url.pathname, yandexApiUrl, env);

    } else if (url.pathname === "/video-translation/fail-audio-js") {

      if (request.method !== "PUT") return errorResponse("error-path");

      if (mediaTypeOf(request.headers.get("content-type")) !== JSON_MEDIA_TYPE)

        return errorResponse("error-content");

      return await handleYAJSONRequest(request, url.pathname, yandexApiUrl);

    } else if (

      url.pathname.startsWith("/video-translation/audio-proxy/") &&

      url.pathname.length > "/video-translation/audio-proxy/".length

    ) {

      // proxy endpoint*

      if (request.method !== "GET" && request.method !== "HEAD") return errorResponse("error-path");

      if (!url.pathname.endsWith(".mp3")) return errorResponse("error-content");

      return await handleS3ProxyRequest(

        "audio",

        url.pathname,

        url.search,

        request.method,

        request.headers.get("range"),

      );

    } else if (url.pathname.startsWith("/video-subtitles/subtitles-proxy")) {

      // proxy endpoint*

      if (request.method !== "GET" && request.method !== "HEAD") return errorResponse("error-path");

      return await handleS3ProxyRequest(

        "subs",

        url.pathname,

        url.search,

        request.method,

        request.headers.get("range"),

      );

    } else if (url.pathname === "/health" && request.method === "GET") {

      return healthResponse();

    } else {

      return errorResponse("error-path");

    }

  },

};

export default {

  async fetch(request, env) {

    const response = await route.fetch(request, env);

    if (env?.SERVER_ID) response.headers.set("X-VOT-SERVER-ID", env.SERVER_ID);

    return response;

  },

};
const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "cf-access-jwt-assertion",
  "x-api-key",
  "api-key",
  "apikey"
]);

const PROXY_HEADER_NAMES = [
  "forwarded",
  "forwarded-for",
  "via",
  "proxy-connection",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "x-client-ip",
  "true-client-ip",
  "client-ip",
  "proxy-authenticate",
  "proxy-authorization"
];

const DATACENTER_ORG_PATTERNS = [
  /amazon|aws|ec2/i,
  /google\s+cloud|google\s+llc|google\s+inc/i,
  /microsoft|azure/i,
  /digitalocean/i,
  /linode|akamai cloud|akamai connected cloud/i,
  /vultr|choopa/i,
  /ovh|soyoustart|kimsufi/i,
  /hetzner/i,
  /leaseweb/i,
  /contabo/i,
  /oracle|oci/i,
  /alibaba|aliyun/i,
  /tencent/i,
  /huawei cloud/i,
  /scaleway/i,
  /packet|equinix metal/i,
  /cloudflare/i,
  /m247/i,
  /data center|datacenter|hosting|colo/i,
  /servers|servermania|rackspace|ionos|1&1/i,
  /quadranet|psychz|sharktech|reliablesite/i,
  /cogent|g-core|fastly/i
];

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: JSON_HEADERS });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/ping") {
        const server = collectServerBasics(request);
        return json({ ok: true, now: Date.now(), iso: new Date().toISOString(), server });
      }

      if (url.pathname === "/api/check") {
        const server = await collectServer(request, env);
        const verdict = scoreReport({ server, client: null });
        return json({ ok: true, receivedAt: new Date().toISOString(), verdict, server });
      }

      if (url.pathname === "/api/report" && request.method === "POST") {
        const rawClient = await readJsonBody(request, 192 * 1024);
        const server = await collectServer(request, env);
        const client = enrichClientConsistency(rawClient, server);
        const verdict = scoreReport({ server, client });
        const detections = detectionMatrix(server, client);
        return json({
          ok: true,
          receivedAt: new Date().toISOString(),
          verdict,
          server,
          client,
          detections
        });
      }

      if (url.pathname.startsWith("/api/")) {
        return json({ ok: false, error: "Unknown API route" }, 404);
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      return json({ ok: false, error: String(error?.message || error) }, 500);
    }
  }
};

async function readJsonBody(request, maxBytes) {
  const text = await request.text();
  if (text.length > maxBytes) {
    throw new Error(`Request body too large. Max ${maxBytes} bytes.`);
  }
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error("Invalid JSON body");
  }
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), { status, headers: JSON_HEADERS });
}

function collectServerBasics(request) {
  const headers = collectHeaders(request.headers);
  const cf = collectCf(request.cf || {});
  const ip = getClientIp(request.headers);
  const ua = request.headers.get("user-agent") || "";
  const proxyHeaders = findProxyHeaders(request.headers);

  return {
    ip,
    url: redactUrl(request.url),
    method: request.method,
    userAgent: ua,
    headerNames: Object.keys(headers).sort(),
    headers,
    cf,
    proxyHeaders
  };
}

async function collectServer(request, env) {
  const basics = collectServerBasics(request);
  const ip = basics.ip;
  const ua = basics.userAgent;
  const provider = String(env.IP_INTEL_PROVIDER || "ipapi").toLowerCase();

  const datacenterHeuristic = inferDatacenterFromOrg(basics.cf.asOrganization || "");
  const ipIntel = await lookupIpIntel(ip, ua, env, provider);
  const headerSignals = analyzeHeaders(basics.headers, basics.userAgent);

  return {
    ...basics,
    datacenterHeuristic,
    headerSignals,
    ipIntel,
    cloudflareBotManagement: normalizeCloudflareBotManagement(basics.cf.botManagement)
  };
}

function collectHeaders(headers) {
  const out = {};
  for (const [name, value] of headers.entries()) {
    const key = name.toLowerCase();
    out[key] = SENSITIVE_HEADERS.has(key) ? "[redacted]" : value;
  }
  return out;
}

function collectCf(cfRaw) {
  const keys = [
    "asn",
    "asOrganization",
    "colo",
    "country",
    "city",
    "region",
    "regionCode",
    "postalCode",
    "continent",
    "timezone",
    "latitude",
    "longitude",
    "clientTcpRtt",
    "clientQuicRtt",
    "httpProtocol",
    "tlsVersion",
    "tlsCipher",
    "tlsClientRandom",
    "edgeRequestKeepAliveStatus",
    "requestPriority",
    "botManagement"
  ];

  const cf = {};
  for (const key of keys) {
    if (cfRaw[key] !== undefined) cf[key] = cfRaw[key];
  }
  for (const [key, value] of Object.entries(cfRaw)) {
    if (!(key in cf) && isJsonSafe(value)) cf[key] = value;
  }
  return cf;
}

function isJsonSafe(value) {
  const type = typeof value;
  return value == null || type === "string" || type === "number" || type === "boolean" || Array.isArray(value) || type === "object";
}

function getClientIp(headers) {
  return (
    headers.get("cf-connecting-ip") ||
    headers.get("true-client-ip") ||
    splitFirst(headers.get("x-forwarded-for")) ||
    headers.get("x-real-ip") ||
    ""
  );
}

function splitFirst(value) {
  if (!value) return "";
  return value.split(",")[0].trim();
}

function redactUrl(rawUrl) {
  const url = new URL(rawUrl);
  for (const key of [...url.searchParams.keys()]) {
    if (/token|key|secret|pass|auth/i.test(key)) url.searchParams.set(key, "[redacted]");
  }
  return url.toString();
}

function findProxyHeaders(headers) {
  const found = {};
  for (const name of PROXY_HEADER_NAMES) {
    const value = headers.get(name);
    if (value) found[name] = SENSITIVE_HEADERS.has(name) ? "[redacted]" : value;
  }
  return found;
}

function analyzeHeaders(headers, ua) {
  const reasons = [];
  const lowerUa = ua.toLowerCase();
  const hasSecChUa = Boolean(headers["sec-ch-ua"]);
  const isLikelyBrowser = /mozilla|chrome|safari|firefox|edg|opr/i.test(ua);

  if (!ua) reasons.push({ id: "missing_user_agent", severity: "high", message: "User-Agent header missing." });
  if (/headlesschrome|phantomjs|slimerjs|selenium|playwright/i.test(ua)) {
    reasons.push({ id: "automation_user_agent", severity: "high", message: "User-Agent contains automation marker." });
  }
  if (isLikelyBrowser && !headers.accept) {
    reasons.push({ id: "missing_accept", severity: "medium", message: "Browser-like request missing Accept header." });
  }
  if (isLikelyBrowser && !headers["accept-language"]) {
    reasons.push({ id: "missing_accept_language", severity: "medium", message: "Browser-like request missing Accept-Language header." });
  }
  if ((/chrome|chromium|edg|opr/i.test(ua) && !/headlesschrome/i.test(ua)) && !hasSecChUa) {
    reasons.push({ id: "missing_client_hints", severity: "low", message: "Chromium-like UA without sec-ch-ua client hint. Some real browsers omit this, so weak signal only." });
  }
  if (headers["content-length"] && Number(headers["content-length"]) > 0 && !headers["content-type"]) {
    reasons.push({ id: "body_without_content_type", severity: "low", message: "Request body exists without Content-Type." });
  }
  if (/curl|wget|python-requests|aiohttp|httpx|go-http-client|okhttp|java\//i.test(lowerUa)) {
    reasons.push({ id: "library_user_agent", severity: "medium", message: "User-Agent looks like HTTP client library." });
  }

  return { reasons };
}

function inferDatacenterFromOrg(org) {
  const matched = DATACENTER_ORG_PATTERNS.find((pattern) => pattern.test(org));
  return {
    isLikelyDatacenter: Boolean(matched),
    organization: org || null,
    matchedPattern: matched ? String(matched) : null
  };
}

async function lookupIpIntel(ip, userAgent, env, provider) {
  if (!ip || provider === "none") {
    return { provider: "none", enabled: false, reason: "No reputation data returned." };
  }

  try {
    if (provider === "ipinfo") return await lookupIpinfo(ip, env.IPINFO_TOKEN);
    if (provider === "ipqs" || provider === "ipqualityscore") return await lookupIpqs(ip, userAgent, env.IPQUALITYSCORE_KEY);
    return await lookupIpapiIs(ip, env.IPAPI_IS_KEY);
  } catch (error) {
    return {
      provider,
      enabled: true,
      error: String(error?.message || error),
      normalized: null
    };
  }
}

async function lookupIpapiIs(ip, key) {
  const url = new URL("https://api.ipapi.is/");
  url.searchParams.set("q", ip);
  if (key) url.searchParams.set("key", key);

  const started = Date.now();
  const res = await fetchWithTimeout(url.toString(), {}, 2500);
  const data = await res.json();
  const elapsedMs = Date.now() - started;

  if (data?.error) throw new Error(`ipapi.is error: ${data.error}`);

  return {
    provider: "ipapi.is",
    enabled: true,
    status: res.status,
    elapsedMs,
    raw: data,
    normalized: {
      isDatacenter: Boolean(data.is_datacenter),
      isProxy: Boolean(data.is_proxy),
      isVpn: Boolean(data.is_vpn),
      isTor: Boolean(data.is_tor),
      isCrawler: Boolean(data.is_crawler),
      isAbuser: Boolean(data.is_abuser),
      isMobile: Boolean(data.is_mobile),
      providerName: data.datacenter?.datacenter || data.company?.name || data.asn?.name || null,
      companyType: data.company?.type || null,
      asnType: data.asn?.type || null,
      asn: data.asn?.asn || null,
      country: data.location?.country_code || data.datacenter?.country || null,
      timezone: data.location?.timezone || null
    }
  };
}

async function lookupIpinfo(ip, token) {
  if (!token) throw new Error("IPINFO_TOKEN is required for provider=ipinfo.");
  const url = new URL(`https://ipinfo.io/${encodeURIComponent(ip)}/privacy`);
  url.searchParams.set("token", token);

  const started = Date.now();
  const res = await fetchWithTimeout(url.toString(), {}, 2500);
  const data = await res.json();
  const elapsedMs = Date.now() - started;

  return {
    provider: "ipinfo",
    enabled: true,
    status: res.status,
    elapsedMs,
    raw: data,
    normalized: {
      isDatacenter: Boolean(data.hosting),
      isProxy: Boolean(data.proxy),
      isVpn: Boolean(data.vpn),
      isTor: Boolean(data.tor),
      isRelay: Boolean(data.relay),
      providerName: data.service || null,
      confidence: data.confidence ?? null,
      firstSeen: data.first_seen || null,
      lastSeen: data.last_seen || null
    }
  };
}

async function lookupIpqs(ip, userAgent, key) {
  if (!key) throw new Error("IPQUALITYSCORE_KEY is required for provider=ipqs.");
  const url = new URL(`https://www.ipqualityscore.com/api/json/ip/${encodeURIComponent(key)}/${encodeURIComponent(ip)}`);
  url.searchParams.set("strictness", "1");
  url.searchParams.set("allow_public_access_points", "true");
  if (userAgent) url.searchParams.set("user_agent", userAgent);

  const started = Date.now();
  const res = await fetchWithTimeout(url.toString(), {}, 3000);
  const data = await res.json();
  const elapsedMs = Date.now() - started;

  return {
    provider: "ipqualityscore",
    enabled: true,
    status: res.status,
    elapsedMs,
    raw: data,
    normalized: {
      isDatacenter: Boolean(data.hosting),
      isProxy: Boolean(data.proxy),
      isVpn: Boolean(data.vpn || data.active_vpn),
      isTor: Boolean(data.tor || data.active_tor),
      isCrawler: Boolean(data.crawler),
      isAbuser: Boolean(data.recent_abuse),
      fraudScore: data.fraud_score ?? null,
      providerName: data.ISP || data.organization || null,
      connectionType: data.connection_type || null,
      country: data.country_code || null
    }
  };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeCloudflareBotManagement(botManagement) {
  if (!botManagement) {
    return { available: false };
  }
  return {
    available: true,
    score: botManagement.score ?? null,
    verifiedBot: botManagement.verifiedBot ?? null,
    signedAgent: botManagement.signedAgent ?? null,
    staticResource: botManagement.staticResource ?? null,
    ja3Hash: botManagement.ja3Hash ?? null,
    ja4: botManagement.ja4 ?? null,
    detectionIds: botManagement.detectionIds ?? null,
    jsDetection: botManagement.jsDetection ?? null
  };
}

function enrichClientConsistency(client, server) {
  if (!client || typeof client !== "object") return client;

  const consistency = { ...(client.consistency || {}) };
  const browserTimezone = client.browser?.timezone || null;
  const ipTimezone = server?.ipIntel?.normalized?.timezone || server?.cf?.timezone || null;
  if (browserTimezone && ipTimezone && browserTimezone !== ipTimezone) {
    consistency.timezoneMismatch = { browserTimezone, ipTimezone };
  }

  const serverIp = server?.ip || null;
  const webrtc = client.network?.webrtc;
  if (serverIp && webrtc?.publicIps?.length) {
    const different = webrtc.publicIps.filter((ip) => ip !== serverIp);
    if (different.length) {
      if (!client.network) client.network = {};
      client.network.webrtc = {
        ...webrtc,
        publicIpLeakDifferentFromServer: true,
        differentPublicIps: different,
        serverIp
      };
    }
  }

  return { ...client, consistency };
}

function scoreReport(report) {
  const reasons = [];
  let score = 100;

  const server = report.server || {};
  const client = report.client || {};
  const browser = client.browser || {};
  const workers = client.workers || {};
  const behavior = client.behavior || {};
  const fingerprints = client.fingerprints || {};
  const automation = client.automation || {};
  const consistency = client.consistency || {};
  const network = client.network || {};

  const penalize = (points, id, severity, message, data = undefined) => {
    score -= points;
    reasons.push({ id, severity, points, message, data });
  };

  if (!server.userAgent) penalize(25, "server_missing_ua", "high", "Server saw no User-Agent header.");
  for (const reason of server.headerSignals?.reasons || []) {
    const points = reason.severity === "high" ? 25 : reason.severity === "medium" ? 12 : 5;
    penalize(points, reason.id, reason.severity, reason.message);
  }

  if (Object.keys(server.proxyHeaders || {}).length) {
    penalize(20, "proxy_headers", "medium", "Request includes explicit proxy forwarding headers.", server.proxyHeaders);
  }

  if (server.datacenterHeuristic?.isLikelyDatacenter) {
    penalize(15, "datacenter_asn_heuristic", "medium", "Cloudflare ASN organization resembles hosting/datacenter provider.", server.datacenterHeuristic);
  }

  const ipIntel = server.ipIntel?.normalized;
  if (ipIntel) {
    if (ipIntel.isTor) penalize(45, "ip_tor", "high", "IP intelligence says IP is Tor exit traffic.", ipIntel);
    if (ipIntel.isProxy) penalize(35, "ip_proxy", "high", "IP intelligence says IP is proxy traffic.", ipIntel);
    if (ipIntel.isVpn) penalize(30, "ip_vpn", "high", "IP intelligence says IP is VPN traffic.", ipIntel);
    if (ipIntel.isDatacenter) penalize(18, "ip_datacenter", "medium", "IP intelligence says IP belongs to hosting/datacenter space.", ipIntel);
    if (ipIntel.isAbuser) penalize(15, "ip_abuser", "medium", "IP intelligence marks IP as abusive or high-risk.", ipIntel);
    if (typeof ipIntel.fraudScore === "number" && ipIntel.fraudScore >= 85) {
      penalize(20, "ipqs_high_fraud_score", "high", "IPQS fraud score is high.", ipIntel);
    }
  }

  const cfBot = server.cloudflareBotManagement;
  if (cfBot?.available) {
    if (typeof cfBot.score === "number" && cfBot.score < 30 && !cfBot.verifiedBot) {
      penalize(30, "managed_bot_score_low", "high", "Managed bot score is below 30.", cfBot);
    } else if (typeof cfBot.score === "number" && cfBot.score < 50 && !cfBot.verifiedBot) {
      penalize(12, "managed_bot_score_borderline", "medium", "Managed bot score is below 50.", cfBot);
    }
  }

  if (browser.webdriver === true) penalize(40, "navigator_webdriver", "high", "navigator.webdriver is true.");
  if (/headlesschrome|phantomjs|slimerjs/i.test(browser.userAgent || "")) {
    penalize(40, "client_headless_user_agent", "high", "Client User-Agent contains headless marker.");
  }
  if (automation.present?.length) {
    penalize(30, "automation_globals", "high", "Known automation globals found on window.", automation.present);
  }
  if (automation.cdpSerializationSignal === true) {
    penalize(20, "cdp_serialization_signal", "medium", "Chrome DevTools Protocol serialization signal tripped.");
  }

  if (consistency.uaPlatformMismatch) {
    penalize(18, "ua_platform_mismatch", "medium", "User-Agent OS and navigator.platform do not align.", consistency.uaPlatformMismatch);
  }
  if (consistency.workerPlatformMismatch) {
    penalize(18, "worker_platform_mismatch", "medium", "Window navigator.platform differs from Web Worker navigator.platform.", consistency.workerPlatformMismatch);
  }
  if (consistency.iframePlatformMismatch) {
    penalize(12, "iframe_platform_mismatch", "medium", "Window navigator.platform differs from iframe navigator.platform.", consistency.iframePlatformMismatch);
  }
  if (consistency.timezoneMismatch) {
    penalize(14, "timezone_mismatch", "medium", "Browser timezone differs from IP geolocation timezone.", consistency.timezoneMismatch);
  }
  if (consistency.screenViewportImpossible) {
    penalize(12, "screen_viewport_impossible", "medium", "Viewport dimensions exceed screen dimensions.", consistency.screenViewportImpossible);
  }

  if (browser.permissions?.notifications?.state === "default" && browser.permissions?.notifications?.permission === "default") {
    penalize(8, "notification_permission_default_state", "low", "Notification permission state is 'default'; stealth tooling has historically produced this mismatch.");
  }
  if (browser.plugins?.length === 0 && /chrome|chromium|edg/i.test(browser.userAgent || "")) {
    penalize(10, "empty_plugins_chromium", "medium", "Chromium-like browser reports zero plugins.");
  }
  if (browser.prototypeChecks?.nativeGetterFailures?.length) {
    penalize(15, "prototype_getter_not_native", "medium", "Navigator property getter does not look native.", browser.prototypeChecks.nativeGetterFailures);
  }
  if (browser.pluginsConsistency?.referenceMismatch === true) {
    penalize(10, "plugin_reference_mismatch", "medium", "navigator.plugins nested enabledPlugin references are inconsistent.");
  }
  if (browser.pluginsConsistency?.itemOverflowMatchesFirst === false && browser.plugins?.length > 0) {
    penalize(5, "plugin_item_overflow", "low", "navigator.plugins.item overflow behavior differs from expected Chromium behavior.");
  }

  if (fingerprints.webgl?.supported === false) {
    penalize(10, "webgl_missing", "medium", "WebGL unavailable.");
  }
  if (fingerprints.canvas?.hash && fingerprints.canvas.hashError) {
    penalize(8, "canvas_error", "low", "Canvas fingerprint failed or was blocked.", fingerprints.canvas.hashError);
  }

  if (network.webrtc?.publicIpLeakDifferentFromServer === true) {
    penalize(25, "webrtc_public_ip_mismatch", "high", "WebRTC exposed a public IP different from the HTTP request IP.", network.webrtc);
  }
  if (network.ping?.medianMs != null && server.cf?.clientTcpRtt != null) {
    const browserPing = Number(network.ping.medianMs);
    const cfTcp = Number(server.cf.clientTcpRtt);
    if (Number.isFinite(browserPing) && Number.isFinite(cfTcp) && browserPing > cfTcp * 8 && browserPing > 300) {
      penalize(8, "browser_edge_latency_gap", "low", "Browser-to-edge fetch latency is much higher than Cloudflare TCP RTT.", { browserPing, cfTcp });
    }
  }

  if (typeof behavior.score === "number") {
    if (behavior.score < 0.25) penalize(25, "behavior_score_low", "high", "Behavior score is very low.", behavior.summary);
    else if (behavior.score < 0.5) penalize(12, "behavior_score_borderline", "medium", "Behavior score is borderline.", behavior.summary);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const classification = score >= 75 ? "likely_human" : score >= 45 ? "suspicious" : "likely_bot";
  const risk = score >= 75 ? "low" : score >= 45 ? "medium" : "high";

  return { score, classification, risk, reasons };
}

function detectionMatrix(server, client) {
  const cfBot = server?.cloudflareBotManagement;
  const rows = [
    { name: "Request profile", status: "checked", notes: "Headers, client IP, location, ASN, protocol, and timing signals." },
    { name: "Proxy indicators", status: "checked", notes: "Forwarding headers and network identity patterns." },
    { name: "Datacenter pattern", status: "checked", notes: "Hosting and provider signals in the connection profile." }
  ];

  if (server?.ipIntel?.enabled) {
    rows.push({ name: "VPN / proxy / Tor intelligence", status: "checked", notes: "External reputation and privacy-network signals." });
  }

  if (cfBot?.available) {
    rows.push(
      { name: "Managed bot score", status: "checked", notes: "Managed reputation and verified bot signals." },
      { name: "TLS fingerprint", status: "checked", notes: "Connection fingerprint signals included in the report." }
    );
  }

  if (client) {
    rows.push(
      { name: "Browser data", status: "checked", notes: "Navigator, screen, storage, media, permissions, and client hints." },
      { name: "Browser fingerprint", status: "checked", notes: "Canvas, WebGL, audio, fonts, and graphics capability hashes." },
      { name: "Worker consistency", status: "checked", notes: "Cross-context browser consistency checks." },
      { name: "WebRTC network clues", status: "checked", notes: "Candidate and address consistency signals." },
      { name: "Latency", status: "checked", notes: "Browser-to-edge timing signals." },
      { name: "Behavioural classification", status: "checked", notes: "Pointer, key, scroll, focus, timing, and human-check activity." },
      { name: "Optional human check", status: "checked", notes: "Form, confirmation, and table-update interaction signals." }
    );
  }

  return rows;
}

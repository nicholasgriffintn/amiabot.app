# Am I a Bot?

Am I a Bot? is a transparent bot/proxy/VPN detection site for browser automation and scraping-service tests. It is built as one Cloudflare Worker with static assets.

## What it checks

### Server / Cloudflare

- Request headers, with sensitive values redacted.
- Client IP from Cloudflare headers.
- `request.cf` data: country, colo, ASN, ASN organization, protocol, TCP/QUIC RTT when available.
- Proxy-style headers: `Forwarded`, `Via`, `X-Forwarded-*`, `X-Real-IP`, `True-Client-IP`, etc.
- Datacenter/hosting ASN heuristic.
- Optional IP intelligence for proxy/VPN/Tor/datacenter checks.
- Optional managed bot fields when enabled: bot score, verified bot, JA3/JA4, detection IDs.

### Browser

- `navigator` data: UA, platform, UA-CH, vendor, languages, webdriver, hardware concurrency, device memory, plugins, mime types.
- Permissions, storage, media-device counts, screen/viewport, locale/timezone.
- Automation globals and headless markers.
- Navigator prototype/getter checks.
- Plugin consistency checks.
- Canvas hash.
- WebGL/WebGL2 renderer, vendor, parameters, extension hash.
- Audio fingerprint hash.
- Font metric fingerprint.
- CSS media fingerprint.
- WebGPU availability and adapter info when exposed.
- Live `performance.memory` charts, FPS approximation, and Resource Timing visualisation.
- Encrypted Media Extensions / DRM support.
- Speech synthesis voices and Feature Policy / Permissions Policy surfaces.
- Device sensor support and passive orientation/motion samples when exposed.
- Media-device supported constraints.
- Known browser extension resource probes.
- Web Worker navigator comparison.
- Service Worker navigator comparison.
- Same-origin iframe navigator comparison.
- WebRTC ICE candidate leak check.
- Browser-to-edge latency check.
- Heap memory snapshots sent with browser-to-edge latency pings.
- Transparent behavior score from pointer, key, scroll, focus, RAF jitter, and challenge completion.
- Optional interaction challenge: form submit, confirm dialog, table update task.

## Local development

```bash
corepack enable
pnpm install
pnpm dev
```

Open the Wrangler local URL. Service Worker checks require a secure context; localhost is usually treated as secure by modern browsers.

## Deploy manually

```bash
corepack enable
pnpm install
pnpm deploy
```

## Deploy with GitHub Actions

Add these repository secrets:

| Secret | Purpose |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with Workers edit permissions |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |

Push to `main`. The workflow runs a static syntax check and deploys with Wrangler.

## Proxy/VPN detection providers

Default config uses `ipapi.is` from the Worker backend. Anonymous use works for small debug volume. For higher volume, set an API key as a Worker secret:

```bash
pnpm wrangler secret put IPAPI_IS_KEY
```

Provider switch:

```json
{
  "vars": {
    "IP_INTEL_PROVIDER": "ipapi"
  }
}
```

Supported values:

| Provider value | Required secret | Notes |
|---|---|---|
| `ipapi` | optional `IPAPI_IS_KEY` | Default. Returns `is_datacenter`, `is_proxy`, `is_vpn`, `is_tor`, etc. |
| `ipinfo` | `IPINFO_TOKEN` | Uses IPinfo privacy endpoint. |
| `ipqs` | `IPQUALITYSCORE_KEY` | Uses IPQualityScore proxy/VPN API. |
| `none` | none | Disables external IP intelligence. |

## Bot-facing API

Server-only quick check:

```bash
curl https://YOUR-WORKER.workers.dev/api/check
```

Browser report endpoint:

```http
POST /api/report
Content-Type: application/json
```

The web page posts a client-side payload to this endpoint. Response includes:

- `verdict.score` from 0 to 100.
- `verdict.classification`: `likely_human`, `suspicious`, or `likely_bot`.
- `verdict.reasons` with transparent penalties.
- `server`, `client`, and `detections` details.

## Custom domain

In Cloudflare dashboard: **Workers & Pages → your Worker → Settings → Domains & Routes → Add Custom Domain**.

## Tuning

Edit `scoreReport()` in `src/worker.js` to change thresholds and penalties. The scorer is intentionally transparent and conservative. It is for debugging automation fingerprints, not for blocking production traffic as-is.

import { describe, expect, it } from "vitest";
import worker from "../src/worker.js";
import { createWorkerEnv } from "./worker-env.js";

const requestHeaders = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-GB,en;q=0.9",
  "cf-connecting-ip": "203.0.113.44",
  "sec-ch-ua": '"Chromium";v="126"',
  "sec-ch-ua-platform": '"macOS"',
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
};

describe("server-side report consistency", () => {
  it("scores request and browser identity drift on the Worker", async () => {
    const response = await worker.fetch(new Request("https://amiabot.example/api/report", {
      method: "POST",
      headers: { ...requestHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        browser: {
          userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          userAgentData: { platform: "Windows" },
          languages: ["fr-FR", "fr"],
          webdriver: false,
          plugins: [{ name: "PDF Viewer" }]
        },
        automation: { present: [], cdpSerializationSignal: false },
        workers: {},
        fingerprints: { webgl: { supported: true } },
        consistency: {},
        behavior: { score: 1 },
        network: {},
        surfaces: {}
      })
    }), createWorkerEnv(), {});
    const body = await response.json();
    const reasonIds = body.verdict.reasons.map((reason) => reason.id);

    expect(response.status).toBe(200);
    expect(body.client.consistency).toMatchObject({
      acceptLanguageMismatch: {
        requestLanguages: ["en-gb", "en"],
        browserLanguages: ["fr-fr", "fr"]
      },
      clientHintPlatformMismatch: {
        requestPlatform: "macOS",
        browserPlatform: "Windows"
      }
    });
    expect(body.client.consistency.userAgentMismatch).toMatchObject({
      requestUserAgent: requestHeaders["user-agent"]
    });
    expect(reasonIds).toEqual(expect.arrayContaining([
      "request_client_ua_mismatch",
      "accept_language_mismatch",
      "client_hint_platform_mismatch"
    ]));
  });
});

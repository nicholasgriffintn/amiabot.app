import { describe, expect, it } from "vitest";
import { buildApiRateLimitKey } from "../src/rate-limit.js";
import worker from "../src/worker.js";
import { createWorkerEnv } from "./worker-env.js";

const browserHeaders = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-GB,en;q=0.9",
  "cf-connecting-ip": "203.0.113.44",
  "sec-ch-ua": '"Chromium";v="126"',
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
};

describe("API rate limiting", () => {
  it("uses the route and Cloudflare client IP as the rate limit key", () => {
    const request = new Request("https://amiabot.example/api/check", {
      headers: browserHeaders
    });

    expect(buildApiRateLimitKey(request)).toBe("GET:/api/check:203.0.113.44");
  });

  it("normalises unknown API routes to a shared key", () => {
    const request = new Request("https://amiabot.example/api/missing/anything", {
      headers: browserHeaders
    });

    expect(buildApiRateLimitKey(request)).toBe("GET:/api/*:203.0.113.44");
  });

  it("checks the rate limit before serving API requests", async () => {
    const calls = [];
    const env = createWorkerEnv({
      API_RATE_LIMITER: {
        async limit(input) {
          calls.push(input);
          return { success: true };
        }
      }
    });

    const response = await worker.fetch(new Request("https://amiabot.example/api/check", {
      headers: browserHeaders
    }), env, {});

    expect(response.status).toBe(200);
    expect(calls).toEqual([{ key: "GET:/api/check:203.0.113.44" }]);
  });

  it("returns a retryable JSON response when the API limit is exceeded", async () => {
    const env = createWorkerEnv({
      API_RATE_LIMITER: {
        async limit() {
          return { success: false };
        }
      }
    });

    const response = await worker.fetch(new Request("https://amiabot.example/api/report", {
      method: "POST",
      headers: { ...browserHeaders, "content-type": "application/json" },
      body: "{}"
    }), env, {});
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(body).toEqual({
      ok: false,
      error: "Rate limit exceeded. Please retry shortly.",
      retryAfterSeconds: 60
    });
  });
});

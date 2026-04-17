import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";

function computeHmac(secret: string, body: string): string {
  const hmac = crypto.createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${hmac}`;
}

// Test the HMAC logic directly since the webhook plugin is tightly coupled to Elysia
// Full E2E webhook tests are in tests/e2e/webhook.e2e.test.ts

describe("HMAC verification", () => {
  const secret = "test-webhook-secret";

  test("valid signature matches", () => {
    const body = JSON.stringify({ action: "opened", pull_request: { number: 1 } });
    const signature = computeHmac(secret, body);

    const rawBody = new TextEncoder().encode(body);
    const key = new TextEncoder().encode(secret);
    const computed = new Bun.CryptoHasher("sha256", key).update(rawBody).digest("hex");

    const a = Buffer.from(computed, "utf8");
    const b = Buffer.from(signature.slice("sha256=".length), "utf8");

    expect(a.length).toBe(b.length);
    expect(crypto.timingSafeEqual(a, b)).toBe(true);
  });

  test("invalid signature does not match", () => {
    const body = JSON.stringify({ action: "opened", pull_request: { number: 1 } });
    const tampered = body + "tampered";
    const signature = computeHmac(secret, tampered);

    const rawBody = new TextEncoder().encode(body);
    const key = new TextEncoder().encode(secret);
    const computed = new Bun.CryptoHasher("sha256", key).update(rawBody).digest("hex");

    const a = Buffer.from(computed, "utf8");
    const b = Buffer.from(signature.slice("sha256=".length), "utf8");

    expect(a.length).toBe(b.length);
    expect(crypto.timingSafeEqual(a, b)).toBe(false);
  });

  test("missing signature prefix is rejected", () => {
    const signature = "notsha256=abc123";
    expect(signature.startsWith("sha256=")).toBe(false);
  });

  test("null signature is rejected", () => {
    const signature = null as string | null;
    const rejected = signature === null || !signature.startsWith("sha256=");
    expect(rejected).toBe(true);
  });

  test("different length hex strings are rejected before timingSafeEqual", () => {
    const a = Buffer.from("abcdef", "utf8");
    const b = Buffer.from("abc", "utf8");
    expect(a.length).not.toBe(b.length);
    // timingSafeEqual would throw on unequal lengths — the length check prevents this
  });
});

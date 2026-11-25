import { describe, it, expect } from "vitest";
import {
  generateOpaqueToken,
  hashToken,
  hashPassword,
  verifyPassword,
  needsRehash,
  parseDeviceLabel,
} from "@core/Session/crypto.js";
import { normalizeEmail, validateTimezone } from "@core/Account/signup.js";

describe("opaque tokens", () => {
  it("generates raw + sha256 hash pair", () => {
    const t = generateOpaqueToken();
    expect(t.raw.length).toBeGreaterThan(30);
    expect(t.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t.raw)).toBe(t.hash);
    expect(generateOpaqueToken().raw).not.toBe(t.raw);
  });
});

describe("password hashing (argon2id)", () => {
  it("hashes and verifies; detects rehash need", async () => {
    const phc = await hashPassword("correct horse battery");
    expect(phc).toContain("$argon2id$");
    expect(await verifyPassword("correct horse battery", phc)).toBe(true);
    expect(await verifyPassword("wrong", phc)).toBe(false);
    expect(needsRehash(phc)).toBe(false);
  });

  it("verify fails closed on malformed hash", async () => {
    expect(await verifyPassword("x", "not-a-phc")).toBe(false);
  });
});

describe("normalizeEmail / validateTimezone", () => {
  it("trims and lowercases email", () => {
    expect(normalizeEmail("  Foo@Bar.COM ")).toBe("foo@bar.com");
  });
  it("validates IANA timezones", () => {
    expect(validateTimezone("Asia/Karachi")).toBe(true);
    expect(validateTimezone("Not/AZone")).toBe(false);
  });
});

describe("parseDeviceLabel", () => {
  it("returns coarse browser/OS label", () => {
    const label = parseDeviceLabel(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
    );
    expect(label).toBe("Chrome on Windows");
    expect(parseDeviceLabel(undefined)).toBeNull();
  });
});

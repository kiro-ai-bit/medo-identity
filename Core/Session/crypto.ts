import { createHash, randomBytes, randomUUID } from "node:crypto";
import argon2 from "argon2";

const ARGON2_OPTS = {
  type: argon2.argon2id,
  timeCost: 3,
  memoryCost: 65536,
  parallelism: 4,
  version: 0x13,
} as const;

function argon2Opts() {
  if (process.env.ARGON2_TEST_FAST === "1") {
    return { ...ARGON2_OPTS, timeCost: 1, memoryCost: 16384, parallelism: 1 };
  }
  return ARGON2_OPTS;
}

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, argon2Opts());
}

export async function verifyPassword(
  plain: string,
  phc: string,
): Promise<boolean> {
  try {
    return await argon2.verify(phc, plain);
  } catch {
    return false;
  }
}

export function needsRehash(phc: string): boolean {
  try {
    return argon2.needsRehash(phc, argon2Opts());
  } catch {
    return false;
  }
}

export function generateOpaqueToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashToken(raw) };
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function newJti(): string {
  return randomUUID();
}

export function parseDeviceLabel(userAgent: string | undefined): string | null {
  if (!userAgent) return null;
  const ua = userAgent.slice(0, 500);
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "unknown-browser";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Android/.test(ua)
      ? "Android"
      : /iPhone|iPad/.test(ua)
        ? "iOS"
        : /Mac OS/.test(ua)
          ? "macOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "unknown-os";
  return `${browser} on ${os}`.slice(0, 120);
}

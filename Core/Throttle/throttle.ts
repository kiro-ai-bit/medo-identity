import { createHash } from "node:crypto";
import { createThrottleRepo } from "@infrastructure/Persistence/repositories.js";
import type { Db, DbTx } from "@infrastructure/Persistence/db.js";

const LOGIN_WINDOW_MS = 25 * 60 * 1000;
const LOGIN_COOLDOWN_MS = 25 * 60 * 1000;
const LOGIN_MAX_FAILURES = 3;

function loginSubjectHash(email: string, ip: string): string {
  return createHash("sha256").update(`${email}\n${ip}`).digest("hex");
}

export type ThrottleVerdict =
  { kind: "allow" } | { kind: "cooldown"; retryAfterMs: number };

export async function checkLoginThrottle(
  db: Db | DbTx,
  email: string,
  ip: string,
  now = new Date(),
): Promise<ThrottleVerdict> {
  const repo = createThrottleRepo(db as Db);
  const row = await repo.get("login", loginSubjectHash(email, ip));
  if (!row) return { kind: "allow" };
  if (row.cooldownUntil && row.cooldownUntil.getTime() > now.getTime()) {
    return {
      kind: "cooldown",
      retryAfterMs: row.cooldownUntil.getTime() - now.getTime(),
    };
  }
  return { kind: "allow" };
}

export async function recordLoginFailure(
  db: Db | DbTx,
  email: string,
  ip: string,
  now = new Date(),
): Promise<{ cooldownActivated: boolean }> {
  const repo = createThrottleRepo(db as Db);
  const subjectHash = loginSubjectHash(email, ip);

  // Race-safe first write: INSERT ... ON CONFLICT DO NOTHING; on conflict fall
  // through to the read-modify-write path (bounded last-writer-wins per LLD §5.4).
  const inserted = await repo.tryInsert("login", subjectHash, {
    windowStartedAt: now,
    failureCount: 1,
    cooldownUntil: null,
    updatedAt: now,
  });
  if (inserted) return { cooldownActivated: false };

  const row = await repo.get("login", subjectHash);
  if (!row) return { cooldownActivated: false };
  const windowExpired =
    now.getTime() - row.windowStartedAt.getTime() > LOGIN_WINDOW_MS;
  const failureCount = windowExpired ? 1 : row.failureCount + 1;
  const activate = failureCount >= LOGIN_MAX_FAILURES;
  const cooldownUntil = activate
    ? row.cooldownUntil && row.cooldownUntil.getTime() > now.getTime()
      ? row.cooldownUntil
      : new Date(now.getTime() + LOGIN_COOLDOWN_MS)
    : null;
  await repo.updateById(row.id, {
    windowStartedAt: windowExpired ? now : row.windowStartedAt,
    failureCount,
    cooldownUntil,
    updatedAt: now,
  });
  return {
    cooldownActivated:
      activate &&
      !(row.cooldownUntil && row.cooldownUntil.getTime() > now.getTime()),
  };
}

export async function resetLoginThrottle(
  db: Db | DbTx,
  email: string,
  ip: string,
): Promise<void> {
  const repo = createThrottleRepo(db as Db);
  await repo.delete("login", loginSubjectHash(email, ip));
}

const FORGOT_WINDOW_MS = 60 * 60 * 1000;
const FORGOT_MAX_REQUESTS = 2;

export function forgotSubjectHash(email: string): string {
  return createHash("sha256").update(email).digest("hex");
}

function pruneRequestTimes(times: unknown, now: Date): number[] {
  const cutoff = now.getTime() - FORGOT_WINDOW_MS;
  if (!Array.isArray(times)) return [];
  return times
    .map((t) => (typeof t === "string" ? Date.parse(t) : NaN))
    .filter((ms) => Number.isFinite(ms) && ms > cutoff)
    .map((ms) => ms);
}

export async function checkForgotWindow(
  db: Db | DbTx,
  email: string,
  now = new Date(),
): Promise<boolean> {
  const repo = createThrottleRepo(db as Db);
  const row = await repo.get("forgot-password", forgotSubjectHash(email));
  if (!row) return true;
  return pruneRequestTimes(row.requestTimes, now).length < FORGOT_MAX_REQUESTS;
}

export async function recordForgotRequest(
  db: Db | DbTx,
  email: string,
  now = new Date(),
): Promise<void> {
  const repo = createThrottleRepo(db as Db);
  const subjectHash = forgotSubjectHash(email);
  const row = await repo.get("forgot-password", subjectHash);
  const times = pruneRequestTimes(row?.requestTimes, now);
  times.push(now.getTime());
  const iso = times.map((ms) => new Date(ms).toISOString());
  await repo.upsert("forgot-password", subjectHash, {
    requestTimes: iso,
    requestCount: iso.length,
    updatedAt: now,
  });
}

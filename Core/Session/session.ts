import {
  txRunner,
  type Db,
  type DbTx,
} from "@infrastructure/Persistence/db.js";
import {
  createSessionsRepo,
  createUsersRepo,
} from "@infrastructure/Persistence/repositories.js";
import {
  generateOpaqueToken,
  hashPassword,
  hashToken,
  needsRehash,
  parseDeviceLabel,
  verifyPassword,
} from "./crypto.js";
import { normalizeEmail } from "@core/Account/signup.js";
import {
  checkLoginThrottle,
  recordLoginFailure,
  resetLoginThrottle,
} from "@core/Throttle/throttle.js";
import type { TokenService } from "./jwt.js";
import type { Metrics } from "../metrics.js";
import { AuthError, RateLimitedError } from "@core/errors.js";
import type { Role } from "@core/types.js";

const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const ACCESS_TOKEN_TTL_SEC = 25 * 60;

export interface LoginCommand {
  email: string;
  password: string;
  ip: string;
  userAgent?: string;
}

export interface SessionResult {
  userId: string;
  accessToken: string;
  expiresAt: string;
  rawRefresh: string;
}

export interface SessionDeps {
  tokens: TokenService;
  metrics?: Metrics;
}

export async function login(
  db: Db,
  cmd: LoginCommand,
  deps: SessionDeps,
): Promise<SessionResult> {
  const email = normalizeEmail(cmd.email);
  const now = new Date();

  const verdict = await checkLoginThrottle(db, email, cmd.ip, now);
  if (verdict.kind === "cooldown") {
    throw new RateLimitedError(Math.ceil(verdict.retryAfterMs / 1000));
  }

  const usersRepo = createUsersRepo(db);
  const user = await usersRepo.findByEmail(email);
  const ok =
    user !== null && (await verifyPassword(cmd.password, user.passwordHash));
  if (!ok) {
    const failure = await txRunner(db, (tx) =>
      recordLoginFailure(tx, email, cmd.ip, now),
    );
    deps.metrics?.incr("medo_identity_login_failures_total");
    if (failure.cooldownActivated) {
      deps.metrics?.incr("medo_identity_cooldown_activations_total");
    }
    throw new AuthError(401, "UNAUTHORIZED", "invalid credentials");
  }
  if (!user.emailVerified) {
    throw new AuthError(403, "EMAIL_NOT_VERIFIED", "email not verified");
  }

  const rehash = needsRehash(user.passwordHash);
  const refresh = generateOpaqueToken();
  const sessionExpiresAt = new Date(now.getTime() + REFRESH_TTL_MS);

  const session = await txRunner(db, async (tx: DbTx) => {
    const tUsers = createUsersRepo(tx as unknown as Db);
    const tSessions = createSessionsRepo(tx as unknown as Db);
    if (rehash) {
      await tUsers.setPasswordHash(user.id, await hashPassword(cmd.password));
    }
    await resetLoginThrottle(tx, email, cmd.ip);
    return tSessions.insert({
      userId: user.id,
      refreshTokenHash: refresh.hash,
      deviceLabel: parseDeviceLabel(cmd.userAgent),
      expiresAt: sessionExpiresAt,
      lastUsedAt: now,
    });
  });

  const issued = await deps.tokens.issueAccessToken({
    sub: user.id,
    role: user.role as Role,
    sid: session.id,
  });
  return {
    userId: user.id,
    accessToken: issued.token,
    expiresAt: issued.expiresAt.toISOString(),
    rawRefresh: refresh.raw,
  };
}

export async function rotateRefresh(
  db: Db,
  rawToken: string,
  deps: SessionDeps,
): Promise<SessionResult> {
  const now = new Date();
  const hash = hashToken(rawToken);
  const sessionsRepo = createSessionsRepo(db);
  const usersRepo = createUsersRepo(db);

  const session = await sessionsRepo.findByRefreshHash(hash);
  if (session) {
    if (
      session.revokedAt !== null ||
      session.expiresAt.getTime() <= now.getTime()
    ) {
      throw new AuthError(401, "UNAUTHORIZED", "session expired");
    }
    const refresh = generateOpaqueToken();
    const rotated = await txRunner(db, async (tx: DbTx) =>
      createSessionsRepo(tx as unknown as Db).rotate(session.id, hash, {
        refreshTokenHash: refresh.hash,
        prevRefreshTokenHash: hash,
        expiresAt: new Date(now.getTime() + REFRESH_TTL_MS),
        lastUsedAt: now,
      }),
    );
    if (rotated) {
      const user = await usersRepo.findById(session.userId);
      if (!user) throw new AuthError(401, "UNAUTHORIZED", "account deleted");
      const issued = await deps.tokens.issueAccessToken({
        sub: user.id,
        role: user.role as Role,
        sid: session.id,
      });
      return {
        userId: user.id,
        accessToken: issued.token,
        expiresAt: issued.expiresAt.toISOString(),
        rawRefresh: refresh.raw,
      };
    }
    // Lost rotation race — fall through to prev-hash reuse check.
  }

  const prev = await sessionsRepo.findByPrevRefreshHash(hash);
  if (prev && prev.revokedAt === null) {
    await sessionsRepo.revoke(prev.id);
    deps.metrics?.incr("medo_identity_refresh_reuse_revocations_total");
  }
  throw new AuthError(401, "UNAUTHORIZED", "invalid refresh token");
}

export async function logout(
  db: Db,
  opts: { rawRefresh?: string; sid?: string },
): Promise<void> {
  const sessionsRepo = createSessionsRepo(db);
  if (opts.rawRefresh) {
    const session = await sessionsRepo.findByRefreshHash(
      hashToken(opts.rawRefresh),
    );
    if (session) await sessionsRepo.revoke(session.id);
    return;
  }
  if (opts.sid) {
    const session = await sessionsRepo.findById(opts.sid);
    if (session) await sessionsRepo.revoke(session.id);
  }
}

export async function logoutAll(db: Db, userId: string): Promise<void> {
  await createSessionsRepo(db).revokeAllForUser(userId);
}

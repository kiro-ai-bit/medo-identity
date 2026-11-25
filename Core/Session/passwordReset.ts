import { appendOutbox } from "@infrastructure/Persistence/outbox.js";
import {
  txRunner,
  type Db,
  type DbTx,
} from "@infrastructure/Persistence/db.js";
import {
  createAuthTokensRepo,
  createSessionsRepo,
  createUsersRepo,
} from "@infrastructure/Persistence/repositories.js";
import { generateOpaqueToken, hashPassword, hashToken } from "./crypto.js";
import {
  checkForgotWindow,
  recordForgotRequest,
} from "@core/Throttle/throttle.js";
import { normalizeEmail } from "@core/Account/signup.js";
import { AuthError } from "@core/errors.js";

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

export async function forgotPassword(
  db: Db,
  email: string,
  deps: { appBaseUrl: string },
): Promise<void> {
  const normalized = normalizeEmail(email);
  const now = new Date();
  await txRunner(db, async (tx: DbTx) => {
    if (!(await checkForgotWindow(tx, normalized, now))) return;
    const usersRepo = createUsersRepo(tx as unknown as Db);
    const user = await usersRepo.findByEmail(normalized);
    if (!user) return;

    const reset = generateOpaqueToken();
    const tokensRepo = createAuthTokensRepo(tx as unknown as Db);
    await tokensRepo.insert({
      userId: user.id,
      kind: "password-reset",
      tokenHash: reset.hash,
      expiresAt: new Date(now.getTime() + RESET_TOKEN_TTL_MS),
    });
    await recordForgotRequest(tx, normalized, now);
    await appendOutbox(tx, {
      type: "PasswordResetRequested",
      payload: {
        userId: user.id,
        email: normalized,
        resetLink: `${deps.appBaseUrl}/reset-password?token=${reset.raw}`,
      },
    });
  });
}

export async function resetPassword(
  db: Db,
  rawToken: string,
  newPassword: string,
): Promise<{ revokedSessions: number }> {
  const now = new Date();
  const hash = hashToken(rawToken);
  return txRunner(db, async (tx: DbTx) => {
    const tokensRepo = createAuthTokensRepo(tx as unknown as Db);
    const usersRepo = createUsersRepo(tx as unknown as Db);
    const sessionsRepo = createSessionsRepo(tx as unknown as Db);
    const row = await tokensRepo.consumeByHash(hash, "password-reset", now);
    if (!row) {
      throw new AuthError(401, "UNAUTHORIZED", "invalid or expired token");
    }
    await usersRepo.setPasswordHash(
      row.userId,
      await hashPassword(newPassword),
    );
    const revokedSessions = await sessionsRepo.revokeAllForUser(row.userId);
    return { revokedSessions };
  });
}

import { appendOutbox } from "@infrastructure/Persistence/outbox.js";
import {
  txRunner,
  type Db,
  type DbTx,
} from "@infrastructure/Persistence/db.js";
import {
  createAuthTokensRepo,
  createUsersRepo,
} from "@infrastructure/Persistence/repositories.js";
import { generateOpaqueToken, hashToken } from "@core/Session/crypto.js";
import { AuthError } from "@core/errors.js";
import { normalizeEmail } from "./signup.js";

const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export async function issueEmailVerifyToken(
  tx: DbTx,
  userId: string,
  email: string,
  appBaseUrl: string,
): Promise<void> {
  const verify = generateOpaqueToken();
  const tokensRepo = createAuthTokensRepo(tx as unknown as Db);
  await tokensRepo.insert({
    userId,
    kind: "email-verify",
    tokenHash: verify.hash,
    expiresAt: new Date(Date.now() + VERIFY_TOKEN_TTL_MS),
  });
  await appendOutbox(tx, {
    type: "EmailVerificationRequested",
    payload: {
      userId,
      email,
      verifyLink: `${appBaseUrl}/verify-email?token=${verify.raw}`,
    },
  });
}

export async function verifyEmail(db: Db, rawToken: string): Promise<void> {
  const now = new Date();
  const hash = hashToken(rawToken);
  await txRunner(db, async (tx: DbTx) => {
    const tokensRepo = createAuthTokensRepo(tx as unknown as Db);
    const usersRepo = createUsersRepo(tx as unknown as Db);
    const row = await tokensRepo.consumeByHash(hash, "email-verify", now);
    if (!row) {
      throw new AuthError(401, "UNAUTHORIZED", "invalid or expired token");
    }
    await usersRepo.setEmailVerified(row.userId);
  });
}

export async function resendVerification(
  db: Db,
  email: string,
  deps: { appBaseUrl: string },
): Promise<void> {
  const normalized = normalizeEmail(email);
  await txRunner(db, async (tx: DbTx) => {
    const usersRepo = createUsersRepo(tx as unknown as Db);
    const user = await usersRepo.findByEmail(normalized);
    if (!user || user.emailVerified) return;
    await issueEmailVerifyToken(tx, user.id, normalized, deps.appBaseUrl);
  });
}

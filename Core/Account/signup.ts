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
import { generateOpaqueToken, hashPassword } from "@core/Session/crypto.js";
import { ConflictError, ValidationError } from "@core/errors.js";
import type { Role } from "@core/types.js";

export interface SignupCommand {
  name: string;
  email: string;
  password: string;
  role: Role;
}

export interface SignupResult {
  userId: string;
  email: string;
  role: Role;
}

const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function validateTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function signup(
  db: Db,
  cmd: SignupCommand,
  deps: { appBaseUrl: string },
): Promise<SignupResult> {
  if (cmd.role !== "Patient" && cmd.role !== "Caregiver") {
    throw new ValidationError("invalid role");
  }
  const email = normalizeEmail(cmd.email);
  const passwordHash = await hashPassword(cmd.password);
  const verify = generateOpaqueToken();

  try {
    return await txRunner(db, async (tx: DbTx) => {
      const usersRepo = createUsersRepo(tx as unknown as Db);
      const tokensRepo = createAuthTokensRepo(tx as unknown as Db);
      const user = await usersRepo.insert({
        email,
        passwordHash,
        displayName: cmd.name.trim(),
        timezone: "UTC",
        role: cmd.role,
        emailVerified: false,
      });
      await tokensRepo.insert({
        userId: user.id,
        kind: "email-verify",
        tokenHash: verify.hash,
        expiresAt: new Date(Date.now() + VERIFY_TOKEN_TTL_MS),
      });
      await appendOutbox(tx, {
        type: "UserRegistered",
        payload: { userId: user.id, role: cmd.role },
      });
      await appendOutbox(tx, {
        type: "EmailVerificationRequested",
        payload: {
          userId: user.id,
          email,
          verifyLink: `${deps.appBaseUrl}/verify-email?token=${verify.raw}`,
        },
      });
      return { userId: user.id, email, role: cmd.role };
    });
  } catch (err) {
    if (isUniqueViolation(err))
      throw new ConflictError("email already registered");
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur; i++) {
    if (
      typeof cur === "object" &&
      "code" in cur &&
      (cur as { code?: string }).code === "23505"
    ) {
      return true;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

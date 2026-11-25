import { appendOutbox } from "@infrastructure/Persistence/outbox.js";
import { issueEmailVerifyToken } from "./verify.js";
import {
  txRunner,
  type Db,
  type DbTx,
} from "@infrastructure/Persistence/db.js";
import { createUsersRepo } from "@infrastructure/Persistence/repositories.js";
import { hashPassword } from "@core/Session/crypto.js";
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

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function validateTimezone(tz: string): boolean {
  if (tz === "UTC") return true;
  try {
    return Intl.supportedValuesOf("timeZone").includes(tz);
  } catch {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
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

  try {
    return await txRunner(db, async (tx: DbTx) => {
      const usersRepo = createUsersRepo(tx as unknown as Db);
      const user = await usersRepo.insert({
        email,
        passwordHash,
        displayName: cmd.name.trim(),
        timezone: "UTC",
        role: cmd.role,
        emailVerified: false,
      });
      await appendOutbox(tx, {
        type: "UserRegistered",
        payload: { userId: user.id, role: cmd.role },
      });
      await issueEmailVerifyToken(tx, user.id, email, deps.appBaseUrl);
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

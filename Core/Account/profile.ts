import { appendOutbox } from "@infrastructure/Persistence/outbox.js";
import {
  txRunner,
  type Db,
  type DbTx,
} from "@infrastructure/Persistence/db.js";
import { createUsersRepo } from "@infrastructure/Persistence/repositories.js";
import type { UserRow } from "@infrastructure/Persistence/schema/index.js";
import { AuthError, ValidationError } from "@core/errors.js";
import type { Role } from "@core/types.js";
import { validateTimezone } from "./signup.js";

export interface OwnProfileDto {
  displayName: string;
  timezone: string;
  role: Role;
  email: string;
  emailVerified: boolean;
}

export interface ProfilePatch {
  displayName?: string;
  timezone?: string;
}

const MUTABLE_FIELDS = [
  "displayName",
  "timezone",
] as const satisfies readonly (keyof ProfilePatch)[];

function assertMutableKeys(patch: ProfilePatch): void {
  for (const k of Object.keys(patch)) {
    if (!(MUTABLE_FIELDS as readonly string[]).includes(k)) {
      throw new ValidationError(`field not mutable: ${k}`);
    }
  }
}

function toDto(user: UserRow): OwnProfileDto {
  return {
    displayName: user.displayName,
    timezone: user.timezone,
    role: user.role as Role,
    email: user.email,
    emailVerified: user.emailVerified,
  };
}

export async function getOwnProfile(
  db: Db,
  userId: string,
): Promise<OwnProfileDto> {
  const user = await createUsersRepo(db).findById(userId);
  if (!user) throw new AuthError(401, "UNAUTHORIZED", "account not found");
  return toDto(user);
}

export async function updateOwnProfile(
  db: Db,
  userId: string,
  patch: ProfilePatch,
): Promise<OwnProfileDto> {
  assertMutableKeys(patch);
  const mutable: ProfilePatch = {};
  if (patch.displayName !== undefined) {
    mutable.displayName = patch.displayName.trim();
    if (mutable.displayName === "") {
      throw new ValidationError("displayName must not be empty");
    }
  }
  if (patch.timezone !== undefined) {
    if (!validateTimezone(patch.timezone)) {
      throw new ValidationError("invalid timezone");
    }
    mutable.timezone = patch.timezone;
  }

  return txRunner(db, async (tx: DbTx) => {
    const usersRepo = createUsersRepo(tx as unknown as Db);
    const before = await usersRepo.findById(userId);
    if (!before) throw new AuthError(401, "UNAUTHORIZED", "account not found");
    const after = await usersRepo.updateProfile(userId, mutable);
    if (!after) throw new AuthError(401, "UNAUTHORIZED", "account not found");

    const changedFields = MUTABLE_FIELDS.filter(
      (k) => before[k] !== after[k],
    ).sort();
    if (changedFields.length > 0) {
      await appendOutbox(tx, {
        type: "ProfileChanged",
        payload: { userId, changedFields },
      });
    }
    return toDto(after);
  });
}

import { createHash } from "node:crypto";
import { appendOutbox } from "@infrastructure/Persistence/outbox.js";
import {
  txRunner,
  type Db,
  type DbTx,
} from "@infrastructure/Persistence/db.js";
import {
  createSessionsRepo,
  createUsersRepo,
} from "@infrastructure/Persistence/repositories.js";
import type { CareLinksClient } from "@infrastructure/Clients/careLinksClient.js";
import type { Metrics } from "@core/metrics.js";
import { ConflictError, DependencyError, NotFoundError } from "@core/errors.js";

export interface DeleteAccountDeps {
  careLinks: CareLinksClient;
  metrics?: Metrics;
}

export interface DeleteAccountResult {
  revokedSessions: number;
}

export async function deleteAccount(
  db: Db,
  userId: string,
  deps: DeleteAccountDeps,
): Promise<DeleteAccountResult> {
  const usersRepo = createUsersRepo(db);
  const user = await usersRepo.findById(userId);
  if (!user) throw new NotFoundError("account not found");

  // Peer call BEFORE tx opens — never inside (LD-ID-10, HD-ID-06).
  if (user.role === "Patient") {
    let links;
    try {
      links = await deps.careLinks.getPatientLinks(userId);
    } catch {
      deps.metrics?.incr("medo_identity_care_check_failures_total");
      throw new DependencyError("care links check failed");
    }
    if (links.activeCount > 0) {
      throw new ConflictError("account has active care links");
    }
  }

  const revokedSessions = await createSessionsRepo(db).countForUser(userId);
  const throttleSubjectHash = createHash("sha256")
    .update(user.email)
    .digest("hex");

  await txRunner(db, async (tx: DbTx) => {
    const tUsers = createUsersRepo(tx as unknown as Db);
    await tUsers.deleteWithDependents(userId, throttleSubjectHash);
    await appendOutbox(tx, {
      type: "AccountDeleted",
      payload: { userId },
    });
  });
  return { revokedSessions };
}

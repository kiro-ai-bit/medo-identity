import { createUsersRepo } from "@infrastructure/Persistence/repositories.js";
import type { Db } from "@infrastructure/Persistence/db.js";
import type { Role } from "@core/types.js";

export interface DirectoryDto {
  id: string;
  displayName: string;
  role: Role;
  email: string;
}

export async function getDirectoryEntry(
  db: Db,
  userId: string,
): Promise<DirectoryDto | null> {
  const user = await createUsersRepo(db).findById(userId);
  if (!user) return null;
  return {
    id: user.id,
    displayName: user.displayName,
    role: user.role as Role,
    email: user.email,
  };
}

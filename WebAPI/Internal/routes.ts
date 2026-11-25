import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getDirectoryEntry } from "@core/Directory/directory.js";
import type { Db } from "@infrastructure/Persistence/db.js";
import { NotFoundError } from "../Middleware/errors.js";

const paramsSchema = z.object({ id: z.uuid() });

const directoryDtoSchema = z.strictObject({
  id: z.uuid(),
  displayName: z.string(),
  role: z.enum(["Patient", "Caregiver"]),
  email: z.string(),
});

export interface InternalRoutesDeps {
  db: Db;
}

export function registerInternalRoutes(
  app: FastifyInstance,
  deps: InternalRoutesDeps,
): void {
  app.get(
    "/v1/users/:id",
    {
      config: { auth: "service", rateLimit: "internal" },
      schema: {
        params: paramsSchema,
        response: { 200: directoryDtoSchema },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const entry = await getDirectoryEntry(deps.db, id);
      if (!entry) throw new NotFoundError("user not found");
      return entry;
    },
  );
}

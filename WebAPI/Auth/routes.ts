import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  LoginRequestSchema,
  LoginResponseSchema,
  RefreshResponseSchema,
  SignupRequestSchema,
  SignupResponseSchema,
  type LoginRequest,
  type LoginResponse,
  type RefreshResponse,
  type SignupRequest,
  type SignupResponse,
} from "@kiro-ai-bit/contracts";
import {
  login,
  logout,
  logoutAll,
  rotateRefresh,
} from "@core/Session/session.js";
import { signup } from "@core/Account/signup.js";
import type { Role } from "@core/types.js";
import type { Db } from "@infrastructure/Persistence/db.js";
import type { TokenService } from "@core/Session/jwt.js";
import { AuthError } from "../Middleware/errors.js";
import type { Metrics } from "../Middleware/metrics.js";

export const REFRESH_COOKIE = "medo_rt";
const REFRESH_MAX_AGE_SEC = 30 * 24 * 60 * 60;

export interface AuthRoutesDeps {
  db: Db;
  tokens: TokenService;
  appBaseUrl: string;
  metrics: Metrics;
}

function setRefreshCookie(reply: FastifyReply, rawToken: string): void {
  reply.header(
    "set-cookie",
    `${REFRESH_COOKIE}=${rawToken}; HttpOnly; Secure; SameSite=Lax; Path=/v1/auth; Max-Age=${REFRESH_MAX_AGE_SEC}`,
  );
}

function clearRefreshCookie(reply: FastifyReply): void {
  reply.header(
    "set-cookie",
    `${REFRESH_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/v1/auth; Max-Age=0`,
  );
}

function readRefreshCookie(request: FastifyRequest): string | null {
  const cookie = request.headers.cookie;
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === REFRESH_COOKIE) return v.join("=") || null;
  }
  return null;
}

function sessionBody(r: {
  userId: string;
  accessToken: string;
  expiresAt: string;
}): LoginResponse & RefreshResponse {
  return {
    userId: r.userId,
    accessToken: r.accessToken,
    expiresAt: r.expiresAt,
  };
}

export function registerAuthRoutes(
  app: FastifyInstance,
  deps: AuthRoutesDeps,
): void {
  app.post(
    "/v1/auth/signup",
    {
      config: { rateLimit: "public" },
      schema: {
        body: SignupRequestSchema,
        response: { 201: SignupResponseSchema },
      },
    },
    async (request, reply) => {
      const body = request.body as SignupRequest;
      const result = await signup(
        deps.db,
        { ...body, role: body.role as Role },
        { appBaseUrl: deps.appBaseUrl },
      );
      const out: SignupResponse = {
        userId: result.userId,
        email: result.email,
        role: result.role,
      };
      return reply.code(201).send(out);
    },
  );

  app.post(
    "/v1/auth/login",
    {
      config: { rateLimit: "public" },
      schema: {
        body: LoginRequestSchema,
        response: { 200: LoginResponseSchema },
      },
    },
    async (request, reply) => {
      const body = request.body as LoginRequest;
      const result = await login(
        deps.db,
        {
          email: body.email,
          password: body.password,
          ip: request.ip,
          userAgent: request.headers["user-agent"],
        },
        { tokens: deps.tokens, metrics: deps.metrics },
      );
      deps.metrics.incr("medo_identity_login_successes_total");
      setRefreshCookie(reply, result.rawRefresh);
      return reply.code(200).send(sessionBody(result));
    },
  );

  app.post(
    "/v1/auth/refresh",
    {
      config: { rateLimit: "public" },
      schema: { response: { 200: RefreshResponseSchema } },
    },
    async (request, reply) => {
      const raw = readRefreshCookie(request);
      if (!raw)
        throw new AuthError(401, "UNAUTHORIZED", "missing refresh cookie");
      const result = await rotateRefresh(deps.db, raw, {
        tokens: deps.tokens,
        metrics: deps.metrics,
      });
      setRefreshCookie(reply, result.rawRefresh);
      return reply.code(200).send(sessionBody(result));
    },
  );

  app.post(
    "/v1/auth/logout",
    { config: { auth: "optional-user", rateLimit: { scope: "write" } } },
    async (request, reply) => {
      const raw = readRefreshCookie(request);
      const sid = request.user?.sid;
      if (!raw && !sid)
        throw new AuthError(401, "UNAUTHORIZED", "no session credential");
      await logout(deps.db, { rawRefresh: raw ?? undefined, sid });
      deps.metrics.incr("medo_identity_session_revocations_total", {
        reason: "logout",
      });
      clearRefreshCookie(reply);
      return reply.code(204).send();
    },
  );

  app.post(
    "/v1/auth/logout-all",
    { config: { auth: "user", rateLimit: "write" } },
    async (request, reply) => {
      const user = request.user;
      if (!user) throw new AuthError(401, "UNAUTHORIZED", "unauthenticated");
      await logoutAll(deps.db, user.sub);
      deps.metrics.incr("medo_identity_session_revocations_total", {
        reason: "logout-all",
      });
      clearRefreshCookie(reply);
      return reply.code(204).send();
    },
  );
}

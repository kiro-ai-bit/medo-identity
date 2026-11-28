import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  createTestApp,
  signupBody,
  markEmailVerified,
  type TestApp,
} from "../helpers.js";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.closeAll();
});

function stubCare(activeCount: number | "down") {
  const fn = vi.fn(async () => {
    if (activeCount === "down") throw new Error("connect ECONNREFUSED");
    return new Response(
      JSON.stringify({
        links: Array.from({ length: activeCount }, (_, i) => ({
          linkId: `link-${i}`,
          caregiverId: `cg-${i}`,
        })),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

async function signupVerifiedLogin(role: "Patient" | "Caregiver" = "Patient") {
  const body = signupBody({ role });
  const su = await t.app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: body,
  });
  expect(su.statusCode).toBe(201);
  const userId = su.json().userId as string;
  await markEmailVerified(t.servicePg, body.email as string);
  const li = await t.app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email: body.email, password: body.password },
  });
  expect(li.statusCode).toBe(200);
  return {
    userId,
    email: body.email as string,
    accessToken: li.json().accessToken as string,
  };
}

async function countRows(table: string, userId: string): Promise<number> {
  const res = await t.servicePg.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`,
    [userId],
  );
  return res.rows[0].n;
}

describe("DELETE /v1/me", () => {
  it("rejects anonymous with 401", async () => {
    stubCare(0);
    const res = await t.app.inject({ method: "DELETE", url: "/v1/me" });
    expect(res.statusCode).toBe(401);
  });

  it("refuses Patient with active care links (409) and keeps account", async () => {
    const fetchMock = stubCare(2);
    const { userId, accessToken } = await signupVerifiedLogin("Patient");
    const res = await t.app.inject({
      method: "DELETE",
      url: "/v1/me",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");
    expect(fetchMock).toHaveBeenCalledOnce();
    const u = await t.servicePg.query(`SELECT 1 FROM users WHERE id = $1`, [
      userId,
    ]);
    expect(u.rows.length).toBe(1);
  });

  it("fails closed with 503 when Care is unreachable", async () => {
    stubCare("down");
    const { userId, accessToken } = await signupVerifiedLogin("Patient");
    const res = await t.app.inject({
      method: "DELETE",
      url: "/v1/me",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("DEPENDENCY_UNAVAILABLE");
    const u = await t.servicePg.query(`SELECT 1 FROM users WHERE id = $1`, [
      userId,
    ]);
    expect(u.rows.length).toBe(1);
  });

  it("deletes Patient with zero active links: cascade + AccountDeleted outbox", async () => {
    stubCare(0);
    const { userId, accessToken } = await signupVerifiedLogin("Patient");
    expect(await countRows("auth_sessions", userId)).toBe(1);

    const res = await t.app.inject({
      method: "DELETE",
      url: "/v1/me",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(204);

    const u = await t.servicePg.query(`SELECT 1 FROM users WHERE id = $1`, [
      userId,
    ]);
    expect(u.rows.length).toBe(0);
    expect(await countRows("auth_sessions", userId)).toBe(0);
    expect(await countRows("auth_tokens", userId)).toBe(0);

    const ev = await t.servicePg.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM outbox WHERE event_type = 'AccountDeleted' AND payload->>'userId' = $1`,
      [userId],
    );
    expect(ev.rows.length).toBe(1);
    expect(ev.rows[0].payload.userId).toBe(userId);
  });

  it("deletes Caregiver without calling Care", async () => {
    const fetchMock = stubCare("down");
    const { userId, accessToken } = await signupVerifiedLogin("Caregiver");
    const res = await t.app.inject({
      method: "DELETE",
      url: "/v1/me",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(204);
    expect(fetchMock).not.toHaveBeenCalled();
    const u = await t.servicePg.query(`SELECT 1 FROM users WHERE id = $1`, [
      userId,
    ]);
    expect(u.rows.length).toBe(0);
  });

  it("repeat delete returns 404", async () => {
    stubCare(0);
    const { accessToken } = await signupVerifiedLogin("Patient");
    const first = await t.app.inject({
      method: "DELETE",
      url: "/v1/me",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(first.statusCode).toBe(204);
    const second = await t.app.inject({
      method: "DELETE",
      url: "/v1/me",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(second.statusCode).toBe(404);
    expect(second.json().error.code).toBe("NOT_FOUND");
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestApp,
  signupBody,
  markEmailVerified,
  mintServiceToken,
  type TestApp,
} from "../helpers.js";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.closeAll();
});

async function createUser(email: string) {
  const res = await t.app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: signupBody({ email, name: "Dir User" }),
  });
  expect(res.statusCode).toBe(201);
  return res.json().userId as string;
}

describe("GET /v1/users/{id} (internal directory)", () => {
  it("returns directory DTO for service-JWT caller", async () => {
    const userId = await createUser("dir-ok@example.com");
    const token = await mintServiceToken(t.keys, { iss: "medo-care" });
    const res = await t.app.inject({
      method: "GET",
      url: `/v1/users/${userId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: userId,
      displayName: "Dir User",
      role: "Patient",
      email: "dir-ok@example.com",
    });
  });

  it("rejects anonymous with 401", async () => {
    const userId = await createUser("dir-anon@example.com");
    const res = await t.app.inject({
      method: "GET",
      url: `/v1/users/${userId}`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHORIZED");
  });

  it("rejects user JWT with 401 (service surface only)", async () => {
    const userId = await createUser("dir-userjwt@example.com");
    const email = "dir-userjwt@example.com";
    await markEmailVerified(t.servicePg, email);
    const li = await t.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email, password: "password123" },
    });
    expect(li.statusCode).toBe(200);
    const res = await t.app.inject({
      method: "GET",
      url: `/v1/users/${userId}`,
      headers: { authorization: `Bearer ${li.json().accessToken}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects service JWT with wrong audience with 403", async () => {
    const userId = await createUser("dir-wrongaud@example.com");
    const token = await mintServiceToken(t.keys, {
      iss: "medo-care",
      aud: "medo-care",
    });
    const res = await t.app.inject({
      method: "GET",
      url: `/v1/users/${userId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  it("returns 404 for unknown user", async () => {
    const token = await mintServiceToken(t.keys, { iss: "medo-medicine" });
    const res = await t.app.inject({
      method: "GET",
      url: "/v1/users/00000000-0000-0000-0000-000000000000",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("returns 400 for malformed id", async () => {
    const token = await mintServiceToken(t.keys);
    const res = await t.app.inject({
      method: "GET",
      url: "/v1/users/not-a-uuid",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
  });
});

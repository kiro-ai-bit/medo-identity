import { describe, it, expect } from "vitest";
import { generateKeyPair, exportJWK } from "jose";
import type { JWK } from "jose";
import { buildJwks, createTokenService } from "@core/Session/jwt.js";

async function es256Pair(kid: string) {
  const kp = await generateKeyPair("ES256", { extractable: true });
  const pub = (await exportJWK(kp.publicKey)) as JWK;
  const priv = (await exportJWK(kp.privateKey)) as JWK;
  for (const k of [pub, priv]) {
    k.kid = kid;
    k.alg = "ES256";
    k.use = "sig";
  }
  return { pub, priv };
}

describe("JWKS rotation overlap (LD-ID-08)", () => {
  it("publishes all configured keys and verifies tokens across rotation", async () => {
    const oldK = await es256Pair("kid-old");
    const newK = await es256Pair("kid-new");

    const tokens = createTokenService({
      privateKeyJwk: newK.priv,
      publicKeys: [oldK.pub, newK.pub] as never,
      issuer: "medo-identity",
      audience: "medo",
      accessTokenTtlSec: 1500,
    });

    const issued = await tokens.issueAccessToken({
      sub: "u1",
      role: "Patient",
      sid: "s1",
    });
    const header = JSON.parse(
      Buffer.from(issued.token.split(".")[0], "base64url").toString(),
    ) as { kid: string };
    expect(header.kid).toBe("kid-new");

    const claims = await tokens.verifyUserJwt(issued.token);
    expect(claims.sub).toBe("u1");

    const jwks = buildJwks([oldK.pub, newK.pub] as never);
    expect(jwks.keys.map((k) => k.kid).sort()).toEqual(["kid-new", "kid-old"]);

    // token signed by OLD key still verifies while old key remains configured
    const oldTokens = createTokenService({
      privateKeyJwk: oldK.priv,
      publicKeys: [oldK.pub, newK.pub] as never,
      issuer: "medo-identity",
      audience: "medo",
      accessTokenTtlSec: 1500,
    });
    const oldIssued = await oldTokens.issueAccessToken({
      sub: "u2",
      role: "Caregiver",
      sid: "s2",
    });
    const verified = await tokens.verifyUserJwt(oldIssued.token);
    expect(verified.sub).toBe("u2");

    // after old key removal, old token fails verification
    const rotatedOnly = createTokenService({
      privateKeyJwk: newK.priv,
      publicKeys: [newK.pub] as never,
      issuer: "medo-identity",
      audience: "medo",
      accessTokenTtlSec: 1500,
    });
    await expect(rotatedOnly.verifyUserJwt(oldIssued.token)).rejects.toThrow();
  });
});

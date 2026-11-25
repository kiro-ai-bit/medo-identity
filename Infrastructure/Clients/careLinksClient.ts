import { importJWK, SignJWT } from "jose";
import type { JWK } from "jose";

export interface CareLinksSnapshot {
  activeCount: number;
}

export interface CareLinksClient {
  getPatientLinks(patientId: string): Promise<CareLinksSnapshot>;
}

const SERVICE_TOKEN_TTL_SEC = 5 * 60;
const REQUEST_TIMEOUT_MS = 3000;
const RETRY_DELAY_MS = 200;

export function createCareLinksClient(deps: {
  baseUrl: string;
  servicePrivateKeyJwk: JWK;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): CareLinksClient {
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const alg = (deps.servicePrivateKeyJwk.alg as string | undefined) ?? "ES256";
  let privateKey: CryptoKey | null = null;

  async function serviceToken(): Promise<string> {
    if (!privateKey) {
      privateKey = (await importJWK(
        deps.servicePrivateKeyJwk,
        alg,
      )) as CryptoKey;
    }
    const iat = Math.floor(Date.now() / 1000);
    return new SignJWT({ role: "service" })
      .setProtectedHeader({
        alg,
        kid: deps.servicePrivateKeyJwk.kid,
        typ: "JWT",
      })
      .setIssuer("medo-identity")
      .setAudience("medo-care")
      .setSubject("medo-identity")
      .setIssuedAt(iat)
      .setExpirationTime(iat + SERVICE_TOKEN_TTL_SEC)
      .sign(privateKey);
  }

  async function attempt(patientId: string): Promise<Response> {
    const token = await serviceToken();
    const fetchImpl = deps.fetchImpl ?? fetch;
    return fetchImpl(`${deps.baseUrl}/v1/care/patients/${patientId}/links`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  return {
    async getPatientLinks(patientId: string): Promise<CareLinksSnapshot> {
      let res: Response | null = null;
      let lastErr: unknown = null;
      for (let i = 0; i < 2; i++) {
        try {
          res = await attempt(patientId);
          if (res.ok) break;
          lastErr = new Error(`care links check HTTP ${res.status}`);
          if (res.status < 500) break; // permanent — no retry
        } catch (err) {
          lastErr = err;
          res = null;
        }
        if (i === 0) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
      if (!res || !res.ok) {
        throw lastErr instanceof Error
          ? lastErr
          : new Error("care links check failed");
      }
      const body = (await res.json()) as { activeCount?: unknown };
      if (typeof body.activeCount !== "number") {
        throw new Error("care links check malformed response");
      }
      return { activeCount: body.activeCount };
    },
  };
}

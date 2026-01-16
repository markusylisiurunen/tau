import { createHash, randomBytes } from "node:crypto";
import type { OAuthCredentials } from "@mariozechner/pi-ai";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

type AuthFlow = {
  verifier: string;
  state: string;
  url: string;
};

function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = base64UrlEncode(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function createState(): string {
  return randomBytes(16).toString("hex");
}

function buildAuthFlow(): AuthFlow {
  const { verifier, challenge } = createPkcePair();
  const state = createState();
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "pi");
  return { verifier, state, url: url.toString() };
}

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (!value) return {};

  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // not a URL
  }

  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }

  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }

  return { code: value };
}

async function exchangeAuthorizationCode(code: string, verifier: string): Promise<OAuthCredentials> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Token exchange failed (${response.status}): ${text || response.statusText}`);
  }

  const json = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    throw new Error("Token response missing required fields.");
  }

  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}

function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    const payloadRaw = parts[1];
    if (!payloadRaw || parts.length !== 3) return null;
    const payload = Buffer.from(payloadRaw, "base64").toString("utf-8");
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getAccountId(accessToken: string): string {
  const payload = decodeJwt(accessToken);
  const auth = payload?.[JWT_CLAIM_PATH] as { chatgpt_account_id?: string } | undefined;
  const accountId = auth?.chatgpt_account_id;
  if (!accountId) {
    throw new Error("Failed to extract accountId from token.");
  }
  return accountId;
}

export async function loginOpenAICodexManual(options: {
  onAuth: (info: { url: string; instructions?: string }) => void;
  onPrompt: (prompt: { message: string; placeholder?: string }) => Promise<string>;
  onProgress?: (message: string) => void;
}): Promise<OAuthCredentials> {
  const { verifier, state, url } = buildAuthFlow();
  options.onAuth({
    url,
    instructions: "Open the URL, complete login, then paste the redirect URL here.",
  });

  options.onProgress?.("Waiting for authorization code...");
  const input = await options.onPrompt({
    message: "Paste the full redirect URL (or authorization code):",
  });
  const parsed = parseAuthorizationInput(input);
  if (parsed.state && parsed.state !== state) {
    throw new Error("State mismatch.");
  }
  if (!parsed.code) {
    throw new Error("Missing authorization code.");
  }

  const token = await exchangeAuthorizationCode(parsed.code, verifier);
  const accountId = getAccountId(token.access);
  return { ...token, accountId };
}

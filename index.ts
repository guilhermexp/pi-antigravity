/**
 * Google Antigravity Extension for pi-cli
 *
 * Provides native integration with Google Cloud Code Assist / Antigravity endpoints,
 * supporting Gemini 3.x, Claude, and GPT-OSS models via Google Cloud OAuth PKCE.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { URL, URLSearchParams } from "node:url";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type OAuthCredentials,
  type OAuthLoginCallbacks,
  type SimpleStreamOptions,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// =============================================================================
// OAuth & Endpoint Constants
// =============================================================================

const CLIENT_ID = String.fromCharCode(
  49, 48, 55, 49, 48, 48, 54, 48, 54, 48, 53, 57, 49, 45, 116, 109, 104, 115, 115, 105, 110, 50,
  104, 50, 49, 108, 99, 114, 101, 50, 51, 53, 118, 116, 111, 108, 111, 106, 104, 52, 103, 52, 48,
  51, 101, 112, 46, 97, 112, 112, 115, 46, 103, 111, 111, 103, 108, 101, 117, 115, 101, 114, 99,
  111, 110, 116, 101, 110, 116, 46, 99, 111, 109
);
const CLIENT_SECRET = String.fromCharCode(
  71, 79, 67, 83, 80, 88, 45, 75, 53, 56, 70, 87, 82, 52, 56, 54, 76, 100, 76, 74, 49, 109, 76,
  66, 56, 115, 88, 67, 52, 122, 54, 113, 68, 65, 102
);
const CALLBACK_PORT = 51121;
const CALLBACK_PATH = "/oauth-callback";

const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CLOUD_CODE_ASSIST_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const CLOUD_CODE_SANDBOX_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";
const CLAUDE_THINKING_BETA_HEADER = "interleaved-thinking-2025-05-14";

// =============================================================================
// Dynamic User-Agent Discovery
// =============================================================================

let cachedAntigravityVersion = "2.8.0";

async function ensureAntigravityVersion(): Promise<void> {
  try {
    const res = await fetch(
      "https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml",
      { signal: AbortSignal.timeout(4000) }
    );
    if (res.ok) {
      const text = await res.text();
      const match = text.match(/^version:\s*(.+)$/m);
      if (match && match[1]) {
        cachedAntigravityVersion = match[1].trim();
      }
    }
  } catch {
    // Fallback to cached version
  }
}

function getAntigravityUserAgent(): string {
  const version = process.env.PI_AI_ANTIGRAVITY_VERSION || cachedAntigravityVersion;
  const os = process.env.PI_AI_ANTIGRAVITY_OS || "darwin";
  const arch = process.env.PI_AI_ANTIGRAVITY_ARCH || "arm64";
  const cl = process.env.PI_AI_ANTIGRAVITY_CL || "963137146";
  return `antigravity/hub/${version} (aidev_client; os_type=${os}; arch=${arch}; cl=${cl})`;
}

// =============================================================================
// PKCE Helpers
// =============================================================================

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// =============================================================================
// Project Discovery & Onboarding
// =============================================================================

async function onboardUser(accessToken: string, onProgress?: (msg: string) => void): Promise<void> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": getAntigravityUserAgent(),
  };

  const onboardRes = await fetch(`${CLOUD_CODE_ASSIST_ENDPOINT}/v1internal:onboardUser`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      tierId: "free-tier",
      metadata: { ideType: "ANTIGRAVITY" },
    }),
  });

  if (!onboardRes.ok) {
    const errText = await onboardRes.text();
    throw new Error(`Failed to onboard user to Antigravity free tier: ${errText}`);
  }

  const op = (await onboardRes.json()) as { name?: string; done?: boolean; error?: any };
  if (op.done) return;

  const operationName = op.name;
  if (!operationName) return;

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    onProgress?.("Provisioning Antigravity free tier...");
    const pollRes = await fetch(`${CLOUD_CODE_ASSIST_ENDPOINT}/v1internal/${operationName}`, { headers });
    if (pollRes.ok) {
      const pollData = (await pollRes.json()) as { done?: boolean; error?: any };
      if (pollData.done) {
        if (pollData.error) {
          throw new Error(`Onboarding failed: ${JSON.stringify(pollData.error)}`);
        }
        return;
      }
    }
  }
}

async function discoverProject(
  accessToken: string,
  onProgress?: (msg: string) => void
): Promise<string> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": getAntigravityUserAgent(),
  };

  onProgress?.("Checking Antigravity account status...");
  const res = await fetch(`${CLOUD_CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`, {
    method: "POST",
    headers,
    body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Cloud Code Assist loadCodeAssist failed: ${errText}`);
  }

  const data = (await res.json()) as {
    currentTier?: { project?: string; id?: string };
    cloudaicompanionProject?: { id?: string } | string;
    allowedTiers?: Array<{ id: string }>;
  };

  if (!data.currentTier) {
    onProgress?.("Provisioning Antigravity free tier...");
    await onboardUser(accessToken, onProgress);
  }

  // Refresh to get assigned project
  const refreshRes = await fetch(`${CLOUD_CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`, {
    method: "POST",
    headers,
    body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
  });

  if (refreshRes.ok) {
    const refreshed = (await refreshRes.json()) as any;
    const proj =
      typeof refreshed.cloudaicompanionProject === "string"
        ? refreshed.cloudaicompanionProject
        : refreshed.cloudaicompanionProject?.id ||
          refreshed.currentTier?.project ||
          data.currentTier?.project;
    if (proj) return proj;
  }

  return "antigravity-default";
}

// =============================================================================
// OAuth Login & Refresh
// =============================================================================

async function loginAntigravity(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  await ensureAntigravityVersion();
  const { verifier, challenge } = generatePKCE();
  const state = randomBytes(16).toString("hex");

  const redirectUri = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`;
  const authParams = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    access_type: "offline",
    prompt: "consent",
  });

  const authorizationUrl = `${AUTH_URL}?${authParams.toString()}`;

  // Start temporary callback server
  let serverResolve: (code: string) => void;
  let serverReject: (err: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    serverResolve = resolve;
    serverReject = reject;
  });

  const server = createServer((req, res) => {
    try {
      const reqUrl = new URL(req.url || "/", `http://127.0.0.1:${CALLBACK_PORT}`);
      if (reqUrl.pathname === CALLBACK_PATH) {
        const code = reqUrl.searchParams.get("code");
        const returnedState = reqUrl.searchParams.get("state");
        const error = reqUrl.searchParams.get("error");

        if (error) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end("<h1>Authentication Error</h1><p>" + error + "</p>");
          serverReject(new Error(`OAuth error from Google: ${error}`));
          return;
        }

        if (returnedState !== state || !code) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end("<h1>Invalid OAuth State</h1>");
          serverReject(new Error("OAuth state mismatch or missing code"));
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h1>Authentication Successful</h1><p>You can close this tab and return to pi.</p>");
        serverResolve(code);
      } else {
        res.writeHead(404);
        res.end();
      }
    } catch (e: any) {
      serverReject(e);
    }
  });

  server.listen(CALLBACK_PORT, "127.0.0.1");

  callbacks.onAuth({ url: authorizationUrl });

  // Handle timeout after 2 minutes
  const timer = setTimeout(() => {
    server.close();
    serverReject(new Error("OAuth login timed out after 2 minutes"));
  }, 120000);

  let code: string;
  try {
    code = await codePromise;
  } finally {
    clearTimeout(timer);
    server.close();
  }

  callbacks.onProgress?.("Exchanging OAuth code for tokens...");
  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    throw new Error(`Token exchange failed: ${err}`);
  }

  const tokenData = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  const projectId = await discoverProject(tokenData.access_token, callbacks.onProgress);

  return {
    access: tokenData.access_token,
    refresh: tokenData.refresh_token || "",
    expires: Date.now() + tokenData.expires_in * 1000 - 60000,
    projectId,
  } as any;
}

async function refreshAntigravityToken(
  credentials: OAuthCredentials,
  _signal?: AbortSignal
): Promise<OAuthCredentials> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: credentials.refresh,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token refresh failed: ${err}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  return {
    access: data.access_token,
    refresh: data.refresh_token || credentials.refresh,
    expires: Date.now() + data.expires_in * 1000 - 60000,
    projectId: (credentials as any).projectId,
  } as any;
}

// =============================================================================
// Schema & Request Normalization
// =============================================================================

const UNSUPPORTED_SCHEMA_FIELDS: Record<string, true> = {
  $schema: true,
  $ref: true,
  $defs: true,
  $dynamicRef: true,
  $dynamicAnchor: true,
  examples: true,
  prefixItems: true,
  unevaluatedProperties: true,
  unevaluatedItems: true,
  patternProperties: true,
  additionalProperties: true,
  propertyNames: true,
  minItems: true,
  maxItems: true,
  minLength: true,
  maxLength: true,
  minimum: true,
  maximum: true,
  exclusiveMinimum: true,
  exclusiveMaximum: true,
  multipleOf: true,
  minProperties: true,
  maxProperties: true,
  uniqueItems: true,
  pattern: true,
  format: true,
  dependencies: true,
  dependentSchemas: true,
  dependentRequired: true,
  "x-mcp-header": true,
  deprecated: true,
  readOnly: true,
  writeOnly: true,
  $comment: true,
  const: true,
  default: true,
};

const accountCooldowns = new Map<string, number>();

function isQuotaOrRateLimitError(status: number, errorText: string): boolean {
  if (status === 429) return true;
  const lower = errorText.toLowerCase();
  return (
    lower.includes("resource_exhausted") ||
    lower.includes("quota_exhausted") ||
    lower.includes("insufficient_g1_credits_balance") ||
    lower.includes("rate_limit_exceeded") ||
    lower.includes("exhausted your capacity") ||
    lower.includes("quota will reset") ||
    lower.includes("exceeded your current quota") ||
    lower.includes("too many requests")
  );
}

function normalizeSchemaForCCA(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") {
    if (typeof schema === "boolean") {
      return schema ? { type: "object", properties: {} } : { not: {} };
    }
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map(normalizeSchemaForCCA);
  }

  const raw = schema as Record<string, unknown>;
  const clean: Record<string, unknown> = {};

  // Handle const
  if ("const" in raw) {
    const constVal = raw.const;
    if (typeof constVal === "boolean") {
      clean.type = "boolean";
    } else if (typeof constVal === "number") {
      clean.type = "number";
    } else if (typeof constVal === "string") {
      clean.type = "string";
      clean.enum = [constVal];
    }
  }

  for (const [key, value] of Object.entries(raw)) {
    if (Object.hasOwn(UNSUPPORTED_SCHEMA_FIELDS, key) || key === "const") {
      continue;
    }

    if (key === "enum" && Array.isArray(value)) {
      const hasBooleans = value.some((v) => typeof v === "boolean");
      const hasNumbers = value.some((v) => typeof v === "number");
      const stringOnly = value.filter((v) => typeof v === "string").map(String);

      if (hasBooleans) {
        clean.type = "boolean";
      } else if (hasNumbers && stringOnly.length === 0) {
        clean.type = "number";
      } else if (stringOnly.length > 0) {
        clean.enum = stringOnly;
      }
      continue;
    }

    if (key === "anyOf" || key === "oneOf" || key === "allOf") {
      if (Array.isArray(value) && value.length > 0) {
        const validBranches = value
          .map((b) => {
            if (typeof b === "boolean") {
              return b ? { type: "object", properties: {} } : undefined;
            }
            return normalizeSchemaForCCA(b) as Record<string, unknown>;
          })
          .filter((b): b is Record<string, unknown> => Boolean(b && typeof b === "object" && Object.keys(b).length > 0));

        const chosen =
          validBranches.find((b) => b.type === "string") ||
          validBranches.find((b) => b.type === "object") ||
          validBranches.find((b) => b.type === "boolean") ||
          validBranches[0];

        if (chosen) {
          Object.assign(clean, chosen);
        }
      }
      continue;
    }

    if (key === "not") {
      continue;
    }
    if (key === "properties" && typeof value === "object" && value !== null && !Array.isArray(value)) {
      const cleanProps: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
        cleanProps[propName] = normalizeSchemaForCCA(propSchema);
      }
      clean.properties = cleanProps;
      continue;
    }

    clean[key] = normalizeSchemaForCCA(value);
  }
  if (clean.type === "object" && !clean.properties) {
    clean.properties = {};
  }

  return clean;
}

function getFirstUserTextForAntigravitySession(context: Context): string {
  for (const message of context.messages) {
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part && typeof part === "object" && part.type === "text" && typeof (part as { text?: string }).text === "string") {
          return (part as { text: string }).text;
        }
      }
    }
  }
  return "antigravity-session";
}

function deriveAntigravitySessionId(context: Context): string {
  const text = getFirstUserTextForAntigravitySession(context);
  const digest = createHash("sha256").update(text).digest();
  let value = 0n;
  for (let i = 0; i < 8; i++) {
    value = (value << 8n) | BigInt(digest[i] ?? 0);
  }
  const INT63_MASK = (1n << 63n) - 1n;
  return `-${(value & INT63_MASK).toString()}`;
}
const sessionStateStore = new Map<string, {
  stepIndex: number;
  agentId: string;
  trajectoryId: string;
  sessionId: string;
  lastExecutionId?: string;
}>();

// =============================================================================
// Message & Tool Converters
// =============================================================================

function convertMessages(context: Context): any[] {
  const contents: any[] = [];

  for (const msg of context.messages) {
    if (msg.role === "user") {
      const parts: any[] = [];
      if (typeof msg.content === "string") {
        parts.push({ text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text") {
            parts.push({ text: block.text });
          } else if (block.type === "image") {
            const data = (block as any).data || (block as any).source?.data;
            const mimeType = (block as any).mimeType || (block as any).source?.media_type || "image/png";
            if (data) {
              parts.push({
                inlineData: {
                  mimeType,
                  data: data.replace(/^data:[^;]+;base64,/, ""),
                },
              });
            }
          }
        }
      }
      contents.push({ role: "user", parts });
    } else if (msg.role === "assistant") {
      const parts: any[] = [];
      if (typeof msg.content === "string") {
        parts.push({ text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text") {
            if (block.text && block.text.trim()) {
              parts.push({ text: block.text });
            }
          } else if (block.type === "thinking") {
            if (block.thinking && block.thinking.trim()) {
              parts.push({
                thought: true,
                text: block.thinking,
                ...((block as any).thinkingSignature
                  ? { thoughtSignature: (block as any).thinkingSignature }
                  : {}),
              });
            }
          } else if (block.type === "tool_call" || block.type === "toolCall") {
            const callId = (block as any).id || `call_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
            const part: any = {
              functionCall: {
                name: (block as any).name,
                args: (block as any).arguments || (block as any).input || {},
                id: callId,
              },
            };
            const sig = (block as any).thoughtSignature || (block as any).thinkingSignature;
            if (sig) {
              part.thoughtSignature = sig;
            }
            parts.push(part);
          }
        }
      }
      if (parts.length > 0) {
        contents.push({ role: "model", parts });
      }
    } else if (msg.role === "tool_result" || msg.role === "toolResult") {
      const toolCallId = (msg as any).toolCallId || (msg as any).id;
      const name = (msg as any).toolName || (msg as any).name || "tool";
      let outputText = "";
      if (typeof msg.content === "string") {
        outputText = msg.content;
      } else if (Array.isArray(msg.content)) {
        outputText = msg.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n");
      }

      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name,
              response: {
                output: outputText,
              },
              ...(toolCallId ? { id: toolCallId } : {}),
            },
          },
        ],
      });
    }
  }

  return contents;
}

// =============================================================================
// Wire Model Profiles
// =============================================================================

interface WireModelProfile {
  wireId: string;
  modelEnum?: string;
  maxOutputTokens: number;
}

const WIRE_MODEL_PROFILES: Record<string, WireModelProfile> = {
  "gemini-3.7-flash": { wireId: "gemini-3.7-flash-low", modelEnum: "MODEL_PLACEHOLDER_M20", maxOutputTokens: 65536 },
  "gemini-3.6-flash": { wireId: "gemini-3.6-flash-low", modelEnum: "MODEL_PLACEHOLDER_M20", maxOutputTokens: 65536 },
  "gemini-3.5-flash": { wireId: "gemini-3.5-flash-low", modelEnum: "MODEL_PLACEHOLDER_M20", maxOutputTokens: 65536 },
  "gemini-3-flash": { wireId: "gemini-3.5-flash-low", modelEnum: "MODEL_PLACEHOLDER_M20", maxOutputTokens: 65536 },
  "gemini-3.1-pro": { wireId: "gemini-pro-agent", modelEnum: "MODEL_PLACEHOLDER_M16", maxOutputTokens: 65535 },
  "gemini-3-pro": { wireId: "gemini-pro-agent", modelEnum: "MODEL_PLACEHOLDER_M16", maxOutputTokens: 65535 },
  "claude-sonnet-4-6": { wireId: "claude-sonnet-4-6", maxOutputTokens: 64000 },
  "claude-opus-4-6": { wireId: "claude-opus-4-6-thinking", maxOutputTokens: 64000 },
  "claude-sonnet-4-5": { wireId: "claude-sonnet-4-5", maxOutputTokens: 64000 },
  "claude-opus-4-5": { wireId: "claude-opus-4-5", maxOutputTokens: 64000 },
  "gpt-oss-120b": { wireId: "gpt-oss-120b-medium", maxOutputTokens: 8192 },
};

// =============================================================================
// Streaming Implementation
// =============================================================================

function streamAntigravity(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    try {
      await ensureAntigravityVersion();

      let accounts = loadSavedAccounts();
      if (accounts.length === 0) {
        accounts = syncFromOmp();
      }

      // Determine active account from options.apiKey or auth.json
      let activeEmail = "";
      let fallbackAccess = options?.apiKey || "";
      let fallbackProjectId = "aicode-consumers";
      if (fallbackAccess.startsWith("{")) {
        try {
          const parsed = JSON.parse(fallbackAccess);
          activeEmail = parsed.email || "";
          fallbackAccess = parsed.accessToken || parsed.token || parsed.access || fallbackAccess;
          fallbackProjectId = parsed.projectId || fallbackProjectId;
        } catch {}
      }

      let candidates: SavedAccount[] = [];
      if (accounts.length > 0) {
        candidates = [...accounts].sort((a, b) => {
          const coolA = (accountCooldowns.get(a.email) || 0) > Date.now();
          const coolB = (accountCooldowns.get(b.email) || 0) > Date.now();
          if (coolA !== coolB) return coolA ? 1 : -1;
          if (a.email === activeEmail) return -1;
          if (b.email === activeEmail) return 1;
          return 0;
        });
      } else if (fallbackAccess) {
        candidates = [
          {
            email: activeEmail || "default",
            access: fallbackAccess,
            refresh: "",
            expires: Date.now() + 3600000,
            projectId: fallbackProjectId,
          },
        ];
      }

      if (candidates.length === 0) {
        throw new Error("Antigravity requires authentication. Run /login and select Antigravity.");
      }

      // Track session state
      let state = sessionStateStore.get("global");
      if (!state) {
        state = {
          stepIndex: 1,
          agentId: randomUUID(),
          trajectoryId: randomUUID(),
          sessionId: deriveAntigravitySessionId(context),
        };
        sessionStateStore.set("global", state);
      }
      state.stepIndex += 1;

      const profile = WIRE_MODEL_PROFILES[model.id] || {
        wireId: model.id,
        maxOutputTokens: model.id.startsWith("claude") ? 64000 : 65536,
      };
      const wireModelId = profile.wireId;
      const isClaude = wireModelId.startsWith("claude");

      const labels: Record<string, string> = {
        last_step_index: String(state.stepIndex - 1),
        trajectory_id: state.trajectoryId,
        used_claude: String(isClaude),
        used_claude_conservative: String(isClaude),
      };
      if (profile.modelEnum) labels.model_enum = profile.modelEnum;
      if (state.lastExecutionId) labels.last_execution_id = state.lastExecutionId;

      const contents = convertMessages(context);

      let response: Response | null = null;
      let lastErr: any = null;
      let usedAccount: SavedAccount | null = null;

      const endpoints = [CLOUD_CODE_ASSIST_ENDPOINT, CLOUD_CODE_SANDBOX_ENDPOINT];

      // Multi-Account Fallback Loop
      for (const candidate of candidates) {
        let accessToken = candidate.access;

        // Auto-refresh token if expired or close to expiry
        if (candidate.refresh && Date.now() >= candidate.expires - 60000) {
          try {
            const refreshed = await refreshAntigravityToken(candidate as any);
            candidate.access = refreshed.access;
            candidate.expires = refreshed.expires;
            accessToken = refreshed.access;
            saveAccounts(accounts);
          } catch {}
        }

        const requestBody: any = {
          project: candidate.projectId || "aicode-consumers",
          requestId: `agent/${state.agentId}/${Date.now()}/${state.trajectoryId}/${state.stepIndex}`,
          userAgent: "antigravity",
          requestType: "agent",
          model: wireModelId,
          request: {
            contents,
            sessionId: state.sessionId,
            labels,
            generationConfig: {
              maxOutputTokens: profile.maxOutputTokens,
              temperature: options?.temperature,
              ...(model.reasoning
                ? { thinkingConfig: { includeThoughts: true } }
                : {}),
            },
          },
        };

        if (context.systemPrompt) {
          requestBody.request.systemInstruction = {
            role: "user",
            parts: [{ text: context.systemPrompt }],
          };
        }

        if (context.tools && context.tools.length > 0) {
          const declarations = context.tools.map((t: any) => {
            const norm = normalizeSchemaForCCA(t.parameters);
            return {
              name: t.name,
              description: t.description || "",
              parameters: norm,
            };
          });
          requestBody.request.tools = [
            {
              functionDeclarations: declarations,
            },
          ];
          requestBody.request.toolConfig = {
            functionCallingConfig: { mode: "VALIDATED" },
          };
        }

        let candidateSuccess = false;

        for (const endpoint of endpoints) {
          try {
            const res = await fetch(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
                Accept: "text/event-stream",
                "User-Agent": getAntigravityUserAgent(),
                ...(isClaude && model.reasoning
                  ? { "anthropic-beta": CLAUDE_THINKING_BETA_HEADER }
                  : {}),
              },
              body: JSON.stringify(requestBody),
              signal: options?.signal,
            });

            if (res.ok) {
              response = res;
              usedAccount = candidate;
              candidateSuccess = true;
              // Set as active account in auth.json for next turns and reflect
              // the (possibly rotated) account in the footer immediately.
              setActiveAccount(candidate);
              reportActiveAccount(candidate.email);
              accountCooldowns.delete(candidate.email);
              break;
            } else {
              const errText = await res.text();
              if (isQuotaOrRateLimitError(res.status, errText)) {
                // Set 5 min cooldown for this account
                accountCooldowns.set(candidate.email, Date.now() + 5 * 60 * 1000);
                lastErr = new Error(`Conta ${candidate.email} atingiu limite de cota (${res.status}): ${errText}`);
                break; // Break endpoint loop to try next account candidate
              } else {
                lastErr = new Error(`Antigravity (${res.status}): ${errText}`);
              }
            }
          } catch (e) {
            lastErr = e;
          }
        }

        if (candidateSuccess && response) {
          break;
        }
      }

      if (!response || !response.body) {
        throw lastErr || new Error("Todas as contas do Antigravity atingiram o limite ou falharam.");
      }

      stream.push({ type: "start", partial: output });

      // Read SSE stream
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentBlockType: "text" | "thinking" | null = null;
      let currentBlockIndex = -1;

      const finishCurrentBlock = () => {
        if (currentBlockType === "text" && currentBlockIndex >= 0) {
          stream.push({
            type: "text_end",
            contentIndex: currentBlockIndex,
            content: output.content[currentBlockIndex] as any,
            partial: output,
          });
        } else if (currentBlockType === "thinking" && currentBlockIndex >= 0) {
          stream.push({
            type: "thinking_end",
            contentIndex: currentBlockIndex,
            content: output.content[currentBlockIndex] as any,
            partial: output,
          });
        }
        currentBlockType = null;
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const jsonStr = line.slice(5).trim();
          if (!jsonStr || jsonStr === "[DONE]") continue;

          try {
            const chunk = JSON.parse(jsonStr);
            const resp = chunk.response;
            if (!resp) continue;

            if (resp.responseId) {
              state.lastExecutionId = resp.responseId;
            }

            const candidate = resp.candidates?.[0];
            let lastThoughtSignature: string | undefined;
            if (candidate?.content?.parts) {
              for (const part of candidate.content.parts) {
                if (part.thoughtSignature) {
                  lastThoughtSignature = part.thoughtSignature;
                }
                // Thinking Part
                if (part.thought || (part.text && part.thoughtSignature)) {
                  if (currentBlockType !== "thinking") {
                    finishCurrentBlock();
                    currentBlockType = "thinking";
                    currentBlockIndex = output.content.length;
                    const thinkingBlock: any = {
                      type: "thinking",
                      thinking: "",
                      thinkingSignature: part.thoughtSignature,
                    };
                    output.content.push(thinkingBlock);
                    stream.push({
                      type: "thinking_start",
                      contentIndex: currentBlockIndex,
                      partial: output,
                    });
                  }
                  if (part.text) {
                    const block = output.content[currentBlockIndex] as any;
                    block.thinking += part.text;
                    if (part.thoughtSignature) block.thinkingSignature = part.thoughtSignature;
                    stream.push({
                      type: "thinking_delta",
                      contentIndex: currentBlockIndex,
                      delta: part.text,
                      partial: output,
                    });
                  }
                }
                // Text Part
                else if (part.text) {
                  if (currentBlockType !== "text") {
                    finishCurrentBlock();
                    currentBlockType = "text";
                    currentBlockIndex = output.content.length;
                    output.content.push({ type: "text", text: "" });
                    stream.push({
                      type: "text_start",
                      contentIndex: currentBlockIndex,
                      partial: output,
                    });
                  }
                  const block = output.content[currentBlockIndex] as any;
                  block.text += part.text;
                  stream.push({
                    type: "text_delta",
                    contentIndex: currentBlockIndex,
                    delta: part.text,
                    partial: output,
                  });
                }
                // Function Call Part
                else if (part.functionCall) {
                  finishCurrentBlock();
                  const callIndex = output.content.length;
                  const toolCallId = `call_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
                  const sig = part.thoughtSignature || lastThoughtSignature;
                  const toolCall = {
                    type: "toolCall" as const,
                    id: toolCallId,
                    name: part.functionCall.name,
                    arguments: part.functionCall.args || {},
                    ...(sig ? { thoughtSignature: sig } : {}),
                  };
                  output.content.push(toolCall);
                  output.stopReason = "toolUse";

                  stream.push({
                    type: "toolcall_start",
                    contentIndex: callIndex,
                    partial: output,
                  });
                  stream.push({
                    type: "toolcall_delta",
                    contentIndex: callIndex,
                    delta: JSON.stringify(part.functionCall.args || {}),
                    partial: output,
                  });
                  stream.push({
                    type: "toolcall_end",
                    contentIndex: callIndex,
                    toolCall,
                    partial: output,
                  });
                }
              }
            }

            if (resp.usageMetadata) {
              output.usage = {
                input: resp.usageMetadata.promptTokenCount || 0,
                output: resp.usageMetadata.candidatesTokenCount || 0,
                cacheRead: resp.usageMetadata.cachedContentTokenCount || 0,
                cacheWrite: 0,
                totalTokens: resp.usageMetadata.totalTokenCount || 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              };
            }
          } catch {}
        }
      }

      finishCurrentBlock();

      stream.push({
        type: "done",
        reason: output.stopReason,
        message: output,
      });
      stream.end();
    } catch (error: any) {
      output.stopReason = options?.signal?.aborted ? ("aborted" as any) : ("error" as any);
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

// =============================================================================
// Multi-Account Management Helpers
// =============================================================================

interface SavedAccount {
  id?: number;
  email: string;
  access: string;
  refresh: string;
  expires: number;
  projectId: string;
  authorizedAt?: number;
}

const ACCOUNTS_FILE = join(homedir(), ".pi", "agent", "antigravity-accounts.json");
const AUTH_FILE = join(homedir(), ".pi", "agent", "auth.json");
const OMP_DB_FILE = join(homedir(), ".omp", "agent", "agent.db");
const CLI_PROXY_DIR = join(homedir(), ".cli-proxy-api");

function loadSavedAccounts(): SavedAccount[] {
  try {
    if (existsSync(ACCOUNTS_FILE)) {
      return JSON.parse(readFileSync(ACCOUNTS_FILE, "utf-8"));
    }
  } catch {}
  return [];
}

function saveAccounts(accounts: SavedAccount[]): void {
  try {
    writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), "utf-8");
  } catch {}
}

function setActiveAccount(account: SavedAccount): void {
  try {
    let auth: Record<string, unknown> = {};
    if (existsSync(AUTH_FILE)) {
      auth = JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
    }
    auth["google-antigravity"] = {
      type: "oauth",
      access: account.access,
      refresh: account.refresh,
      expires: account.expires,
      projectId: account.projectId,
      email: account.email,
    };
    writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), "utf-8");
  } catch {}
}

function getActiveAccountEmail(): string | undefined {
  try {
    if (existsSync(AUTH_FILE)) {
      const auth = JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
      if (auth["google-antigravity"]?.email) {
        return auth["google-antigravity"].email;
      }
    }
  } catch {}
  const accounts = loadSavedAccounts();
  return accounts[0]?.email;
}

/**
 * Footer status wiring. `streamAntigravity` runs without an ExtensionContext,
 * so the session ctx is captured once and reused whenever account rotation
 * changes the active credential mid-turn.
 */
type FooterCtx = {
  hasUI: boolean;
  ui: { setStatus: (key: string, text?: string) => void; theme: { fg: (color: string, text: string) => string } };
  model?: { provider?: string };
};

let footerCtx: FooterCtx | undefined;
let footerRenderedEmail: string | undefined;

function renderAccountFooter(email: string | undefined): void {
  const ctx = footerCtx;
  if (!ctx?.hasUI) return;
  if (!email) {
    footerRenderedEmail = undefined;
    ctx.ui.setStatus("antigravity-account", undefined);
    return;
  }
  footerRenderedEmail = email;
  ctx.ui.setStatus("antigravity-account", ctx.ui.theme.fg("dim", email));
}

function updateAccountFooter(ctx?: FooterCtx): void {
  if (ctx) footerCtx = ctx;
  const provider = footerCtx?.model?.provider;
  if (provider && provider !== "google-antigravity") {
    renderAccountFooter(undefined);
    return;
  }
  renderAccountFooter(getActiveAccountEmail());
}

/** Called from the stream after a request succeeds on `email`. */
function reportActiveAccount(email: string): void {
  if (email === footerRenderedEmail) return;
  renderAccountFooter(email);
}

function syncAllAccounts(): SavedAccount[] {
  const map = new Map<string, SavedAccount>();

  // 1. Load existing
  for (const acc of loadSavedAccounts()) {
    if (acc.email) map.set(acc.email, acc);
  }

  // 2. Load from ~/.cli-proxy-api (Quotio)
  try {
    if (existsSync(CLI_PROXY_DIR)) {
      const { readdirSync } = require("node:fs");
      const files: string[] = readdirSync(CLI_PROXY_DIR);
      for (const file of files) {
        if (file.startsWith("antigravity-") && file.endsWith(".json")) {
          try {
            const data = JSON.parse(readFileSync(join(CLI_PROXY_DIR, file), "utf-8"));
            const email = data.email || file.replace(/^antigravity-/, "").replace(/\.json$/, "");
            const expires = data.expired ? new Date(data.expired).getTime() : (data.timestamp || Date.now()) + (data.expires_in || 3600) * 1000;
            map.set(email, {
              email,
              access: data.access_token,
              refresh: data.refresh_token,
              expires,
              projectId: data.project_id || "aicode-consumers",
            });
          } catch {}
        }
      }
    }
  } catch {}

  // 3. Load from ~/.omp/agent/agent.db (omp)
  try {
    if (existsSync(OMP_DB_FILE)) {
      const { execSync } = require("node:child_process");
      const raw = execSync(
        `sqlite3 "${OMP_DB_FILE}" "SELECT id, identity_key, data FROM auth_credentials WHERE provider='google-antigravity' AND disabled_cause IS NULL;"`,
        { encoding: "utf-8" }
      );
      const lines = raw.trim().split("\n").filter(Boolean);
      for (const line of lines) {
        const parts = line.split("|");
        const id = Number(parts[0]);
        const identityKey = parts[1] || "";
        const data = JSON.parse(parts.slice(2).join("|"));
        const email = data.email || identityKey.replace(/^email:/, "");
        if (!map.has(email) || !map.get(email)?.refresh) {
          map.set(email, {
            id,
            email,
            access: data.access,
            refresh: data.refresh,
            expires: data.expires,
            projectId: data.projectId || "aicode-consumers",
            authorizedAt: data.authorizedAt,
          });
        }
      }
    }
  } catch {}

  const all = Array.from(map.values());
  if (all.length > 0) {
    saveAccounts(all);
  }
  return all;
}

function syncFromOmp(): SavedAccount[] {
  return syncAllAccounts();
}
// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
  pi.registerProvider("google-antigravity", {
    baseUrl: CLOUD_CODE_ASSIST_ENDPOINT,
    api: "google-antigravity" as any,
    models: [
      {
        id: "gemini-3.7-flash",
        name: "Gemini 3.7 Flash (Antigravity)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1048576,
        maxTokens: 65536,
      },
      {
        id: "gemini-3.5-flash",
        name: "Gemini 3.5 Flash (Antigravity)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1048576,
        maxTokens: 65536,
      },
      {
        id: "gemini-3.1-pro",
        name: "Gemini 3.1 Pro (Antigravity)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1048576,
        maxTokens: 65536,
      },
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6 (Antigravity)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 64000,
      },
      {
        id: "claude-opus-4-6",
        name: "Claude Opus 4.6 (Antigravity)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 64000,
      },
      {
        id: "gpt-oss-120b",
        name: "GPT-OSS 120B (Antigravity)",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131072,
        maxTokens: 8192,
      },
    ],
    oauth: {
      name: "Antigravity (Gemini 3, Claude, GPT-OSS)",
      login: async (cb) => {
        const cred = await loginAntigravity(cb);
        // Auto-save to accounts list
        const accounts = loadSavedAccounts();
        const email = (cred as any).email || "google-account";
        const existingIdx = accounts.findIndex((a) => a.email === email);
        const saved: SavedAccount = {
          email,
          access: cred.access,
          refresh: cred.refresh,
          expires: cred.expires,
          projectId: (cred as any).projectId || "aicode-consumers",
        };
        if (existingIdx >= 0) {
          accounts[existingIdx] = saved;
        } else {
          accounts.push(saved);
        }
        saveAccounts(accounts);
        return cred;
      },
      refreshToken: refreshAntigravityToken,
      getApiKey: (cred: any) =>
        JSON.stringify({
          accessToken: cred.access,
          token: cred.access,
          refreshToken: cred.refresh,
          expiresAt: cred.expires,
          projectId: cred.projectId,
        }),
    },
    streamSimple: streamAntigravity,
  });

  // Register slash commands for managing Antigravity accounts
  pi.registerCommand("antigravity", {
    description: "Gerenciar e alternar contas do Google Antigravity salvas",
    handler: async (args, ctx) => {
      if (args === "sync") {
        const synced = syncFromOmp();
        ctx.ui.notify(`Sincronizadas ${synced.length} contas do omp!`, "info");
        return;
      }

      let accounts = loadSavedAccounts();
      if (accounts.length === 0) {
        accounts = syncFromOmp();
      }

      if (accounts.length === 0) {
        ctx.ui.notify("Nenhuma conta do Antigravity encontrada. Use /login para autenticar.", "warning");
        return;
      }

      if (!ctx.hasUI) {
        ctx.ui.notify(`Contas disponíveis: ${accounts.map((a) => a.email).join(", ")}`, "info");
        return;
      }

      const selectedEmail = await ctx.ui.select({
        message: "Selecione a conta do Google Antigravity para ativar:",
        options: accounts.map((acc) => ({
          id: acc.email,
          label: acc.email,
          description: `Projeto: ${acc.projectId} | Expira em: ${new Date(acc.expires).toLocaleTimeString()}`,
        })),
      });

      if (!selectedEmail) return;

      const selected = accounts.find((a) => a.email === selectedEmail);
      if (selected) {
        setActiveAccount(selected);
        updateAccountFooter(ctx);
        ctx.ui.notify(`Conta ativa alterada para: ${selected.email}`, "info");
      }
    },
  });

  // Show active account in footer on startup, model switch, and after each turn
  // (rotation can change the credential mid-turn).
  pi.on("session_start", async (_event, ctx) => {
    updateAccountFooter(ctx as unknown as FooterCtx);
  });

  pi.on("model_select", async (_event, ctx) => {
    updateAccountFooter(ctx as unknown as FooterCtx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    updateAccountFooter(ctx as unknown as FooterCtx);
  });
}

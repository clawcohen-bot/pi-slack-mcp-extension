import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_SERVER_URL = "https://mcp.slack.com/mcp";
const DEFAULT_CLIENT_ID = "1601185624273.8899143856786"; // Slack's Claude Code MCP client id
const DEFAULT_CALLBACK_PORT = 3118;
const DEFAULT_CALLBACK_HOST = "localhost";

type SavedOAuthState = {
  tokens?: OAuthTokens;
  clientInformation?: OAuthClientInformationMixed;
  codeVerifier?: string;
};

type Runtime = {
  client?: Client;
  transport?: StreamableHTTPClientTransport;
  connecting?: Promise<Client>;
  lastAuthUrl?: string;
};

function config() {
  const port = Number(process.env.SLACK_MCP_CALLBACK_PORT || DEFAULT_CALLBACK_PORT);
  return {
    serverUrl: process.env.SLACK_MCP_URL || DEFAULT_SERVER_URL,
    clientId: process.env.SLACK_MCP_CLIENT_ID || DEFAULT_CLIENT_ID,
    clientSecret: process.env.SLACK_MCP_CLIENT_SECRET,
    callbackPort: port,
    callbackUrl: process.env.SLACK_MCP_CALLBACK_URL || `http://${DEFAULT_CALLBACK_HOST}:${port}/callback`,
    tokenFile: process.env.SLACK_MCP_TOKEN_FILE || join(homedir(), ".pi", "slack-mcp-oauth.json"),
  };
}

async function loadJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function saveJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

function createOAuthProvider(runtime: Runtime): OAuthClientProvider {
  const cfg = config();
  const metadata: OAuthClientMetadata = {
    client_name: "Pi Slack MCP Extension",
    redirect_uris: [cfg.callbackUrl],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: cfg.clientSecret ? "client_secret_post" : "none",
  };

  async function state() {
    return await loadJson<SavedOAuthState>(cfg.tokenFile, {});
  }

  return {
    redirectUrl: cfg.callbackUrl,
    clientMetadata: metadata,
    async clientInformation() {
      const saved = await state();
      if (saved.clientInformation) return saved.clientInformation;
      if (cfg.clientSecret) return { client_id: cfg.clientId, client_secret: cfg.clientSecret, client_id_issued_at: 0 };
      return { client_id: cfg.clientId, client_id_issued_at: 0 };
    },
    async saveClientInformation(clientInformation) {
      const saved = await state();
      await saveJson(cfg.tokenFile, { ...saved, clientInformation });
    },
    async tokens() {
      if (process.env.SLACK_MCP_ACCESS_TOKEN) {
        return { access_token: process.env.SLACK_MCP_ACCESS_TOKEN, token_type: "Bearer" };
      }
      const saved = await state();
      return saved.tokens;
    },
    async saveTokens(tokens) {
      const saved = await state();
      await saveJson(cfg.tokenFile, { ...saved, tokens });
    },
    async redirectToAuthorization(authorizationUrl) {
      runtime.lastAuthUrl = authorizationUrl.toString();
      // Pi command/tool output will surface this URL to the user.
      console.error(`[pi-slack-mcp] authorize Slack MCP: ${runtime.lastAuthUrl}`);
    },
    async saveCodeVerifier(codeVerifier) {
      const saved = await state();
      await saveJson(cfg.tokenFile, { ...saved, codeVerifier });
    },
    async codeVerifier() {
      const saved = await state();
      if (!saved.codeVerifier) throw new Error("Missing OAuth code verifier. Run /slack-mcp-auth again.");
      return saved.codeVerifier;
    },
    async invalidateCredentials(scope) {
      if (scope === "all" || scope === "tokens") {
        const saved = await state();
        delete saved.tokens;
        await saveJson(cfg.tokenFile, saved);
      }
    },
  };
}

async function waitForOAuthCode(callbackUrl: string, signal?: AbortSignal): Promise<string> {
  return await new Promise((resolve, reject) => {
    const parsedCallbackUrl = new URL(callbackUrl);
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url || "/", callbackUrl);
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");
        const errorDescription = url.searchParams.get("error_description");
        if (error) throw new Error(errorDescription || error);
        if (!code) throw new Error("OAuth callback did not include code");
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("Slack MCP connected. You can close this tab.");
        server.close();
        resolve(code);
      } catch (err) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end(String(err));
        server.close();
        reject(err);
      }
    });
    server.on("error", reject);
    signal?.addEventListener("abort", () => {
      server.close();
      reject(new Error("OAuth wait cancelled"));
    });
    server.listen(Number(parsedCallbackUrl.port), parsedCallbackUrl.hostname);
  });
}

async function connect(runtime: Runtime): Promise<Client> {
  if (runtime.client) return runtime.client;
  if (runtime.connecting) return runtime.connecting;

  runtime.connecting = (async () => {
    const cfg = config();
    const client = new Client({ name: "pi-slack-mcp", version: "0.1.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(cfg.serverUrl), {
      authProvider: createOAuthProvider(runtime),
    });
    await client.connect(transport);
    runtime.client = client;
    runtime.transport = transport;
    return client;
  })().finally(() => {
    runtime.connecting = undefined;
  });

  return runtime.connecting;
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

export default function slackMcpExtension(pi: ExtensionAPI) {
  const runtime: Runtime = {};

  pi.registerCommand("slack-mcp-auth", {
    description: "Authenticate Pi with Slack MCP",
    handler: async (_args, ctx) => {
      const cfg = config();
      const provider = createOAuthProvider(runtime);
      const client = new Client({ name: "pi-slack-mcp-auth", version: "0.1.0" }, { capabilities: {} });
      const transport = new StreamableHTTPClientTransport(new URL(cfg.serverUrl), { authProvider: provider });

      try {
        await client.connect(transport);
        ctx.ui.notify("Slack MCP is already connected.", "info");
        runtime.client = client;
        runtime.transport = transport;
        return;
      } catch (error) {
        if (!(error instanceof UnauthorizedError)) throw error;
      }

      const authUrl = runtime.lastAuthUrl;
      if (!authUrl) throw new Error("Slack MCP did not provide an authorization URL.");
      ctx.ui.notify(`Open this Slack auth URL, then return here:\n${authUrl}`, "info");
      console.error(`\nOpen this Slack auth URL:\n${authUrl}\n`);

      const code = await waitForOAuthCode(cfg.callbackUrl, ctx.signal);
      await transport.finishAuth(code);
      await client.connect(transport);
      runtime.client = client;
      runtime.transport = transport;
      ctx.ui.notify("Slack MCP authentication complete.", "info");
    },
  });

  pi.registerCommand("slack-mcp-reset", {
    description: "Remove saved Slack MCP OAuth tokens",
    handler: async (_args, ctx) => {
      const cfg = config();
      await runtime.transport?.close().catch(() => undefined);
      runtime.client = undefined;
      runtime.transport = undefined;
      await rm(cfg.tokenFile, { force: true });
      ctx.ui.notify("Slack MCP tokens removed.", "info");
    },
  });

  pi.registerTool({
    name: "slack_mcp_status",
    label: "Slack MCP Status",
    description: "Check Slack MCP connection/authentication status.",
    promptSnippet: "Check whether Slack MCP is connected.",
    parameters: Type.Object({}),
    async execute(): Promise<any> {
      try {
        const client = await connect(runtime);
        const tools = await client.listTools();
        return { content: [{ type: "text", text: `Connected to Slack MCP. ${tools.tools.length} tools available.` }], details: { connected: true, tools: tools.tools } };
      } catch (error) {
        return { content: [{ type: "text", text: `Not connected: ${error instanceof Error ? error.message : String(error)}${runtime.lastAuthUrl ? `\nAuth URL: ${runtime.lastAuthUrl}` : ""}` }], isError: true, details: { connected: false, tools: [], authUrl: runtime.lastAuthUrl } };
      }
    },
  });

  pi.registerTool({
    name: "slack_mcp_list_tools",
    label: "Slack MCP List Tools",
    description: "List tools exposed by Slack MCP.",
    promptSnippet: "List available Slack MCP tools before calling Slack MCP.",
    parameters: Type.Object({}),
    async execute(): Promise<any> {
      const client = await connect(runtime);
      const result = await client.listTools();
      return {
        content: [{ type: "text", text: result.tools.map((t) => `${t.name}: ${t.description || ""}`).join("\n") || "No Slack MCP tools returned." }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "slack_mcp_call_tool",
    label: "Slack MCP Call Tool",
    description: "Call a Slack MCP tool by name with JSON arguments.",
    promptSnippet: "Call Slack MCP tools for Slack search, messaging, channels, threads, users, files, and canvases.",
    promptGuidelines: [
      "Use slack_mcp_list_tools before slack_mcp_call_tool when the Slack MCP tool name or arguments are unknown.",
      "Use slack_mcp_call_tool for Slack requests only after the user clearly asks for Slack access or messaging.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Slack MCP tool name." }),
      arguments: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "JSON arguments to pass to the Slack MCP tool." })),
    }),
    async execute(_toolCallId, params): Promise<any> {
      const typedParams = params as { name: string; arguments?: Record<string, unknown> };
      const client = await connect(runtime);
      const result: any = await client.callTool({ name: typedParams.name, arguments: typedParams.arguments || {} });
      return {
        content: result.content?.map((item: any) => {
          if (item.type === "text") return { type: "text", text: item.text };
          return { type: "text", text: textContent(item) };
        }) || [{ type: "text", text: textContent(result) }],
        details: result,
        isError: Boolean((result as any).isError),
      };
    },
  });

  pi.on("session_shutdown", async () => {
    await runtime.transport?.close().catch(() => undefined);
  });
}

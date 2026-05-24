# Pi Slack MCP Extension

Pi package that connects Pi to Slack's hosted MCP server.

Source reference: https://github.com/slackapi/slack-mcp-plugin

## What it includes

- Pi extension: `extensions/slack-mcp/index.ts`
- Slack skills copied from Slack's plugin:
  - `skills/slack-messaging/`
  - `skills/slack-search/`
- Generic Slack MCP tools for Pi:
  - `slack_mcp_status`
  - `slack_mcp_list_tools`
  - `slack_mcp_call_tool`
- Commands:
  - `/slack-mcp-auth`
  - `/slack-mcp-reset`

## Install in Pi

From GitHub:

```bash
pi install git:github.com/clawcohen-bot/pi-slack-mcp-extension
```

Or test once:

```bash
pi -e git:github.com/clawcohen-bot/pi-slack-mcp-extension
```

From a local checkout:

```bash
pi install /path/to/pi-slack-mcp-extension
```

## Authenticate

Run inside Pi:

```text
/slack-mcp-auth
```

The extension opens a local callback server on `localhost:3118` and prints a Slack authorization URL.
Open the URL in a browser that can reach the same machine. After Slack redirects to the callback URL, tokens are saved at:

```text
~/.pi/slack-mcp-oauth.json
```

You can override config with env vars:

- `SLACK_MCP_URL` (default: `https://mcp.slack.com/mcp`)
- `SLACK_MCP_CLIENT_ID` (default: Slack Claude Code client id from slackapi/slack-mcp-plugin)
- `SLACK_MCP_CALLBACK_PORT` (default: `3118`)
- `SLACK_MCP_CALLBACK_URL` (default: `http://localhost:3118/callback`)
- `SLACK_MCP_CLIENT_SECRET` (optional, for your own Slack app)
- `SLACK_MCP_TOKEN_FILE`
- `SLACK_MCP_ACCESS_TOKEN` (optional externally-managed bearer token)

## Notes

Slack MCP is remote-only and requires workspace admin approval.

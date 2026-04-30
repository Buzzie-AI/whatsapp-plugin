# Claude Code WhatsApp Channel

A WhatsApp [channel plugin](https://code.claude.com/docs/en/channels) for
Claude Code. Receive WhatsApp messages in your running session and reply
through the same chat — like a chat bridge between WhatsApp and your local
terminal.

```text
/plugin marketplace add Buzzie-AI/whatsapp-plugin
/plugin install whatsapp@buzzie-ai
```

Built on [@buzzie-ai/whatsapp-channel](https://www.npmjs.com/package/@buzzie-ai/whatsapp-channel)
(Baileys protocol). No bot token, no third-party gateway — your linked
WhatsApp account talks to a Baileys client running on your machine.

## What it does

- **Self-chat as a remote control.** Text yourself on WhatsApp; the message
  arrives in your running Claude Code session as a `<channel>` event. Claude
  acts on it and replies back through WhatsApp.
- **Anyone else has to pair first.** First inbound DM from an unknown sender
  gets a 6-character pairing code. You approve from your terminal with
  `/whatsapp:access pair <code>`.
- **Group chats** can be opted in with mention-pattern gating.
- **Permission relay.** When Claude tries to run a tool that needs approval,
  the prompt is forwarded through WhatsApp; reply `yes <id>` or `no <id>`
  from your phone to allow or deny.

## Requirements

- Claude Code v2.1.80+ with a claude.ai login (channels are not available on
  Console / API-key auth).
- Node.js 20+ (the channel server runs under Node).
- A phone with WhatsApp installed (you'll link it as a paired device).

## Setup

### 1. Link your WhatsApp account

The companion CLI handles QR / pairing-code login. In a separate terminal:

```bash
# QR code (interactive)
npx -y @buzzie-ai/whatsapp-channel login

# Or pairing code (headless / SSH)
npx -y @buzzie-ai/whatsapp-channel login --pairing-code 60123456789
```

This writes auth credentials to `~/.whatsapp-cli/auth/`. The channel server
reuses them at startup.

### 2. Install the plugin

In Claude Code:

```text
/plugin marketplace add Buzzie-AI/whatsapp-plugin
/plugin install whatsapp@buzzie-ai
```

The first command registers this repo as a marketplace; the second installs
the `whatsapp` plugin from it.

### 3. Restart Claude Code with the channel enabled

```bash
claude --channels plugin:whatsapp@buzzie-ai
```

> **Heads up — research-preview channels.** Custom channels are not yet on
> Claude Code's approved allowlist. If `--channels plugin:whatsapp@buzzie-ai`
> errors, run with `--dangerously-load-development-channels plugin:whatsapp@buzzie-ai`
> until the flag is no longer required.

### 4. Test it

Send a message to yourself on WhatsApp. It should arrive in your terminal as
a `<channel source="whatsapp">` event, and Claude can reply back through the
same chat.

To let other contacts reach the session: have them DM your linked number,
then in Claude Code run:

```text
/whatsapp:access pair <code>
/whatsapp:access policy allowlist
```

The first command captures their JID; the second locks down the channel so
no further pairing codes are issued.

## Slash commands

- `/whatsapp:configure` — show auth + access status, point to next step.
- `/whatsapp:access` — pair codes, manage allowlist, change policy. See
  [ACCESS.md](./ACCESS.md).

## Tools exposed to Claude

| Tool   | Purpose                                                  |
| ------ | -------------------------------------------------------- |
| `reply` | Send a text reply to a WhatsApp chat by JID             |
| `react` | React to an inbound message with an emoji               |

## Develop locally

```bash
git clone https://github.com/Buzzie-AI/whatsapp-plugin
cd whatsapp-plugin
npm install
```

Then in your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["/absolute/path/to/whatsapp-plugin/server.mjs"]
    }
  }
}
```

And start Claude Code with the development flag (custom channels aren't on
the approved allowlist during the research preview):

```bash
claude --dangerously-load-development-channels server:whatsapp
```

## Security model

- **Sender allowlist.** Only JIDs in `allowFrom` (or your own self-chat) can
  push events into the session. Unknown senders silently drop, except in
  pairing mode where they get a one-time code that has to be approved from
  your terminal.
- **Group gating.** Groups must be explicitly added via `/whatsapp:access
  group add`. By default they require a mention match.
- **Permission relay scoped to trusted senders.** Only senders already in
  `allowFrom` (or self) can answer permission prompts.
- **No outbound until linked.** If `~/.whatsapp-cli/auth/creds.json` is
  missing, the MCP server still connects but tool calls fail with a clear
  message and no message-pushing happens.

## How it compares to the official channels

| Plugin    | Auth model              | Storage of creds         |
| --------- | ----------------------- | ------------------------ |
| telegram  | bot token from BotFather| `~/.claude/channels/telegram/.env` |
| discord   | bot token from dev portal | `~/.claude/channels/discord/.env` |
| imessage  | reads `chat.db` directly  | (no creds — macOS native) |
| **whatsapp** | linked-device QR/pairing-code | `~/.whatsapp-cli/auth/` (managed by `@buzzie-ai/whatsapp-channel`) |

## License

Apache-2.0

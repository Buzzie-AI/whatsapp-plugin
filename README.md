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

Authentication is handled by the companion CLI shipped with
[`@buzzie-ai/whatsapp-channel`](https://www.npmjs.com/package/@buzzie-ai/whatsapp-channel).
The package exposes a `whatsapp` bin. In a **separate terminal** (the channel
server itself is non-interactive):

**Option A — install once, run anywhere**

```bash
npm install -g @buzzie-ai/whatsapp-channel

# QR code login (interactive — needs a terminal that can render the QR)
whatsapp login

# Or pairing-code login (headless / SSH — pass your full international
# phone number, digits only, no `+`). WhatsApp will display an 8-character
# code on your phone; type it on the website prompt the CLI shows.
whatsapp login --pairing-code 60123456789

whatsapp status     # confirm the link
whatsapp logout     # unlink + clear local credentials
```

**Option B — one-shot via `npx` (no global install)**

```bash
npx -y -p @buzzie-ai/whatsapp-channel whatsapp login
npx -y -p @buzzie-ai/whatsapp-channel whatsapp login --pairing-code 60123456789
```

The `-p <package> <bin>` form is the portable way to run a bin whose name
(`whatsapp`) differs from the package name.

**Where credentials live.** The CLI writes session files to
`~/.whatsapp-cli/auth/` (set `WHATSAPP_CLI_HOME` to override the parent
directory — useful for Docker volumes or multi-account setups). The Claude
Code channel server reuses the same directory at startup, so once
`whatsapp status` says you're linked, the plugin is good to go.

> **Headless servers.** Use `whatsapp login --pairing-code <phone>` —
> WhatsApp shows the 8-character code on your phone under
> *Settings → Linked Devices → Link with phone number instead*. Type that
> code where the CLI prompts.

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

| Tool   | When available | Purpose |
| ------ | -------------- | ------- |
| `reply` | Channel-gated (only on turns with a `<channel>` event) | Send a text reply to a WhatsApp chat by JID |
| `react` | Channel-gated | React to an inbound message with an emoji |
| `send`  | Always-on (intended for autonomous outbound) | Fire an unsolicited message — cron alerts, capital events, autopilot pings. `text` required; `chat_id` defaults to the operator self-chat. |

> The `send` tool exists so cron-triggered or otherwise autonomous turns can
> push messages out through the plugin's existing Baileys session, instead of
> spinning up a second client (which would conflict with the persistent
> session — WhatsApp Web only allows one device-link socket at a time).

## Diagnostics

The channel server tees all diagnostic output to:

```
~/.claude/channels/whatsapp/server.log
```

Tail it to watch the live message flow:

```bash
tail -f ~/.claude/channels/whatsapp/server.log
```

What you'll see when a WhatsApp message arrives:

```
2026-05-04T... [in] messages.upsert type=notify count=1
2026-05-04T... [in] from=60123456789@s.whatsapp.net fromMe=1 msgId=ABC preview="hey"
2026-05-04T... [in] forward kind=self chat=60123456789@s.whatsapp.net sender=...
```

Common drop reasons (each emits its own `[in] skip` or `[in] decision=dropped` line):

| Reason | Meaning |
| ------ | ------- |
| `own-echo` | A message the bot itself just sent — filtered to avoid loops. |
| `history-replay` | Baileys replayed a message older than the session — ignored. |
| `no-text` | Reaction or media without caption — nothing to forward. |
| `dm-not-allowlisted` | DM from a sender not in `allowFrom`; with `dmPolicy: pairing`, a code is issued instead. |
| `group-not-opted-in` | Group hasn't been added with `/whatsapp:access group add`. |
| `group-filter-mismatch` | Group is opted in but mention pattern or per-group allowlist rejected the message. |

The log auto-rotates at 5MB (previous file kept as `server.log.1`). Outbound `[tool] reply`, `[tool] send`, and `[send]` lines also land here, so a single `tail -f` shows the full request/response cycle.

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

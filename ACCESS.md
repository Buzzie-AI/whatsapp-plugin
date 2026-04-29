# WhatsApp Channel — Access Control Reference

The WhatsApp channel maintains a sender allowlist and DM policy at
`~/.claude/channels/whatsapp/access.json`. The channel server reads it on
every inbound message; changes take effect immediately, no restart.

All mutations go through `/whatsapp:access`. Don't hand-edit unless you know
what you're doing — the file is also written by the server (pairing
requests).

## State shape

```json
{
  "dmPolicy": "pairing",
  "allowFrom": ["60123456789@s.whatsapp.net"],
  "groups": {
    "120363012345@g.us": {
      "requireMention": true,
      "allowFrom": []
    }
  },
  "pending": {
    "x9k2m4": {
      "senderId": "65987654321@s.whatsapp.net",
      "chatId":   "65987654321@s.whatsapp.net",
      "senderName": "Alice",
      "createdAt": 1714421500000,
      "expiresAt": 1714422100000
    }
  },
  "mentionPatterns": ["@claude", "hey claude"]
}
```

| Field            | Type                  | Meaning |
| ---------------- | --------------------- | ------- |
| `dmPolicy`       | `pairing` \| `allowlist` \| `disabled` | What to do with inbound DMs from senders not in `allowFrom`. |
| `allowFrom`      | `string[]`            | JIDs trusted to push events into the session. Self-chat is implicitly allowed regardless. |
| `groups`         | `object`              | Per-group config — only listed groups are forwarded at all. |
| `pending`        | `object`              | Active pairing codes. Server-managed; don't write here. |
| `mentionPatterns`| `string[]`            | Regex strings (case-insensitive). At least one must match the message body for `requireMention: true` group messages to forward. |

### DM policies

- **`pairing`** (default): unknown senders get a 6-char code; they're DM'd
  with instructions to ask the operator to run `/whatsapp:access pair <code>`.
  The session also receives a `kind="pairing_request"` notification.
- **`allowlist`**: unknown senders are silently dropped. Use this once you've
  paired everyone who should reach the session.
- **`disabled`**: every DM from a non-allowlisted sender is dropped. Self-chat
  still works.

## Self-chat is special

When you message yourself on WhatsApp (your own number), the channel server
treats you as automatically trusted. You don't need to pair, and you don't
appear in `allowFrom`. This mirrors how the iMessage channel handles your own
addresses.

## Commands

```text
/whatsapp:access                          # show current state
/whatsapp:access pair <code>              # approve a pending pairing
/whatsapp:access deny <code>              # reject a pending pairing
/whatsapp:access allow <jid>              # add a JID to the allowlist directly
/whatsapp:access remove <jid>             # remove a JID from the allowlist
/whatsapp:access policy <pairing|allowlist|disabled>
/whatsapp:access group add <groupJid> [--no-mention] [--allow jid1,jid2]
/whatsapp:access group rm <groupJid>
/whatsapp:access mention add <regex>      # add a mention pattern
/whatsapp:access mention rm <regex>       # remove a mention pattern
```

JIDs:

- 1:1 chats: `<phone>@s.whatsapp.net` (e.g. `60123456789@s.whatsapp.net`)
- groups: `<id>@g.us` (e.g. `120363012345@g.us`)

## Pairing flow

1. An unknown sender DMs your linked number.
2. Server generates a 6-char code (lowercase, no `l`), stores it in
   `pending`, and DMs the sender:
   *"Pairing requested. Ask the operator to run: /whatsapp:access pair x9k2m4"*
3. The session also receives a notification with `meta.kind="pairing_request"`
   and the code.
4. You run `/whatsapp:access pair x9k2m4` in Claude Code. The skill:
   - Adds `senderId` to `allowFrom`.
   - Deletes the `pending` entry.
   - Writes a flag file to `~/.claude/channels/whatsapp/approved/<sanitized>`.
5. The server's `fs.watch` on the approved dir picks up the flag, DMs the
   sender *"You're paired"*, and deletes the flag.

Codes expire after 10 minutes.

## Permission relay

When Claude tries to use a tool that requires approval (Bash, Write, Edit),
the local terminal dialog opens **and** a prompt is sent through the most
recent trusted WhatsApp chat:

```
Claude wants to run Bash: list the files in this directory

Reply "yes abcde" or "no abcde".
```

Reply from WhatsApp with `yes <id>` or `no <id>` (any of `y`/`yes`/`n`/`no`,
case-insensitive — phone autocorrect-friendly). The first answer to arrive
wins; if you answer at the terminal first, the remote prompt is dropped.

Only senders in `allowFrom` (or self) can answer prompts. A verdict from an
unknown sender is treated as a regular message and ignored.

## Group chats

Groups are off by default — even if you're an admin of a group, the channel
won't forward its messages until you opt the group in.

```text
/whatsapp:access group add 120363012345@g.us
/whatsapp:access mention add @claude
```

With `requireMention: true`, the group's messages only forward when the body
matches one of the `mentionPatterns`. With `requireMention: false`, every
message in the group forwards, which is rarely what you want for an active
group.

To restrict who in a group can reach Claude:

```text
/whatsapp:access group add 120363012345@g.us --allow 60123456789@s.whatsapp.net,60198765432@s.whatsapp.net
```

Empty `allowFrom` on a group entry means "any participant" (still subject to
`requireMention`).

## Threat model

- **Anyone who DMs your linked WhatsApp number** can trigger a pairing code
  exchange. The code itself is harmless; it's only useful if approved from
  your terminal.
- **`pairing` is not a long-term policy.** Treat it as a capture mode. Switch
  to `allowlist` once everyone who should reach the session is in.
- **Permission relay grants trusted senders the ability to approve tool
  calls in your session.** Only allow JIDs you'd hand the keyboard to.
- **Group `allowFrom` does not protect against compromised group
  membership.** A group admin adding a malicious participant could push
  events if they match the mention pattern. Prefer DM allowlists for
  high-trust scenarios.

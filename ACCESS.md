# WhatsApp Channel — Access Control Reference

The WhatsApp channel forwards exactly two things into your Claude Code
session:

1. **Self-chat** — the operator messaging their own WhatsApp number.
2. **Opted-in groups, operator-only** — messages the operator types into
   a group whose JID has been opted in via
   `/whatsapp:access group add <groupJid>`. Other participants in the
   same group are silently dropped at the server.

DMs from other contacts are **never** forwarded. There is no DM
allowlist, no pairing flow, no mention-pattern gating. The channel does
not respond to strangers in any way — their messages reach the server
log and stop there.

State lives at `~/.claude/channels/whatsapp/access.json`. The server
re-reads it on every inbound message — changes take effect immediately,
no restart.

## State shape

```json
{
  "groups": {
    "120363012345@g.us": {}
  }
}
```

| Field    | Type     | Meaning |
| -------- | -------- | ------- |
| `groups` | `object` | Map of opted-in group JIDs to (currently empty) config objects. Membership in `groups` is the entire signal — only operator-typed messages from these groups forward. |

Missing file = `{groups:{}}`. Legacy v0.4.x files (with `dmPolicy`,
`allowFrom`, `pending`, `mentionPatterns`, or per-group `requireMention`
/ `allowFrom`) are self-healed on first read — extraneous fields are
dropped and the cleaned form is written back. No manual migration step.

## Self-chat

Texting yourself on WhatsApp always works. The whatsapp-channel client
detects self-chat by matching the chat JID against `whoami().selfChatJid`
and the LID twin, both during canonicalization. You don't need to
configure anything; self-chat is not represented in `access.json`.

## Operator-only group forwarding

The operator's own JID is identified by matching `evt.sender` against
both `me.id` (PN form, e.g. `60123456789@s.whatsapp.net`) and `me.lid`
(LID twin, e.g. `60123456789@lid`). Both are device-suffix-stripped by
the whatsapp-channel client, and so is `evt.sender`, so a literal `===`
comparison covers both delivery shapes that WhatsApp uses.

This means: only you — from the same WhatsApp account this server is
linked to — can drive the session by typing into a group. Other
participants' messages in the same group are dropped silently. Group
membership is opt-in per group; the channel forwards nothing from a
group that hasn't been added.

## Commands

```text
/whatsapp:access                          # show current state
/whatsapp:access group add <groupJid>     # opt a group in (operator-only)
/whatsapp:access group rm <groupJid>      # opt a group out
```

JIDs:

- groups: `<id>@g.us` (e.g. `120363012345@g.us`)

Find a group's JID by sending any message into it and watching the
`[in]` line in `~/.claude/channels/whatsapp/server.log` — `from=<jid>`
is the group JID. (You can also opt the group in first and then check
the log; the message will still drop until your own message hits, but
the JID is logged.)

## Permission relay

When Claude tries to use a tool that requires approval (Bash, Write,
Edit), the prompt is sent through the most recent trusted WhatsApp chat:

```
Claude wants to run Bash: list the files in this directory

Reply "yes abcde" or "no abcde".
```

Reply with `yes <id>` or `no <id>` from the same chat (any of `y`/`yes`/
`n`/`no`, case-insensitive — phone autocorrect-friendly). The first
answer to arrive wins; if you answer at the terminal first, the remote
prompt is dropped.

Only self-chat and opted-in groups can be a relay target — those are
the only places the channel forwards from. Verdicts from other senders
in the same group fail the trust check (they're not the operator) and
fall through to the drop.

## Threat model

- **Anyone who DMs your linked WhatsApp number** is silently ignored.
  The server sees the message, drops it with reason
  `dm-forwarding-disabled`, and never responds. No pairing prompts, no
  auto-replies, nothing visible.
- **Group membership is trust on the operator's identity, not on the
  group composition.** Even an admin adding malicious participants
  can't push events into the session — only messages whose sender JID
  matches the linked account's `me.id`/`me.lid` forward.
- **Permission relay grants approval power to whoever can produce a
  message that reaches the relay chat.** Under the operator-only model
  that's exclusively the operator (self-chat, or operator-typed-in-an-
  opted-in-group). The trust surface collapses to "the operator's own
  WhatsApp account."

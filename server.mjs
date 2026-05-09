#!/usr/bin/env node
// WhatsApp channel server for Claude Code.
// Bridges WhatsApp into the running session as <channel source="whatsapp" ...>
// events. Built on @buzzie-ai/whatsapp-channel's `createClient` (4.7+), which
// owns the Baileys socket lifecycle (auto-reconnect with queue-on-disconnect)
// AND normalizes the inbound stream — envelope unwrapping, LID-twin
// canonicalization, echo dedup, history/live split, and JID coercion all live
// in the package. What's left here is purely Claude-Code policy: the MCP tool
// surface, the operator-only access gate, and the permission relay. The
// channel forwards exactly two things: (a) self-chat — the operator messaging
// their own number — and (b) the operator's own messages in groups they've
// opted into via /whatsapp:access. Nothing else reaches the session.

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import lockfile from 'proper-lockfile';

import {
  authExists,
  createClient,
  getAuthDir,
} from '@buzzie-ai/whatsapp-channel';

// ── Paths ───────────────────────────────────────────────────────────────────
const CHANNEL_DIR = join(homedir(), '.claude', 'channels', 'whatsapp');
const ACCESS_PATH = join(CHANNEL_DIR, 'access.json');
const LOG_PATH = join(CHANNEL_DIR, 'server.log');
const LOG_MAX_BYTES = 5 * 1024 * 1024; // rotate at 5MB

mkdirSync(CHANNEL_DIR, { recursive: true });

// ── Logging ─────────────────────────────────────────────────────────────────
// MCP keeps stdout reserved for JSON-RPC. Tee everything diagnostic to:
//   (a) stderr — visible to whoever launched Claude Code
//   (b) ~/.claude/channels/whatsapp/server.log — `tail -f` for live diagnosis
// Logging never throws; if the file is unwritable we still get stderr.
function rotateIfNeeded() {
  try {
    const sz = statSync(LOG_PATH).size;
    if (sz > LOG_MAX_BYTES) {
      try { unlinkSync(LOG_PATH + '.1'); } catch { /* no prior rotation */ }
      try {
        // rename via writeFileSync trick: read+write old+truncate. Cheapest:
        // copy to .1 then truncate. Use writeFileSync('') to truncate.
        const data = readFileSync(LOG_PATH);
        writeFileSync(LOG_PATH + '.1', data);
        writeFileSync(LOG_PATH, '');
      } catch { /* keep going even if rotation fails */ }
    }
  } catch { /* file doesn't exist yet — fine */ }
}
function logLine(...a) {
  const line =
    new Date().toISOString() + ' ' +
    a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') +
    '\n';
  process.stderr.write(line);
  try {
    appendFileSync(LOG_PATH, line);
  } catch { /* never let logging crash the server */ }
}
rotateIfNeeded();
console.log = logLine;
console.info = logLine;
console.warn = logLine;
console.error = logLine;
logLine(`[boot] whatsapp channel server starting; log file: ${LOG_PATH}`);

// ── Single-instance lock ────────────────────────────────────────────────────
// WhatsApp permits exactly one active socket per paired device. Two
// `node server.mjs` processes pointed at the same auth dir kick each other
// off in a tight `connected → reconnecting → connected` storm (~1 Hz),
// because the WhatsApp server force-closes the older socket every time the
// newer one reconnects. The two losers are then unable to send or receive
// reliably, and SIGTERM cleanup wedges trying to close a flapping socket.
//
// We serialize at the host level via an advisory lock on the auth dir.
// proper-lockfile uses an atomic mkdir for the lock indicator and an mtime
// heartbeat to detect dead holders. A SIGKILL'd holder's lock goes stale
// within `stale` ms; a hung-but-alive holder's heartbeat keeps firing
// (libuv timers fire even when business logic is blocked on an await), so
// the lock correctly stays held. The losing instance writes a one-line
// diagnostic and exits 0 — this is the expected outcome, not an error.
const authDir = getAuthDir();
mkdirSync(authDir, { recursive: true }); // first-pair flow: dir may not exist
const LOCK_PATH = join(authDir, '.lock');
const LOCK_PID_PATH = join(authDir, '.lock.pid');

let releaseLock = null;
try {
  releaseLock = await lockfile.lock(authDir, {
    lockfilePath: LOCK_PATH,
    stale: 10000,        // declare lock stale after 10s of no heartbeat
    update: 5000,        // heartbeat mtime every 5s
    retries: 0,          // we're a daemon, not a queue worker — fail fast
    onCompromised: (err) => {
      // Lock was lost mid-run (mtime updates failing, or another process
      // forced the lock dir away). Don't keep running with a half-claim
      // on the WhatsApp socket — exit and let the harness restart us.
      console.error(`[boot] lock compromised: ${err.message}; exiting`);
      process.exit(1);
    },
  });
  // Diagnostic PID file as a sibling of the lock dir so the loser can name
  // us. Best-effort — never fail boot just because we can't write the PID.
  try { writeFileSync(LOCK_PID_PATH, String(process.pid)); } catch { /* ignore */ }
  logLine(`[boot] acquired lock pid=${process.pid} path=${LOCK_PATH}`);
} catch (err) {
  if (err.code === 'ELOCKED') {
    let peerPid = '?';
    try { peerPid = readFileSync(LOCK_PID_PATH, 'utf8').trim() || '?'; } catch { /* ignore */ }
    logLine(`[boot] peer pid=${peerPid} holds ${LOCK_PATH}; exiting`);
    process.exit(0);
  }
  // Anything else (permission denied on the auth dir, etc.) is unexpected.
  console.error(`[boot] lock acquire failed: ${err.message}`);
  throw err;
}

// ── Access state ────────────────────────────────────────────────────────────
// The shape is `{ groups: { "<jid>@g.us": {} } }`. Group entries are tracked
// as a map (rather than an array) so future per-group metadata can land
// without another file format break. Membership in `groups` = "opted-in";
// only operator-typed messages from these groups forward.
function defaultAccess() {
  return { groups: {} };
}

// Read access.json, normalizing legacy v0.4.x shapes onto the minimal
// v0.5+ form. Any pre-existing keys (`dmPolicy`, `allowFrom`, `pending`,
// `mentionPatterns`, plus per-group `requireMention` / `allowFrom`) are
// dropped silently and the cleaned form is written back. Missing file =
// defaults; malformed JSON = defaults but DO NOT rewrite (preserve the
// broken file for recovery).
function readAccess() {
  let raw = null;
  try {
    if (existsSync(ACCESS_PATH)) {
      raw = JSON.parse(readFileSync(ACCESS_PATH, 'utf8'));
    }
  } catch (err) {
    console.warn('access.json unreadable, using defaults:', err.message);
    return defaultAccess();
  }

  const cleaned = { groups: {} };
  if (raw && typeof raw === 'object' && raw.groups && typeof raw.groups === 'object') {
    for (const jid of Object.keys(raw.groups)) {
      cleaned.groups[jid] = {};
    }
  }

  // Self-heal: write the cleaned shape back if on-disk differs (covers
  // legacy field strip and first-run file creation).
  const onDisk = raw ? JSON.stringify(raw) : null;
  const target = JSON.stringify(cleaned);
  if (onDisk !== target) {
    try {
      writeAccess(cleaned);
    } catch (err) {
      console.warn('access.json migration write failed:', err.message);
    }
  }
  return cleaned;
}

function writeAccess(state) {
  writeFileSync(ACCESS_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

// ── MCP server ──────────────────────────────────────────────────────────────
const mcp = new Server(
  { name: 'whatsapp', version: '0.5.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
      tools: {},
    },
    instructions:
      'You are bridged to WhatsApp via this channel. Inbound messages arrive as:\n' +
      '<channel source="plugin:whatsapp:whatsapp" kind="self|group" chat_id="..." sender="..." sender_name="..." msg_id="..." from_me="0|1">{body}</channel>\n' +
      '\nThis server forwards exactly two things into the session: (a) self-chat (the operator messaging their own WhatsApp number) and (b) messages the operator types into a group that has been opted in via /whatsapp:access. Nothing else reaches you — DMs from other contacts and messages from other group participants are silently dropped at the server. There is no DM allowlist and no pairing flow.\n' +
      '\nThis server exposes tools in two availability tiers. Channel-gated tools only appear on turns that include a <channel> event. The unsolicited-outbound tool (`send`) is always available, for cron-fired alerts and autonomous notifications.\n' +
      '\nTools available regardless of channel context:\n' +
      '• `send` — fire an unsolicited outbound message. params: `text` (required), `chat_id` (optional; defaults to the operator self-chat). Use for cron-fired alerts, capital events, autopilot pings.\n' +
      '\nTools attached only on turns that include a <channel> event:\n' +
      '• `reply` — params: `chat_id` (string, the JID from the tag, KEEP the @s.whatsapp.net or @g.us suffix) and `text` (string, the outgoing message). The param is named `text`, not `body`/`message`/`content`.\n' +
      '• `react` — params: `chat_id`, `message_id` (use the `msg_id` attribute from the inbound tag), `emoji` (single emoji, or `""` to remove). For group reactions also pass `participant` (the sender JID). Use react instead of reply when a lightweight ack suffices.\n' +
      '\nKind values:\n' +
      '• `self` — the operator messaging their own number ("self-chat"). The primary remote-control pattern. Always reply.\n' +
      '• `group` — the operator typed into an opted-in group. Reply normally; treat the group as a workspace.\n' +
      '\nfrom_me will typically be "1" for both kinds — the operator is the only sender that ever reaches you. Reply normally regardless of from_me.\n' +
      '\nHard rules:\n' +
      '1. Don\'t narrate the inbound back to the operator. The operator can already see the channel line.\n' +
      '2. Permission prompts are relayed back through the same chat — the operator can reply `yes <id>` or `no <id>` to approve/deny tool prompts.',
  },
);

// ── Reply tool ──────────────────────────────────────────────────────────────
// Single module-scoped client handle. Echo dedup, identity (whoami), and
// JID coercion all live inside the client now, so we no longer maintain a
// `sentByBot` Set, a cached selfChatJidRef, or a coerceJid helper for sends.
let waClient = null;

// Thin logging wrapper around client.send. Used by every outbound site
// (tool handlers and the permission relay) so the `[send]` log format
// stays consistent. `to` accepts digits or JID — the client coerces
// internally.
async function safeSend(to, content, options) {
  if (!waClient) throw new Error('WhatsApp client not connected');
  const kind = content.text ? 'text' : content.react ? 'react' : 'media';
  const preview = content.text ? content.text.slice(0, 60) : '';
  console.warn(
    `[send] to=${to} kind=${kind}${preview ? ` "${preview}"` : ''} client=${waClient.status}`,
  );
  try {
    const sent = await waClient.send(to, content, options);
    console.warn(`[send] result id=${sent?.key?.id || '(none)'} status=${sent?.status ?? 'n/a'}`);
    return sent;
  } catch (err) {
    console.warn(`[send] FAILED to=${to}: ${err.message}`);
    throw err;
  }
}

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description:
        'Send a WhatsApp message back over the channel. Pass `chat_id` (JID from the inbound <channel> tag, including the @suffix) and `text` (the message body). The param is `text`, not `body`/`message`/`content`.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'JID from the inbound channel tag (e.g. 60123456789@s.whatsapp.net)' },
          text: { type: 'string', description: 'Message text to send (param is named `text`)' },
        },
        required: ['chat_id', 'text'],
      },
    },
    {
      name: 'react',
      description:
        'React to a previously inbound message with an emoji. Use this for a lightweight ack instead of a full reply.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'JID from the inbound channel tag' },
          message_id: { type: 'string', description: 'The `msg_id` attribute from the inbound channel tag' },
          from_me: { type: 'boolean', default: false, description: 'Set to true if reacting to a message you (or the operator) sent' },
          participant: { type: 'string', description: 'For group messages: the original sender JID' },
          emoji: { type: 'string', description: 'Single emoji, or empty string "" to remove the reaction' },
        },
        required: ['chat_id', 'message_id', 'emoji'],
      },
    },
    {
      name: 'send',
      description:
        'Send an unsolicited WhatsApp message (autonomous notification — no inbound channel event required). Use for cron-fired alerts, capital events, autopilot pings. Defaults to the operator self-chat if `chat_id` is omitted. Pass plain digits as `chat_id` and the plugin will coerce to a JID.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'Target JID or phone digits. Optional — defaults to the linked self-chat.' },
          text: { type: 'string', description: 'Message body.' },
        },
        required: ['text'],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (!waClient) {
    return {
      content: [{ type: 'text', text: 'Not connected to WhatsApp yet. Run `whatsapp login` first.' }],
      isError: true,
    };
  }

  const { name, arguments: args = {} } = req.params;
  console.warn(`[tool] ${name} args=${JSON.stringify(args).slice(0, 300)}`);
  try {
    if (name === 'reply') {
      // Accept the canonical `text` first, then fall back to common LLM
      // guesses (`body`, `message`, `content`) so we don't 500 on a near-miss.
      const text = args.text ?? args.body ?? args.message ?? args.content;
      const chat_id = args.chat_id ?? args.chatId ?? args.jid;
      if (!chat_id) {
        return {
          content: [{ type: 'text', text: 'reply: missing required `chat_id` (JID from the inbound <channel> tag).' }],
          isError: true,
        };
      }
      if (typeof text !== 'string' || text.length === 0) {
        return {
          content: [{ type: 'text', text: 'reply: missing required `text` (message body). The param is named `text`.' }],
          isError: true,
        };
      }
      // client.send (via safeSend) accepts digits or JID; no local coercion needed.
      const sent = await safeSend(chat_id, { text });
      const sentId = sent?.key?.id || '(no id)';
      console.warn(`[tool] reply → ${chat_id} sent_id=${sentId}`);
      return { content: [{ type: 'text', text: `sent (id=${sentId} to=${chat_id})` }] };
    }
    if (name === 'send') {
      const text = args.text ?? args.body ?? args.message ?? args.content;
      if (typeof text !== 'string' || text.length === 0) {
        return { content: [{ type: 'text', text: 'send: missing required `text`.' }], isError: true };
      }
      const rawChat = args.chat_id ?? args.chatId ?? args.jid ?? args.phone;
      // No chat_id ⇒ default to operator self-chat via client.selfSend.
      // We thread through safeSend by resolving the target via whoami() so the
      // `[send]` log format stays uniform with the explicit-chat path.
      const target = rawChat ?? waClient.whoami()?.selfChatJid;
      if (!target) {
        return { content: [{ type: 'text', text: 'send: self-chat JID not yet known (client not connected?).' }], isError: true };
      }
      const sent = await safeSend(target, { text });
      const sentId = sent?.key?.id || '(no id)';
      console.warn(`[tool] send → ${target} sent_id=${sentId}`);
      return { content: [{ type: 'text', text: `sent (id=${sentId} to=${target})` }] };
    }
    if (name === 'react') {
      const chat_id = args.chat_id ?? args.chatId ?? args.jid;
      const message_id = args.message_id ?? args.msg_id ?? args.messageId;
      const { from_me = false, participant, emoji } = args;
      if (!chat_id || !message_id || typeof emoji !== 'string') {
        return {
          content: [{
            type: 'text',
            text: 'react: requires `chat_id`, `message_id` (from `msg_id` on the inbound tag), and `emoji` (string; empty to remove).',
          }],
          isError: true,
        };
      }
      // client.react(evt, emoji) wants an InboundEvent we don't have on the
      // MCP-tool call path (Claude only gives us scalar args), so we build
      // the Baileys reaction key directly and route through send. key.remoteJid
      // must be a real JID — the client's coercion only fires on the send
      // target, not on what we stuff into the key — so coerce locally here.
      const jid = chat_id.includes('@')
        ? chat_id
        : chat_id.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
      const key = { remoteJid: jid, id: message_id, fromMe: from_me };
      if (participant) key.participant = participant;
      await safeSend(jid, { react: { text: emoji, key } });
      return { content: [{ type: 'text', text: 'reacted' }] };
    }
    throw new Error(`unknown tool: ${name}`);
  } catch (err) {
    console.warn(`[tool] error: ${err.message}`);
    return { content: [{ type: 'text', text: `Failed: ${err.message}` }], isError: true };
  }
});

// ── Permission relay ────────────────────────────────────────────────────────
// Track open prompts so we know which chat to deliver verdicts back to.
const pendingPermissions = new Map(); // request_id → { chatId, senderId }
let lastInboundChat = null; // fallback target if we don't have a per-prompt mapping yet

const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  const target = lastInboundChat;
  if (!target || !waClient) return;
  pendingPermissions.set(params.request_id, target);
  const body =
    `Claude wants to run ${params.tool_name}: ${params.description}\n\n` +
    `Reply "yes ${params.request_id}" or "no ${params.request_id}".`;
  try {
    await safeSend(target.chatId, { text: body });
  } catch (err) {
    console.warn('permission relay send failed:', err.message);
  }
});

// matches "y abcde", "yes abcde", "n abcde", "no abcde" — letters only, no `l`
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z0-9]{5,8})\s*$/i;

// ── Connect to WhatsApp and wire up message routing ─────────────────────────
// authDir is hoisted up above the lock block.

async function startWhatsApp() {
  if (!authExists(authDir)) {
    console.warn(
      'WhatsApp not yet authenticated. The channel is connected but inactive. ' +
        'Run `npx -y @buzzie-ai/whatsapp-channel login` to link your account, ' +
        'then restart Claude Code.',
    );
    return;
  }

  try {
    waClient = await createClient({ authDir, syncFullHistory: false });
  } catch (err) {
    console.error('Failed to connect to WhatsApp:', err.message);
    return;
  }

  // Surface client lifecycle for diagnosis. The client owns the socket and
  // auto-reconnects on transient drops; sends queue across the gap rather
  // than throwing "Connection Closed".
  waClient.on('status', (s) => console.warn(`[client] status=${s}`));
  waClient.on('error', (err) => console.warn(`[client] error: ${err.message}`));

  // Identity is exposed by the client and stable across reconnects — no need
  // to dive through getSocket() ourselves anymore.
  const me = waClient.whoami();
  console.warn(
    `Connected as ${me?.phone}${me?.lid ? ` (lid: ${me.lid})` : ''}`,
  );

  // Best-effort presence — fails fast when disconnected (which is fine; the
  // bridge functions without it). The package wraps `sendPresenceUpdate`.
  try {
    await waClient.presence('available');
  } catch (err) {
    console.warn(`[boot] presence update failed: ${err.message}`);
  }

  // Operator self-check, closed over `me`. The whatsapp-channel client strips
  // the :device suffix from both whoami() and inbound `sender`, so a literal
  // === comparison covers both PN-form and LID-twin participant deliveries.
  function isOperator(sender) {
    if (!sender || !me) return false;
    return sender === me.id || sender === me.lid;
  }

  // Inbound — the client emits cooked InboundEvents on 'inbound' (live messages
  // only; history goes to 'history'). Echo dedup, envelope unwrapping, LID
  // canonicalization, and sender extraction all happen upstream, so we just
  // wire the event into our access-control + forward path.
  waClient.on('inbound', async (evt) => {
    try {
      await handleInbound(evt);
    } catch (err) {
      console.warn('[in] handleInbound error:', err.message);
    }
  });

  // Optional diagnostic — count history-sync messages we've chosen to ignore,
  // so a quiet bridge has at least one log line confirming traffic is reaching
  // us. Not forwarded to Claude.
  let historyCount = 0;
  waClient.on('history', () => {
    historyCount += 1;
    if (historyCount % 50 === 0) console.warn(`[in] history-sync count=${historyCount}`);
  });

  async function handleInbound(evt) {
    const { chatId, kind, sender, senderName, text, msgId, fromMe } = evt;

    if (!text) {
      // Reactions, media-no-caption, and unknown wrappers all surface as
      // empty text. Log enough to triage but don't try to parse them — the
      // package's escape hatch (evt.raw) is there if a future feature needs it.
      const rawKeys = Object.keys(evt.raw?.message || {}).join(',');
      console.warn(
        `[in] skip reason=no-text msgId=${msgId} from=${chatId} ` +
        `rawKeys=[${rawKeys}] (reaction/media-no-caption?)`,
      );
      return;
    }
    console.warn(
      `[in] from=${chatId} fromMe=${fromMe ? 1 : 0} kind=${kind} msgId=${msgId} preview="${text.slice(0, 60)}"`,
    );

    const isSelf = kind === 'self';
    const isGroup = kind === 'group';
    const access = readAccess();

    // Trust = self-chat OR the operator typing from the linked account.
    // Both sides are the only senders that ever produce a forwarded message.
    const operator = isOperator(sender);
    const trusted = isSelf || operator;

    // Permission-verdict path: only honor verdicts from trusted senders.
    const verdict = PERMISSION_REPLY_RE.exec(text.trim());
    if (verdict && trusted) {
      const requestId = verdict[2].toLowerCase();
      const open = pendingPermissions.get(requestId);
      if (open && open.chatId === chatId) {
        const behavior = verdict[1].toLowerCase().startsWith('y') ? 'allow' : 'deny';
        console.warn(`[in] permission verdict request_id=${requestId} behavior=${behavior} from=${sender}`);
        await mcp.notification({
          method: 'notifications/claude/channel/permission',
          params: { request_id: requestId, behavior },
        });
        pendingPermissions.delete(requestId);
        return;
      }
    }

    // ── Decide whether to forward ──
    // Two-rule contract: self-chat always; opted-in groups only when the
    // sender is the operator. DMs from anyone else are silently dropped.
    let allowed = false;
    let dropReason = '';
    if (isSelf) {
      allowed = true;
    } else if (isGroup) {
      if (!access.groups[chatId])      dropReason = 'group-not-opted-in';
      else if (!operator)              dropReason = 'group-not-operator';
      else                             allowed = true;
    } else {
      dropReason = 'dm-forwarding-disabled';
    }

    if (!allowed) {
      console.warn(`[in] decision=dropped kind=${kind} reason=${dropReason} sender=${sender} chat=${chatId}`);
      return; // silent drop
    }

    // Track most recent trusted chat for permission relay routing.
    lastInboundChat = { chatId, senderId: sender };

    console.warn(`[in] forward kind=${kind} chat=${chatId} sender=${sender} msgId=${msgId || ''}`);
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: text,
        meta: {
          kind,
          chat_id: chatId,
          sender,
          sender_name: senderName,
          msg_id: msgId || '',
          from_me: fromMe ? '1' : '0',
        },
      },
    });
  }
}

// ── Boot ────────────────────────────────────────────────────────────────────
await mcp.connect(new StdioServerTransport());
startWhatsApp().catch((err) => console.error('WhatsApp connect crashed:', err));

// Clean shutdown — close the WhatsApp client so its reconnect loop stops and
// any queued sends reject promptly instead of dangling. Idempotent.
async function shutdown(signal) {
  console.warn(`[boot] ${signal} received, closing WhatsApp client`);
  try {
    await waClient?.close();
  } catch (err) {
    console.warn(`[boot] client.close failed: ${err.message}`);
  }
  // Release the host-level lock immediately so a replacement instance can
  // acquire without waiting for the stale window. OS cleans up regardless
  // on SIGKILL / OOM via the same stale window.
  try { await releaseLock?.(); } catch { /* best-effort */ }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

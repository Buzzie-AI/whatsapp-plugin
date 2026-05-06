#!/usr/bin/env node
// WhatsApp channel server for Claude Code.
// Bridges WhatsApp into the running session as <channel source="whatsapp" ...>
// events. Built on @buzzie-ai/whatsapp-channel's `createClient` (4.7+), which
// owns the Baileys socket lifecycle (auto-reconnect with queue-on-disconnect)
// AND normalizes the inbound stream — envelope unwrapping, LID-twin
// canonicalization, echo dedup, history/live split, and JID coercion all live
// in the package. What's left here is purely Claude-Code policy: the MCP tool
// surface, access control (DM pairing / group allowlist / mention regex),
// pairing-code lifecycle, and the permission relay. Self-chat is auto-allowed;
// everyone else pairs via /whatsapp:access.

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
} from 'node:fs';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import {
  authExists,
  createClient,
  getAuthDir,
} from '@buzzie-ai/whatsapp-channel';

// ── Paths ───────────────────────────────────────────────────────────────────
const CHANNEL_DIR = join(homedir(), '.claude', 'channels', 'whatsapp');
const ACCESS_PATH = join(CHANNEL_DIR, 'access.json');
const APPROVED_DIR = join(CHANNEL_DIR, 'approved');
const LOG_PATH = join(CHANNEL_DIR, 'server.log');
const LOG_MAX_BYTES = 5 * 1024 * 1024; // rotate at 5MB

mkdirSync(CHANNEL_DIR, { recursive: true });
mkdirSync(APPROVED_DIR, { recursive: true });

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

// ── Access state ────────────────────────────────────────────────────────────
function defaultAccess() {
  return {
    dmPolicy: 'pairing', // pairing | allowlist | disabled
    allowFrom: [],
    groups: {},
    pending: {},
    mentionPatterns: [],
  };
}

function readAccess() {
  try {
    if (!existsSync(ACCESS_PATH)) return defaultAccess();
    const data = JSON.parse(readFileSync(ACCESS_PATH, 'utf8'));
    return { ...defaultAccess(), ...data };
  } catch (err) {
    console.warn('access.json unreadable, using defaults:', err.message);
    return defaultAccess();
  }
}

function writeAccess(state) {
  writeFileSync(ACCESS_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

// 6-char pairing code; lowercase, no `l` (avoids l/1 confusion on phones).
const PAIR_ALPHABET = 'abcdefghijkmnopqrstuvwxyz0123456789';
function newPairingCode() {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += PAIR_ALPHABET[Math.floor(Math.random() * PAIR_ALPHABET.length)];
  }
  return code;
}

// ── MCP server ──────────────────────────────────────────────────────────────
const mcp = new Server(
  { name: 'whatsapp', version: '0.4.1' },
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
      '<channel source="plugin:whatsapp:whatsapp" kind="dm|group|self|pairing_request" chat_id="..." sender="..." sender_name="..." msg_id="..." from_me="0|1">{body}</channel>\n' +
      '\nThis server exposes tools in two availability tiers. Channel-gated tools only appear on turns that include a <channel> event from this server; do not call them speculatively. The unsolicited-outbound tool (`send`) is intended to be available regardless of channel context, for cron-fired alerts and autonomous notifications.\n' +
      '\nTools available regardless of channel context:\n' +
      '• `send` — fire an unsolicited outbound message. params: `text` (required), `chat_id` (optional; defaults to the operator self-chat). Use for cron-fired alerts, capital events, autopilot pings.\n' +
      '\nTools attached only on turns that include a <channel> event:\n' +
      '• `reply` — params: `chat_id` (string, the JID from the tag, KEEP the @s.whatsapp.net or @g.us suffix) and `text` (string, the outgoing message). The param is named `text`, not `body`/`message`/`content`.\n' +
      '• `react` — params: `chat_id`, `message_id` (use the `msg_id` attribute from the inbound tag), `emoji` (single emoji, or `""` to remove). For group reactions also pass `participant` (the sender JID). Use react instead of reply when a lightweight ack suffices.\n' +
      '\nKind values:\n' +
      '• `dm` — a 1:1 chat with another contact.\n' +
      '• `group` — a group chat (only forwarded if the operator has opted the group in via /whatsapp:access).\n' +
      '• `self` — the operator messaging their own number ("self-chat"). This is the primary remote-control pattern. Always reply.\n' +
      '• `pairing_request` — a new contact wants to pair. DO NOT auto-approve. Tell the operator in plaintext to run `/whatsapp:access pair <code>` (pulled from the tag). Do not call `reply` for this kind.\n' +
      '\nfrom_me semantics:\n' +
      '• `from_me="1"` on `kind="self"` is normal — that\'s how self-chat looks (the operator typing into their own number). Reply normally.\n' +
      '• `from_me="1"` on `kind="dm"` or `kind="group"` is rare and means the operator typed from their own phone into someone else\'s chat. Don\'t auto-reply unless explicitly addressed.\n' +
      '\nHard rules:\n' +
      '1. The sender (except for kind="self") is on WhatsApp and CANNOT see your terminal output. Plaintext responses here are invisible to them — only the `reply` tool reaches them.\n' +
      '2. Don\'t narrate the inbound back to the operator. The operator can already see the channel line.\n' +
      '3. Permission prompts can be relayed: a trusted sender can reply `yes <id>` or `no <id>` from the same chat to approve/deny tool prompts.',
  },
);

// ── Reply tool ──────────────────────────────────────────────────────────────
// Single module-scoped client handle. Echo dedup, identity (whoami), and
// JID coercion all live inside the client now, so we no longer maintain a
// `sentByBot` Set, a cached selfChatJidRef, or a coerceJid helper for sends.
let waClient = null;

// Thin logging wrapper around client.send. Used by every outbound site
// (tool handlers, permission relay, approval ack, pairing prompt) so the
// `[send]` log format stays consistent. `to` accepts digits or JID — the
// client coerces internally.
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

// ── Approval watcher ────────────────────────────────────────────────────────
// /whatsapp:access pair <code> writes ~/.claude/channels/whatsapp/approved/<senderId>
// with the chatId as the file body. We DM "you're paired" then delete it.
function processApprovals() {
  let entries;
  try {
    entries = readdirSync(APPROVED_DIR);
  } catch {
    return;
  }
  for (const file of entries) {
    const path = join(APPROVED_DIR, file);
    let chatId = '';
    try {
      chatId = readFileSync(path, 'utf8').trim();
    } catch {
      continue;
    }
    if (!chatId || !waClient) continue;
    safeSend(chatId, {
      text: '✅ You are paired with this Claude Code session. Send me a message to get started.',
    })
      .catch((err) => console.warn('approval ack failed:', err.message))
      .finally(() => {
        try { unlinkSync(path); } catch { /* ignore */ }
      });
  }
}

watch(APPROVED_DIR, { persistent: false }, () => processApprovals());

// ── Connect to WhatsApp and wire up message routing ─────────────────────────
const authDir = getAuthDir();

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

  // Catch up on any access.json approvals that landed before the watcher armed.
  processApprovals();

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

    // Permission-verdict path: only honor verdicts from already-trusted senders.
    const verdict = PERMISSION_REPLY_RE.exec(text.trim());
    const trusted = isSelf || access.allowFrom.includes(sender);
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
    // `kind` is already on the InboundEvent; no recomputation needed.
    let allowed = false;
    let pairingCode = null;

    if (isSelf) {
      allowed = true;
    } else if (isGroup) {
      const groupCfg = access.groups[chatId];
      if (groupCfg) {
        const senderOk =
          !groupCfg.allowFrom?.length || groupCfg.allowFrom.includes(sender);
        const mentionOk = groupCfg.requireMention
          ? matchesMention(text, access.mentionPatterns)
          : true;
        allowed = senderOk && mentionOk;
      }
    } else {
      // DM
      if (access.dmPolicy === 'disabled') {
        allowed = false;
      } else if (access.dmPolicy === 'allowlist') {
        allowed = access.allowFrom.includes(sender);
      } else {
        // pairing
        if (access.allowFrom.includes(sender)) {
          allowed = true;
        } else {
          pairingCode = await issuePairingCode(sender, chatId, senderName);
        }
      }
    }

    if (pairingCode) {
      console.warn(`[in] decision=pairing-requested code=${pairingCode} sender=${sender} chat=${chatId}`);
      // Surface the pairing event in the session so Claude can prompt the user
      // (and also DM the requester so they know it's pending).
      await safeSend(chatId, {
        text:
          `Pairing requested. Ask the operator to run:\n` +
          `  /whatsapp:access pair ${pairingCode}\n` +
          `(code expires in 10 minutes)`,
      }).catch(() => {});
      lastInboundChat = { chatId, senderId: sender };
      console.warn(`[in] forward kind=pairing_request chat=${chatId} sender=${sender}`);
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: `New pairing request from ${senderName} (${sender.split('@')[0]}). Run /whatsapp:access pair ${pairingCode} to approve, or /whatsapp:access deny ${pairingCode} to reject.`,
          meta: {
            kind: 'pairing_request',
            chat_id: chatId,
            sender: sender,
            sender_name: senderName,
            pairing_code: pairingCode,
          },
        },
      });
      return;
    }

    if (!allowed) {
      const dropReason = isGroup
        ? (access.groups[chatId] ? 'group-filter-mismatch' : 'group-not-opted-in')
        : (access.dmPolicy === 'disabled' ? 'dm-policy-disabled' : 'dm-not-allowlisted');
      console.warn(`[in] decision=dropped kind=${kind} reason=${dropReason} sender=${sender} chat=${chatId} dmPolicy=${access.dmPolicy}`);
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

function matchesMention(text, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  for (const p of patterns) {
    try {
      if (new RegExp(p, 'i').test(text)) return true;
    } catch {
      /* ignore bad regex */
    }
  }
  return false;
}

async function issuePairingCode(senderId, chatId, senderName) {
  const access = readAccess();
  // Reuse an existing un-expired code for the same sender (don't spam codes).
  const now = Date.now();
  for (const [code, entry] of Object.entries(access.pending || {})) {
    if (entry.senderId === senderId && entry.expiresAt > now) return code;
  }
  // Drop expired entries.
  for (const [code, entry] of Object.entries(access.pending || {})) {
    if (entry.expiresAt <= now) delete access.pending[code];
  }
  let code;
  do {
    code = newPairingCode();
  } while (access.pending[code]);
  access.pending[code] = {
    senderId,
    chatId,
    senderName,
    createdAt: now,
    expiresAt: now + 10 * 60 * 1000,
  };
  writeAccess(access);
  return code;
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
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

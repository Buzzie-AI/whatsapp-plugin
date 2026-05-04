#!/usr/bin/env node
// WhatsApp channel server for Claude Code.
// Connects to WhatsApp through @buzzie-ai/whatsapp-channel (Baileys) and pushes
// inbound messages into the running session as <channel source="whatsapp" ...>.
// Self-chat is auto-allowed; everyone else pairs via /whatsapp:access.

// Keep stdout reserved for MCP JSON-RPC. Anything else goes to stderr.
const _stderr = (...a) =>
  process.stderr.write(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
console.log = _stderr;
console.info = _stderr;
console.warn = _stderr;

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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
  connectAndWait,
  getAuthDir,
} from '@buzzie-ai/whatsapp-channel';

// ── Paths ───────────────────────────────────────────────────────────────────
const CHANNEL_DIR = join(homedir(), '.claude', 'channels', 'whatsapp');
const ACCESS_PATH = join(CHANNEL_DIR, 'access.json');
const APPROVED_DIR = join(CHANNEL_DIR, 'approved');

mkdirSync(CHANNEL_DIR, { recursive: true });
mkdirSync(APPROVED_DIR, { recursive: true });

// ── JID helpers (inlined; not exported by the package) ─────────────────────
const isGroupJid = (jid) => typeof jid === 'string' && jid.endsWith('@g.us');
const jidToPhone = (jid) => (jid ? String(jid).split('@')[0].split(':')[0] : '');

// Strip Baileys' lid suffix (`123:45@s.whatsapp.net` → `123@s.whatsapp.net`).
function normalizeJid(jid) {
  if (!jid) return jid;
  const [user, server] = jid.split('@');
  if (!server) return jid;
  return user.split(':')[0] + '@' + server;
}

// Pull plain text out of a Baileys message. Mirrors the package's extractBody.
function extractBody(msg) {
  const m = msg?.message;
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    ''
  );
}

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
  { name: 'whatsapp', version: '0.2.0' },
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
let safeSend = null; // wired up after Baileys connects
let selfChatJidRef = null; // exposed to `send` tool as the default target

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

// Defensive: Claude may pass a phone number, a partial JID, or strip the
// suffix. Coerce anything plausible to a Baileys-routable JID before sending.
function coerceJid(input) {
  if (!input || typeof input !== 'string') return input;
  const v = input.trim();
  if (v.includes('@')) return v;            // already a JID
  const digits = v.replace(/[^0-9]/g, '');
  if (digits.length >= 7) return digits + '@s.whatsapp.net';
  return v;
}

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (!safeSend) {
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
      const jid = coerceJid(chat_id);
      const sent = await safeSend(jid, { text });
      const sentId = sent?.key?.id || '(no id)';
      console.warn(`[tool] reply → ${jid} sent_id=${sentId}`);
      return { content: [{ type: 'text', text: `sent (id=${sentId} to=${jid})` }] };
    }
    if (name === 'send') {
      const text = args.text ?? args.body ?? args.message ?? args.content;
      if (typeof text !== 'string' || text.length === 0) {
        return { content: [{ type: 'text', text: 'send: missing required `text`.' }], isError: true };
      }
      const rawChat = args.chat_id ?? args.chatId ?? args.jid ?? args.phone ?? selfChatJidRef;
      if (!rawChat) {
        return { content: [{ type: 'text', text: 'send: no `chat_id` provided and self-chat JID not yet known (Baileys not connected?).' }], isError: true };
      }
      const jid = coerceJid(rawChat);
      const sent = await safeSend(jid, { text });
      const sentId = sent?.key?.id || '(no id)';
      console.warn(`[tool] send → ${jid} sent_id=${sentId}`);
      return { content: [{ type: 'text', text: `sent (id=${sentId} to=${jid})` }] };
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
      const jid = coerceJid(chat_id);
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
  if (!target || !safeSend) return;
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
    if (!chatId || !safeSend) continue;
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

  let sock;
  try {
    sock = await connectAndWait({ authDir, printQr: false, syncFullHistory: false });
    await sock.sendPresenceUpdate('available');
  } catch (err) {
    console.error('Failed to connect to WhatsApp:', err.message);
    return;
  }

  const selfJid = normalizeJid(sock.user?.id || '');
  const selfPhone = jidToPhone(selfJid);
  const selfChatJid = `${selfPhone}@s.whatsapp.net`;
  selfChatJidRef = selfChatJid;
  // WhatsApp's LID system: self-chat may arrive on `<lid>@lid` instead of the
  // legacy `<phone>@s.whatsapp.net`. We detect both inbound, but always send
  // outbound to the PN form so messages land in the user's visible self-chat.
  const selfLidRaw = sock.user?.lid || null;
  const selfChatLid = selfLidRaw
    ? selfLidRaw.split(':')[0].split('@')[0] + '@lid'
    : null;
  console.warn(
    `Connected as ${selfPhone}${selfChatLid ? ` (lid: ${selfChatLid})` : ''}`,
  );

  // Track bot's own outgoing message ids to prevent re-processing as inbound.
  const sentByBot = new Set();
  safeSend = async (jid, content, options) => {
    const kind = content.text ? 'text' : content.react ? 'react' : 'media';
    const preview = content.text ? content.text.slice(0, 60) : '';
    console.warn(`[send] to=${jid} kind=${kind}${preview ? ` "${preview}"` : ''}`);
    try {
      const sent = await sock.sendMessage(jid, content, options);
      const id = sent?.key?.id;
      if (id) sentByBot.add(id);
      console.warn(`[send] result id=${id || '(none)'} status=${sent?.status ?? 'n/a'}`);
      return sent;
    } catch (err) {
      console.warn(`[send] FAILED to=${jid}: ${err.message}`);
      throw err;
    }
  };

  // Catch up on any access.json approvals that landed before the watcher armed.
  processApprovals();

  const startTs = Math.floor(Date.now() / 1000);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      try {
        await handleInbound(msg);
      } catch (err) {
        console.warn('handleInbound error:', err.message);
      }
    }
  });

  async function handleInbound(msg) {
    if (!msg.message) return;
    const rawJid = msg.key.remoteJid;
    if (!rawJid) return;

    // Skip our own outgoing messages (acks, bot replies).
    if (msg.key.id && sentByBot.has(msg.key.id)) {
      sentByBot.delete(msg.key.id);
      return;
    }

    // Skip history-sync replays.
    const ts = Number(msg.messageTimestamp || 0);
    if (ts && ts < startTs - 5) return;

    const text = extractBody(msg);
    if (!text) return; // ignore reactions, media without captions, etc. for now

    const isGroup = isGroupJid(rawJid);
    const isSelfRaw =
      (rawJid === selfChatJid || (selfChatLid && rawJid === selfChatLid)) &&
      msg.key.fromMe;
    // Canonicalize self-chat to the PN form so reply tool / pairing acks
    // always target the user's visible self-chat, not the LID twin.
    const chatId = isSelfRaw ? selfChatJid : rawJid;
    const isSelf = isSelfRaw;

    // Sender JID: in groups it's `participant`; in DMs it's the chat JID.
    const senderRaw = msg.key.fromMe
      ? selfChatJid
      : (isGroup ? (msg.key.participant || rawJid) : rawJid);
    const sender = normalizeJid(senderRaw);
    const senderName = msg.pushName || jidToPhone(sender);

    const access = readAccess();

    // Permission-verdict path: only honor verdicts from already-trusted senders.
    const verdict = PERMISSION_REPLY_RE.exec(text.trim());
    const trusted = isSelf || access.allowFrom.includes(sender);
    if (verdict && trusted) {
      const requestId = verdict[2].toLowerCase();
      const open = pendingPermissions.get(requestId);
      if (open && open.chatId === chatId) {
        await mcp.notification({
          method: 'notifications/claude/channel/permission',
          params: {
            request_id: requestId,
            behavior: verdict[1].toLowerCase().startsWith('y') ? 'allow' : 'deny',
          },
        });
        pendingPermissions.delete(requestId);
        return;
      }
    }

    // ── Decide whether to forward ──
    let kind = isSelf ? 'self' : isGroup ? 'group' : 'dm';
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
      // Surface the pairing event in the session so Claude can prompt the user
      // (and also DM the requester so they know it's pending).
      await safeSend(chatId, {
        text:
          `Pairing requested. Ask the operator to run:\n` +
          `  /whatsapp:access pair ${pairingCode}\n` +
          `(code expires in 10 minutes)`,
      }).catch(() => {});
      lastInboundChat = { chatId, senderId: sender };
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: `New pairing request from ${senderName} (${jidToPhone(sender)}). Run /whatsapp:access pair ${pairingCode} to approve, or /whatsapp:access deny ${pairingCode} to reject.`,
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

    if (!allowed) return; // silent drop

    // Track most recent trusted chat for permission relay routing.
    lastInboundChat = { chatId, senderId: sender };

    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: text,
        meta: {
          kind,
          chat_id: chatId,
          sender,
          sender_name: senderName,
          msg_id: msg.key.id || '',
          from_me: msg.key.fromMe ? '1' : '0',
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

#!/usr/bin/env node
/**
 * MCP (stdio) wrapper around the chatroom client, for agents that prefer MCP
 * tools over the CLI. Note: chatroom_wait is a single long-poll bounded by the
 * MCP client's tool timeout — the blocking CLI (`chatroom wait`) is the more
 * reliable way to stay resident; this is the secondary integration path.
 *
 * State file: $CHATROOM_STATE (default ./.chatroom-state.json), shared with the CLI.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { readFileSync, writeFileSync } from 'node:fs'
import { z } from 'zod'
import { ChatroomClient } from './client.js'

const statePath = process.env.CHATROOM_STATE ?? './.chatroom-state.json'
// default server so agents don't have to guess the port; override with CHATROOM_SERVER
const DEFAULT_SERVER = process.env.CHATROOM_SERVER || 'http://localhost:8787'

function loadState() {
  try {
    return JSON.parse(readFileSync(statePath, 'utf-8'))
  } catch {
    throw new Error(`no state file at ${statePath} — call chatroom_join first`)
  }
}

/**
 * Resolve a client for a stateful tool call. Pass server+room_id+token together
 * to run statelessly — the caller owns its identity, which is required when
 * several sessions share one state file path. Omit all three to use the file.
 */
function clientFor({ server, room_id, token }) {
  if (server || room_id || token) {
    // all-or-nothing: a partial set would silently fall back to the file and act as the wrong identity
    if (!server || !room_id || !token) throw new Error('pass server, room_id and token together for stateless mode')
    return new ChatroomClient({ server, room_id, token })
  }
  return new ChatroomClient(loadState())
}

/** Optional identity args shared by the stateful tools (see clientFor). */
const identityArgs = {
  server: z.string().optional().describe('with room_id+token, run statelessly; omit all three to use the state file'),
  room_id: z.string().optional(),
  token: z.string().optional().describe('your identity token from chatroom_join — remember it for stateless calls'),
}

function text(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] }
}

const server = new McpServer({ name: 'chatroom', version: '0.1.0' })

server.registerTool(
  'chatroom_list_rooms',
  {
    description: 'List rooms (topics) on a chatroom server.',
    inputSchema: {
      server: z.string().default(DEFAULT_SERVER).describe('chatroom server URL; defaults to http://localhost:8787'),
    },
  },
  async ({ server: url }) => text(await new ChatroomClient({ server: url }).listRooms()),
)

server.registerTool(
  'chatroom_list_personas',
  {
    description: 'List persona presets available on a chatroom server.',
    inputSchema: { server: z.string().default(DEFAULT_SERVER).describe('chatroom server URL; defaults to http://localhost:8787') },
  },
  async ({ server: url }) => text(await new ChatroomClient({ server: url }).listPersonas()),
)

server.registerTool(
  'chatroom_join',
  {
    description:
      'Join (or rejoin) a chatroom. Saves identity + cursor to the state file AND ' +
      'returns your token, so you can either rely on the file or remember server+room_id+token ' +
      'and pass them to the other tools (stateless mode, safe for concurrent sessions). ' +
      'Returns your uid, nickname and the persona system prompt you must adopt. ' +
      'When you omit nickname and join without a persona, pass `agent` and `model` so you get a ' +
      'readable name like "claude-opus" instead of a random suffix.',
    inputSchema: {
      server: z.string().default(DEFAULT_SERVER).describe('chatroom server URL; defaults to http://localhost:8787'),
      room_id: z.string(),
      nickname: z.string().optional().describe('omit to auto-generate from the persona, or from agent+model'),
      agent: z.string().optional().describe('your agent/runtime name, e.g. "claude", "pi" — used to name you when nickname is omitted'),
      model: z.string().optional().describe('short alphanumeric model abbreviation, e.g. "opus46" (Opus 4.6), "dsv4p" (DeepSeek V4 Pro), "sonnet46". Combined with agent into nickname like "claude-opus46". Use only [a-zA-Z0-9], no spaces or special chars.'),
      persona_id: z.string().optional(),
      token: z.string().optional().describe('pass a previous token to rejoin without reading the state file'),
    },
  },
  async ({ server: url, room_id, nickname, agent, model, persona_id, token }) => {
    let prevToken = token
    if (!prevToken) {
      try {
        const prev = JSON.parse(readFileSync(statePath, 'utf-8'))
        if (prev.room_id === room_id && prev.server === url) prevToken = prev.token
      } catch {
        /* fresh join */
      }
    }
    const client = new ChatroomClient({ server: url })
    const nicknameHint = [agent, model].filter(Boolean).join('-') || undefined
    const joined = await client.join({ roomId: room_id, nickname, personaId: persona_id, token: prevToken, nicknameHint })
    writeFileSync(
      statePath,
      JSON.stringify(
        { server: url, room_id, uid: joined.uid, token: joined.token, nickname: joined.nickname, type: joined.type },
        null,
        2,
      ),
    )
    return text({
      uid: joined.uid,
      token: joined.token,
      server: url,
      room_id,
      nickname: joined.nickname,
      rejoined: joined.rejoined,
      cursor: joined.last_acked_seq,
      persona: joined.persona ? { name: joined.persona.name, system_prompt: joined.persona.system_prompt } : null,
      next: 'call chatroom_wait in a loop; reply to events marked mentions_you (and not replied_by_you) via chatroom_post, then chatroom_ack. For concurrent sessions, pass server+room_id+token to those tools instead of relying on the shared state file.',
    })
  },
)

server.registerTool(
  'chatroom_wait',
  {
    description:
      'Long-poll once for new @mentions of you. Returns {woke:false} when nothing arrived within the window ' +
      '(call it again), or the full event backlog since your cursor when someone mentioned you.',
    inputSchema: {
      window_sec: z.number().int().min(1).max(55).optional().describe('poll window seconds, default 25'),
      ...identityArgs,
    },
  },
  async ({ window_sec, server, room_id, token }) =>
    text(await clientFor({ server, room_id, token }).waitOnce((window_sec ?? 25) * 1000)),
)

server.registerTool(
  'chatroom_post',
  {
    description:
      'Send a message to the room. Mention members by writing @nickname in the text. ' +
      'When replying to a mention, ALWAYS pass reply_to=<msg_id of the message you answer> for dedup.',
    inputSchema: { text: z.string(), reply_to: z.string().optional(), ...identityArgs },
  },
  async ({ text: body, reply_to, server, room_id, token }) =>
    text(await clientFor({ server, room_id, token }).post({ text: body, replyTo: reply_to })),
)

server.registerTool(
  'chatroom_ack',
  {
    description: 'Advance your read cursor after handling a backlog (pass the latest_seq from chatroom_wait).',
    inputSchema: { seq: z.number().int(), ...identityArgs },
  },
  async ({ seq, server, room_id, token }) => text(await clientFor({ server, room_id, token }).ack(seq)),
)

server.registerTool(
  'chatroom_history',
  {
    description: 'Read room events without waiting (catch up on context).',
    inputSchema: { after: z.number().int().optional(), limit: z.number().int().optional(), ...identityArgs },
  },
  async ({ after, limit, server, room_id, token }) =>
    text(await clientFor({ server, room_id, token }).history({ after, limit })),
)

server.registerTool(
  'chatroom_members',
  {
    description: 'List room members with online status.',
    inputSchema: { ...identityArgs },
  },
  async ({ server, room_id, token }) => text(await clientFor({ server, room_id, token }).members()),
)

await server.connect(new StdioServerTransport())

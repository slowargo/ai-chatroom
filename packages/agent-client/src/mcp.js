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

function loadState() {
  try {
    return JSON.parse(readFileSync(statePath, 'utf-8'))
  } catch {
    throw new Error(`no state file at ${statePath} — call chatroom_join first`)
  }
}

function text(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] }
}

const server = new McpServer({ name: 'chatroom', version: '0.1.0' })

server.registerTool(
  'chatroom_list_rooms',
  {
    description: 'List rooms (topics) on a chatroom server.',
    inputSchema: { server: z.string().describe('chatroom server URL, e.g. http://localhost:8787') },
  },
  async ({ server: url }) => text(await new ChatroomClient({ server: url }).listRooms()),
)

server.registerTool(
  'chatroom_list_personas',
  {
    description: 'List persona presets available on a chatroom server.',
    inputSchema: { server: z.string() },
  },
  async ({ server: url }) => text(await new ChatroomClient({ server: url }).listPersonas()),
)

server.registerTool(
  'chatroom_join',
  {
    description:
      'Join (or rejoin) a chatroom. Saves identity + cursor to the state file. ' +
      'Returns your uid, nickname and the persona system prompt you must adopt.',
    inputSchema: {
      server: z.string(),
      room_id: z.string(),
      nickname: z.string().optional().describe('omit to auto-generate from the persona'),
      persona_id: z.string().optional(),
    },
  },
  async ({ server: url, room_id, nickname, persona_id }) => {
    let prevToken
    try {
      const prev = JSON.parse(readFileSync(statePath, 'utf-8'))
      if (prev.room_id === room_id && prev.server === url) prevToken = prev.token
    } catch {
      /* fresh join */
    }
    const client = new ChatroomClient({ server: url })
    const joined = await client.join({ roomId: room_id, nickname, personaId: persona_id, token: prevToken })
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
      nickname: joined.nickname,
      rejoined: joined.rejoined,
      cursor: joined.last_acked_seq,
      persona: joined.persona ? { name: joined.persona.name, system_prompt: joined.persona.system_prompt } : null,
      next: 'call chatroom_wait in a loop; reply to events marked mentions_you (and not replied_by_you) via chatroom_post, then chatroom_ack.',
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
    },
  },
  async ({ window_sec }) => text(await new ChatroomClient(loadState()).waitOnce((window_sec ?? 25) * 1000)),
)

server.registerTool(
  'chatroom_post',
  {
    description:
      'Send a message to the room. Mention members by writing @nickname in the text. ' +
      'When replying to a mention, ALWAYS pass reply_to=<msg_id of the message you answer> for dedup.',
    inputSchema: { text: z.string(), reply_to: z.string().optional() },
  },
  async ({ text: body, reply_to }) => text(await new ChatroomClient(loadState()).post({ text: body, replyTo: reply_to })),
)

server.registerTool(
  'chatroom_ack',
  {
    description: 'Advance your read cursor after handling a backlog (pass the latest_seq from chatroom_wait).',
    inputSchema: { seq: z.number().int() },
  },
  async ({ seq }) => text(await new ChatroomClient(loadState()).ack(seq)),
)

server.registerTool(
  'chatroom_history',
  {
    description: 'Read room events without waiting (catch up on context).',
    inputSchema: { after: z.number().int().optional(), limit: z.number().int().optional() },
  },
  async ({ after, limit }) => text(await new ChatroomClient(loadState()).history({ after, limit })),
)

server.registerTool(
  'chatroom_members',
  {
    description: 'List room members with online status.',
    inputSchema: {},
  },
  async () => text(await new ChatroomClient(loadState()).members()),
)

await server.connect(new StdioServerTransport())

#!/usr/bin/env node
/**
 * MCP (stdio) wrapper around the chatroom client, for agents that prefer MCP
 * tools over the CLI. chatroom_wait blocks until you are mentioned: it loops
 * internally over ~110s long-poll shards (under the host's ~120s transport idle
 * wall), auto-reconnects through transient outages, and wires the host's
 * AbortSignal (extra.signal) so a cancelled tool call closes the /wait cleanly.
 * It shares the same client.waitForMention as `ai-chatroom wait`, so this is a
 * first-class resident path — not a degraded fallback.
 *
 * Stateless mode only: pass server, room_id and token to every tool call.
 * There is no shared state file — each session owns its own identity.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { ChatroomClient } from './client.js'
import { getPasswordForServer, loadConfig } from './config.js'
import { ADDRESSING_GUIDANCE, WAIT_RETRY_GUIDANCE } from './guidance.js'

// default server so agents don't have to guess the port; override with CHATROOM_SERVER
const DEFAULT_SERVER = process.env.CHATROOM_SERVER || 'http://localhost:8787'

/** Required identity args for all authenticated tools. */
const identityArgs = {
  server: z.string().describe('chatroom server URL, e.g. http://localhost:8787'),
  room_id: z.string().describe('room id to operate in'),
  token: z.string().describe('your identity token from chatroom_join'),
}

const passwordArg = {
  password: z.string().optional().describe('access password for the server; auto-loaded from ~/.ai-chatroom/config.json if omitted'),
}

function text(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] }
}

function resolvePassword(serverUrl, explicitPassword) {
  return explicitPassword ?? getPasswordForServer(serverUrl) ?? undefined
}

function makeClient(opts) {
  return new ChatroomClient({
    server: opts.server,
    room_id: opts.room_id,
    token: opts.token,
    password: resolvePassword(opts.server, opts.password),
  })
}

const server = new McpServer({ name: 'chatroom', version: '0.1.0' })

server.registerTool(
  'chatroom_list_rooms',
  {
    description: 'List rooms (topics) on a chatroom server.',
    inputSchema: {
      server: z.string().default(DEFAULT_SERVER).describe('chatroom server URL; defaults to http://localhost:8787'),
      ...passwordArg,
    },
  },
  async ({ server: url, password }) => text(await new ChatroomClient({ server: url, password: resolvePassword(url, password) }).listRooms()),
)

server.registerTool(
  'chatroom_list_personas',
  {
    description: 'List persona presets available on a chatroom server.',
    inputSchema: {
      server: z.string().default(DEFAULT_SERVER).describe('chatroom server URL; defaults to http://localhost:8787'),
      ...passwordArg,
    },
  },
  async ({ server: url, password }) => text(await new ChatroomClient({ server: url, password: resolvePassword(url, password) }).listPersonas()),
)

server.registerTool(
  'chatroom_join',
  {
    description:
      'Join (or rejoin) a chatroom. Returns your token and identity on success. ' +
      'If the server requires admin approval (agent without a prior token), returns ' +
      '{status:"pending", request_id} — call chatroom_join_poll with the request_id to wait for approval. ' +
      'Returns your uid, nickname and the persona system prompt you must adopt. ' +
      'When you omit nickname and join without a persona, pass `agent` and `model` so you get a ' +
      'readable name (e.g. "pi-claude-sonnet") instead of a random suffix. ' +
      'Only set `model` if you know your actual model — do NOT invent one. ' +
      'You may omit room_id and pass cwd instead — the server will find the room bound to that directory. ' +
      'If no matching room is found, run `ai-chatroom init` in that directory first. ' +
      'After joining, automatically call chatroom_wait to listen for mentions.',
    inputSchema: {
      server: z.string().default(DEFAULT_SERVER).describe('chatroom server URL; defaults to http://localhost:8787'),
      room_id: z.string().optional().describe('room id; omit when using cwd-based auto-resolution'),
      cwd: z.string().optional().describe('working directory path; used to resolve the room when room_id is omitted'),
      nickname: z.string().optional().describe('omit to auto-generate from the persona, or from agent+model'),
      agent: z.string().optional().describe('your agent/runtime name, e.g. "claude", "pi" — used to name you when nickname is omitted'),
      model: z.string().optional().describe('short alphanumeric model abbreviation (only if known), e.g. "sonnet4" (Claude Sonnet 4), "opus4" (Claude Opus 4), "gpt4o" (GPT-4o), "dsv3" (DeepSeek V3). Combined with agent into nickname like "pi-sonnet4". Use only [a-zA-Z0-9-], no spaces or special chars. Omit this parameter entirely if you don\'t know your model — do NOT invent one.'),
      persona_id: z.string().optional(),
      token: z.string().optional().describe('pass a previous token to rejoin as an existing identity'),
      ...passwordArg,
    },
  },
  async ({ server: url, room_id, cwd, nickname, agent, model, persona_id, token, password }) => {
    const pw = resolvePassword(url, password)
    let resolvedRoomId = room_id

    if (!resolvedRoomId) {
      if (!cwd) {
        return text({ error: 'either room_id or cwd is required; run `ai-chatroom init` in your project directory first' })
      }
      const config = loadConfig()
      const machineId = config.machine_id ?? undefined
      const lookupClient = new ChatroomClient({ server: url, password: pw })
      let room
      try {
        room = await lookupClient.resolveRoom(cwd, machineId)
      } catch (err) {
        if (err.status === 404) {
          return text({ error: `no room found for cwd="${cwd}". Run \`ai-chatroom init --server ${url}\` in that directory first.` })
        }
        throw err
      }
      resolvedRoomId = room.id
    }

    const client = new ChatroomClient({ server: url, password: pw })
    const nicknameHint = [agent, model].filter(Boolean).join('-') || undefined
    const joined = await client.join({ roomId: resolvedRoomId, nickname, personaId: persona_id, token, nicknameHint })
    // pending approval — agent must poll
    if (joined.status === 'pending') {
      return text({
        status: 'pending',
        request_id: joined.request_id,
        next: `Your join request is pending admin approval. Call chatroom_join_poll with server="${url}", room_id="${resolvedRoomId}", request_id="${joined.request_id}" immediately, then use exponential backoff (2s, 4s, 8s…) between retries until you receive status "approved" or "rejected".`,
      })
    }
    return text({
      uid: joined.uid,
      token: joined.token,
      server: url,
      room_id: resolvedRoomId,
      nickname: joined.nickname,
      rejoined: joined.rejoined,
      cursor: joined.last_acked_seq,
      persona: joined.persona ? { name: joined.persona.name, system_prompt: joined.persona.system_prompt } : null,
      etiquette: ADDRESSING_GUIDANCE,
      next: 'Adopt the persona system_prompt (if any) AND the `etiquette` rule above as standing rules for this room. ' +
        'Automatically call chatroom_wait now to listen for mentions in a loop. ' + WAIT_RETRY_GUIDANCE + ' ' +
        'When a message genuinely calls for your response: ' +
        '1) chatroom_ack with latest_seq, 2) chatroom_post your reply with reply_to=<msg_id>, 3) loop back to chatroom_wait. ' +
        'If a message only mentions you in passing (someone else is the one being asked), just chatroom_ack and call chatroom_wait again without posting. ' +
        'ALWAYS use chatroom_post to send replies — do NOT just output text as the agent response.',
    })
  },
)

server.registerTool(
  'chatroom_join_poll',
  {
    description:
      'Poll for the result of a pending join request (up to 60s long-poll). ' +
      'Call this after chatroom_join returns {status:"pending"}. ' +
      'Returns {status:"pending"} if still waiting, ' +
      '{status:"approved", uid, token, nickname, ...} on approval, ' +
      'or {status:"rejected", reason?} on rejection. ' +
      'Use exponential backoff between calls: first call immediately, then wait 2s, 4s, 8s, etc.',
    inputSchema: {
      server: z.string().describe('chatroom server URL'),
      room_id: z.string().describe('room id from chatroom_join'),
      request_id: z.string().describe('request_id from chatroom_join pending response'),
      ...passwordArg,
    },
  },
  async ({ server: url, room_id, request_id, password }) => {
    const client = new ChatroomClient({ server: url, password: resolvePassword(url, password) })
    const result = await client.pollPendingJoin({ roomId: room_id, requestId: request_id })
    if (result.status === 'approved') {
      return text({
        ...result,
        etiquette: ADDRESSING_GUIDANCE,
        next: `Join approved! You are now "${result.assigned_nickname}" (uid: ${result.assigned_uid}). Use token="${result.token}" with server="${url}" and room_id="${room_id}". ` +
          'Adopt the `etiquette` rule above as a standing rule for this room. Now automatically call chatroom_wait to start listening for mentions. ' +
          WAIT_RETRY_GUIDANCE,
      })
    }
    if (result.status === 'rejected') {
      return text({ ...result, next: `Join rejected. Reason: ${result.reason ?? 'none'}. You may try chatroom_join again.` })
    }
    // still pending
    return text({ ...result, next: `Still pending. Call chatroom_join_poll again with the same request_id.` })
  },
)

server.registerTool(
  'chatroom_wait',
  {
    description:
      'Block until someone @mentions you, then return the full event backlog since your cursor. ' +
      'The call stays open across internal poll cycles and auto-reconnects through transient server outages — ' +
      'it returns only when you are genuinely mentioned, or {woke:false, aborted:true} if the host cancels the call (then call it again to resume).',
    inputSchema: {
      window_sec: z
        .number()
        .int()
        .min(1)
        .max(995)
        .optional()
        .describe(
          'internal long-poll shard in seconds (NOT the total block time — the call blocks until woken regardless). ' +
          'Keep it under the MCP host transport idle limit (~120s on Claude Code) so each shard returns cleanly instead of being cut mid-connection; default 110',
        ),
      ...identityArgs,
      ...passwordArg,
    },
  },
  async ({ window_sec, server, room_id, token, password }, extra) => {
    const result = await makeClient({ server, room_id, token, password }).waitForMention({
      windowMs: (window_sec ?? 110) * 1000,
      signal: extra?.signal,
      // backstop: if an abort ever arrives as a bare error without aborting the
      // signal, give up after a bounded error storm instead of orphaning the loop.
      maxConsecutiveRetries: 10,
    })
    // null => the host cancelled the tool call; waitForMention closed the long-poll cleanly (no orphan).
    if (!result) {
      return text({
        woke: false,
        aborted: true,
        next: 'Wait was cancelled by the host. Call chatroom_wait again to resume listening.',
      })
    }
    // waitForMention only resolves on a real wake, so result.woke is true here.
    // Add actionable next steps when there are mentions to reply to
    const mentionsYou = result.events?.filter(e => e.mentions_you && !e.replied_by_you) || []
    if (mentionsYou.length > 0) {
      result.next = `You have ${mentionsYou.length} message(s) mentioning you. ${ADDRESSING_GUIDANCE} ` +
        'For each message that does call for your response: 1) chatroom_ack with latest_seq, 2) chatroom_post your reply with reply_to=<msg_id>, 3) chatroom_wait for more. ' +
        'For any that do not, just chatroom_ack with latest_seq and chatroom_wait again. Always use chatroom_post to send replies — do NOT just output text.'
    }
    return text(result)
  },
)

server.registerTool(
  'chatroom_post',
  {
    description:
      'Send a message to the room. Mention members by writing @nickname in the text. ' +
      'When replying to a mention, ALWAYS pass reply_to=<msg_id of the message you answer> for dedup.',
    inputSchema: { text: z.string(), reply_to: z.string().optional(), ...identityArgs, ...passwordArg },
  },
  async ({ text: body, reply_to, server, room_id, token, password }) =>
    text(await makeClient({ server, room_id, token, password }).post({ text: body, replyTo: reply_to })),
)

server.registerTool(
  'chatroom_ack',
  {
    description: 'Advance your read cursor after handling a backlog (pass the latest_seq from chatroom_wait).',
    inputSchema: { seq: z.number().int(), ...identityArgs, ...passwordArg },
  },
  async ({ seq, server, room_id, token, password }) =>
    text(await makeClient({ server, room_id, token, password }).ack(seq)),
)

server.registerTool(
  'chatroom_history',
  {
    description: 'Read room events without waiting (catch up on context).',
    inputSchema: { after: z.number().int().optional(), limit: z.number().int().optional(), ...identityArgs, ...passwordArg },
  },
  async ({ after, limit, server, room_id, token, password }) =>
    text(await makeClient({ server, room_id, token, password }).history({ after, limit })),
)

server.registerTool(
  'chatroom_members',
  {
    description: 'List room members with online status.',
    inputSchema: { ...identityArgs, ...passwordArg },
  },
  async ({ server, room_id, token, password }) =>
    text(await makeClient({ server, room_id, token, password }).members()),
)

await server.connect(new StdioServerTransport())

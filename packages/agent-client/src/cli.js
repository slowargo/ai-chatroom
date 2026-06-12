#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { ChatroomClient } from './client.js'

const USAGE = `chatroom — agent client for ai-chatroom

usage:
  chatroom rooms     --server URL                 list rooms
  chatroom personas  --server URL                 list persona presets
  chatroom join      --server URL --room ID [--nickname N] [--persona ID] [--type agent|human]
                                                  join (or rejoin) a room; writes the state file
  chatroom wait      [--once] [--window-sec N] [--json]
                                                  block until someone @mentions you, then print
                                                  the backlog since your cursor and exit
  chatroom post      --text TEXT [--reply-to MSG_ID]   send a message ("-" reads stdin)
  chatroom ack       --seq N                      advance your cursor past handled events
  chatroom history   [--after N] [--limit N]      read events without waiting
  chatroom members                                list members and online status
  chatroom whoami                                 show identity from the state file

state file: --state PATH | $CHATROOM_STATE | ./.chatroom-state.json
            (one state file per agent; use distinct files for multiple agents on one machine)`

const { positionals, values: flags } = parseArgs({
  allowPositionals: true,
  options: {
    server: { type: 'string' },
    room: { type: 'string' },
    nickname: { type: 'string' },
    persona: { type: 'string' },
    type: { type: 'string', default: 'agent' },
    state: { type: 'string' },
    text: { type: 'string' },
    'reply-to': { type: 'string' },
    seq: { type: 'string' },
    after: { type: 'string' },
    limit: { type: 'string' },
    'window-sec': { type: 'string' },
    once: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
})

const cmd = positionals[0]
const statePath = flags.state ?? process.env.CHATROOM_STATE ?? './.chatroom-state.json'

function loadState() {
  try {
    return JSON.parse(readFileSync(statePath, 'utf-8'))
  } catch {
    fail(`no state file at ${statePath} — run \`chatroom join\` first (or pass --state)`)
  }
}

function fail(msg) {
  console.error(`error: ${msg}`)
  process.exit(1)
}

function clientFromState() {
  return new ChatroomClient(loadState())
}

function formatEvent(ev, uidToNick, myUid) {
  const who = ev.sender_uid ? (uidToNick.get(ev.sender_uid) ?? ev.sender_uid) : 'system'
  const marks = []
  if (ev.mentions_you) marks.push(ev.replied_by_you ? 'mentions you — already replied, skip it' : 'MENTIONS YOU')
  if (ev.muted) marks.push('muted by brake')
  if (ev.sender_uid === myUid) marks.push('your own message')
  const mark = marks.length > 0 ? `   <-- ${marks.join('; ')}` : ''
  if (ev.kind === 'message') return `[seq ${ev.seq}] [${ev.msg_id}] ${who}: ${ev.text}${mark}`
  return `[seq ${ev.seq}] (${ev.kind}) ${ev.text ?? JSON.stringify(ev.payload)}`
}

async function printBacklog(client, res, state) {
  const members = await client.members().catch(() => [])
  const uidToNick = new Map(members.map((m) => [m.uid, `${m.nickname} (${m.type})`]))
  for (const ev of res.events) console.log(formatEvent(ev, uidToNick, state.uid))
  console.log('---')
  console.log(`latest_seq: ${res.latest_seq}`)
  console.log(
    `next: reply to the marked messages with \`chatroom post --text "..." --reply-to <msg_id>\`,` +
      ` then run \`chatroom ack --seq ${res.latest_seq}\` and \`chatroom wait\` again.`,
  )
}

const commands = {
  async rooms() {
    if (!flags.server) fail('--server is required')
    const rooms = await new ChatroomClient({ server: flags.server }).listRooms()
    if (flags.json) return console.log(JSON.stringify(rooms, null, 2))
    for (const r of rooms) console.log(`${r.id}  [${r.last_seq} events]  ${r.title || '(untitled)'}`)
  },

  async personas() {
    if (!flags.server) fail('--server is required')
    const personas = await new ChatroomClient({ server: flags.server }).listPersonas()
    if (flags.json) return console.log(JSON.stringify(personas, null, 2))
    for (const p of personas) console.log(`${p.id}  ${p.name}`)
  },

  async join() {
    if (!flags.server || !flags.room) fail('--server and --room are required')
    let prevToken
    try {
      const prev = JSON.parse(readFileSync(statePath, 'utf-8'))
      if (prev.room_id === flags.room && prev.server === flags.server) prevToken = prev.token
    } catch {
      /* fresh join */
    }
    const client = new ChatroomClient({ server: flags.server })
    const joined = await client.join({
      roomId: flags.room,
      nickname: flags.nickname,
      type: flags.type,
      personaId: flags.persona,
      token: prevToken,
    })
    const state = {
      server: flags.server,
      room_id: flags.room,
      uid: joined.uid,
      token: joined.token,
      nickname: joined.nickname,
      type: joined.type,
    }
    writeFileSync(statePath, JSON.stringify(state, null, 2))
    console.log(`${joined.rejoined ? 'rejoined' : 'joined'} room ${flags.room} as "${joined.nickname}" (uid ${joined.uid})`)
    console.log(`state saved to ${statePath}; cursor at seq ${joined.last_acked_seq}`)
    if (joined.persona) {
      console.log(`\npersona "${joined.persona.name}" — adopt this role in all your replies:`)
      console.log(joined.persona.system_prompt)
    }
    console.log('\nnow run `chatroom wait` (blocking) to receive mentions.')
  },

  async wait() {
    const state = loadState()
    const client = clientFromState()
    const windowMs = flags['window-sec'] ? Number(flags['window-sec']) * 1000 : 25_000
    let res
    if (flags.once) {
      res = await client.waitOnce(windowMs)
      if (!res.woke) {
        console.log('(no mention within the window)')
        process.exit(2)
      }
    } else {
      res = await client.waitForMention({
        windowMs,
        onRetry: (err) => console.error(`(server unreachable: ${err.message} — retrying)`),
      })
    }
    if (flags.json) return console.log(JSON.stringify(res, null, 2))
    await printBacklog(client, res, state)
  },

  async post() {
    let text = flags.text
    if (text === '-') text = readFileSync(0, 'utf-8')
    if (!text?.trim()) fail('--text is required ("-" reads stdin)')
    const res = await clientFromState().post({ text: text.trim(), replyTo: flags['reply-to'] })
    console.log(`sent msg_id=${res.msg_id} seq=${res.seq}${res.muted ? ' (muted by brake: mentions will not wake agents)' : ''}`)
  },

  async ack() {
    if (!flags.seq) fail('--seq is required')
    const res = await clientFromState().ack(Number(flags.seq))
    console.log(`cursor at seq ${res.last_acked_seq}`)
  },

  async history() {
    const state = loadState()
    const client = clientFromState()
    const res = await client.history({
      after: flags.after ? Number(flags.after) : 0,
      limit: flags.limit ? Number(flags.limit) : 200,
    })
    if (flags.json) return console.log(JSON.stringify(res, null, 2))
    const members = await client.members().catch(() => [])
    const uidToNick = new Map(members.map((m) => [m.uid, `${m.nickname} (${m.type})`]))
    for (const ev of res.events) console.log(formatEvent(ev, uidToNick, state.uid))
  },

  async members() {
    const members = await clientFromState().members()
    if (flags.json) return console.log(JSON.stringify(members, null, 2))
    for (const m of members) {
      console.log(`${m.online ? '●' : '○'} ${m.nickname} (${m.type}${m.persona_name ? `, ${m.persona_name}` : ''})  uid=${m.uid}`)
    }
  },

  async whoami() {
    const state = loadState()
    console.log(JSON.stringify(state, null, 2))
  },
}

if (!cmd || flags.help || !commands[cmd]) {
  console.log(USAGE)
  process.exit(cmd && !flags.help ? 1 : 0)
}

commands[cmd]().catch((err) => fail(err.message))

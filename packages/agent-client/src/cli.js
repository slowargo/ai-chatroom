#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { ChatroomClient } from './client.js'
import { CONFIG_PATH, ensureMachineId, getPasswordForServer, loadConfig, resolveServer, saveConfig } from './config.js'

const USAGE = `ai-chatroom — agent client for ai-chatroom

usage:
  ai-chatroom init      [--server URL] [--cwd PATH] [--title TEXT] [--password PW]
                                                  create a room bound to the current directory
  ai-chatroom rooms     [--server URL]              list rooms
  ai-chatroom personas  [--server URL]              list persona presets
  ai-chatroom join      [--server URL] --room ID [--nickname N] [--persona ID] [--type agent|human]
                                                  join (or rejoin) a room; writes the state file
  ai-chatroom wait      [--once] [--window-sec N] [--json]
                                                  block until someone @mentions you, then print
                                                  the backlog since your cursor and exit
  ai-chatroom post      --text TEXT [--reply-to MSG_ID]   send a message ("-" reads stdin)
  ai-chatroom ack       --seq N                   advance your cursor past handled events
  ai-chatroom history   [--after N] [--limit N]   read events without waiting
  ai-chatroom members                             list members and online status
  ai-chatroom whoami                              show identity from the state file

  ai-chatroom config init                         create a template config file
  ai-chatroom config show                         show current config (passwords masked)
  ai-chatroom config set-password --server URL --password PW
                                                  save a server access password

server:  --server URL | $CHATROOM_SERVER | config default_server | http://localhost:8787
config file: ~/.ai-chatroom/config.json
state file:  --state PATH | $CHATROOM_STATE | ./.ai-chatroom-state.json
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
    password: { type: 'string' },
    cwd: { type: 'string' },
    title: { type: 'string' },
  },
})

const cmd = positionals[0]
const server = resolveServer(flags.server)
const statePath = flags.state ?? process.env.CHATROOM_STATE ?? './.ai-chatroom-state.json'

function loadState() {
  try {
    return JSON.parse(readFileSync(statePath, 'utf-8'))
  } catch {
    fail(`no state file at ${statePath} — run \`ai-chatroom join\` first (or pass --state)`)
  }
}

function fail(msg) {
  console.error(`error: ${msg}`)
  process.exit(1)
}

function resolvePassword(serverUrl) {
  return flags.password ?? getPasswordForServer(serverUrl) ?? undefined
}

function clientFromState() {
  const state = loadState()
  return new ChatroomClient({ ...state, password: resolvePassword(state.server) })
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
    `next: reply to the marked messages with \`ai-chatroom post --text "..." --reply-to <msg_id>\`,` +
      ` then run \`ai-chatroom ack --seq ${res.latest_seq}\` and \`ai-chatroom wait\` again.`,
  )
}

const commands = {
  async init() {
    const cwd = flags.cwd ?? process.cwd()
    const machineId = ensureMachineId()
    const password = resolvePassword(server)
    const client = new ChatroomClient({ server, password })
    const room = await client.createRoom(flags.title ?? '', { cwd, machine_id: machineId })
    console.log(`created room ${room.id}`)
    console.log(`  server:     ${server}`)
    console.log(`  title:      ${room.title || '(auto)'}`)
    console.log(`  cwd:        ${room.cwd}`)
    console.log(`  machine_id: ${room.machine_id}`)
    if (!flags.server) {
      const source = process.env.CHATROOM_SERVER ? '$CHATROOM_SERVER'
        : loadConfig().default_server ? 'config default_server'
        : 'default (localhost:8787)'
      console.log(`  (server resolved from ${source})`)
    }
    console.log(`\nrun \`ai-chatroom join --server ${server} --room ${room.id}\` to join it.`)
  },

  async rooms() {
    const rooms = await new ChatroomClient({ server, password: resolvePassword(server) }).listRooms()
    if (flags.json) return console.log(JSON.stringify(rooms, null, 2))
    for (const r of rooms) console.log(`${r.id}  [${r.last_seq} events]  ${r.title || '(untitled)'}${r.cwd ? `  cwd=${r.cwd}` : ''}`)
  },

  async personas() {
    const personas = await new ChatroomClient({ server, password: resolvePassword(server) }).listPersonas()
    if (flags.json) return console.log(JSON.stringify(personas, null, 2))
    for (const p of personas) console.log(`${p.id}  ${p.name}`)
  },

  async join() {
    if (!flags.room) fail('--room is required')
    let prevToken
    try {
      const prev = JSON.parse(readFileSync(statePath, 'utf-8'))
      if (prev.room_id === flags.room && prev.server === server) prevToken = prev.token
    } catch {
      /* fresh join */
    }
    const password = resolvePassword(server)
    const client = new ChatroomClient({ server, password })
    const joined = await client.join({
      roomId: flags.room,
      nickname: flags.nickname,
      type: flags.type,
      personaId: flags.persona,
      token: prevToken,
    })
    const state = {
      server,
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
    console.log('\nnow run `ai-chatroom wait` (blocking) to receive mentions.')
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

  async config() {
    const sub = positionals[1]

    if (sub === 'init') {
      const config = loadConfig()
      if (Object.keys(config).length > 0) {
        console.log(`config already exists at ${CONFIG_PATH}:`)
        console.log(JSON.stringify(config, null, 2))
        return
      }
      const template = {
        default_server: '',
        machine_id: '',
        server: { access_password: '', port: 8787 },
        servers: { 'localhost:8787': { password: '' } },
      }
      saveConfig(template)
      console.log(`created template config at ${CONFIG_PATH}`)
      console.log(`edit it to fill in your settings, then run \`ai-chatroom config show\` to verify.`)
      console.log(`note: machine_id will be auto-generated when you run \`ai-chatroom init\`.`)
      return
    }

    if (sub === 'show') {
      const config = loadConfig()
      if (!Object.keys(config).length) {
        console.log(`no config found. run \`ai-chatroom config init\` to create one at ${CONFIG_PATH}`)
        return
      }
      const masked = JSON.parse(JSON.stringify(config))
      if (masked.server?.access_password) masked.server.access_password = '***'
      if (masked.servers) {
        for (const s of Object.values(masked.servers)) {
          if (s.password) s.password = '***'
        }
      }
      console.log(`config: ${CONFIG_PATH}\n`)
      console.log(JSON.stringify(masked, null, 2))
      return
    }

    if (sub === 'set-password') {
      if (!flags.server || !flags.password) fail('--server and --password are required')
      const host = new URL(flags.server).host
      const config = loadConfig()
      if (!config.servers) config.servers = {}
      config.servers[host] = { ...config.servers[host], password: flags.password }
      saveConfig(config)
      console.log(`saved password for ${host}`)
      return
    }

    console.log('usage: ai-chatroom config <init|show|set-password>')
    process.exit(1)
  },
}

if (!cmd || flags.help || !commands[cmd]) {
  console.log(USAGE)
  process.exit(cmd && !flags.help ? 1 : 0)
}

commands[cmd]().catch((err) => fail(err.message))

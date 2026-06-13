import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { version } from '../package.json'
import {
  api,
  loadIdentity,
  saveIdentity,
  type ChatEvent,
  type Identity,
  type LlmInfo,
  type Member,
  type Persona,
  type Room,
} from './api'
import { Markdown } from './markdown'

export default function App() {
  const [rooms, setRooms] = useState<Room[]>([])
  const [roomId, setRoomId] = useState<string | null>(() => location.hash.slice(1) || null)
  const [showPersonas, setShowPersonas] = useState(false)

  const refreshRooms = useCallback(() => {
    api.rooms().then(setRooms).catch(console.error)
  }, [])

  useEffect(refreshRooms, [refreshRooms])

  useEffect(() => {
    const onHash = () => setRoomId(location.hash.slice(1) || null)
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const createRoom = async () => {
    const room = await api.createRoom()
    refreshRooms()
    location.hash = room.id
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <header>
          <h1>AI Chatroom</h1>
          <button onClick={createRoom}>+ 新话题</button>
        </header>
        <nav>
          {rooms.map((r) => (
            <a key={r.id} href={`#${r.id}`} className={r.id === roomId ? 'active' : ''}>
              <span className="room-title" title={r.title || '（未命名话题）'}>
                {r.title || '（未命名话题）'}
              </span>
              <span className="room-meta">{r.last_seq} 条</span>
            </a>
          ))}
        </nav>
        <footer>
          <LlmStatus />
          <button className="link" onClick={() => setShowPersonas((v) => !v)}>
            {showPersonas ? '返回聊天' : '人设管理'}
          </button>
          <span className="version">v{version}</span>
        </footer>
      </aside>
      {showPersonas ? (
        <PersonaPanel />
      ) : roomId ? (
        <ChatRoom key={roomId} roomId={roomId} onRoomChanged={refreshRooms} />
      ) : (
        <main className="empty">选择或创建一个话题开始讨论</main>
      )}
    </div>
  )
}

function LlmStatus() {
  const [info, setInfo] = useState<LlmInfo | null>(null)

  useEffect(() => {
    api.llm().then(setInfo).catch(console.error)
  }, [])

  if (!info) return null
  if (!info.enabled) return <p className="llm-status off">LLM 未配置</p>

  const switchModel = async (model: string) => {
    try {
      const next = await api.setLlmModel(model)
      setInfo((prev) => prev && { ...prev, ...next })
    } catch (err) {
      console.error(err)
    }
  }

  // keep the current model selectable even when /models omits it
  const options = info.model && !info.models.includes(info.model) ? [info.model, ...info.models] : info.models
  return (
    <div className="llm-status">
      <span className="badge">{info.provider}</span>
      <select value={info.model ?? ''} onChange={(e) => switchModel(e.target.value)}>
        {options.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
    </div>
  )
}

function ChatRoom({ roomId, onRoomChanged }: { roomId: string; onRoomChanged: () => void }) {
  const [identity, setIdentity] = useState<Identity | null>(() => loadIdentity(roomId))
  if (!identity) {
    return <JoinGate roomId={roomId} onJoined={setIdentity} />
  }
  return <ChatView roomId={roomId} identity={identity} onRoomChanged={onRoomChanged} />
}

function JoinGate({ roomId, onJoined }: { roomId: string; onJoined: (id: Identity) => void }) {
  const [nickname, setNickname] = useState('')
  const [error, setError] = useState('')
  const join = async () => {
    try {
      const joined = await api.join(roomId, { nickname: nickname.trim(), type: 'human' })
      const identity = { uid: joined.uid, token: joined.token, nickname: joined.nickname }
      saveIdentity(roomId, identity)
      onJoined(identity)
    } catch (err) {
      setError((err as Error).message)
    }
  }
  return (
    <main className="empty">
      <div className="join-card">
        <h2>加入话题</h2>
        <input
          placeholder="你的昵称"
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && nickname.trim() && join()}
          autoFocus
        />
        <button disabled={!nickname.trim()} onClick={join}>
          加入
        </button>
        {error && <p className="error">{error}</p>}
      </div>
    </main>
  )
}

function ChatView({
  roomId,
  identity,
  onRoomChanged,
}: {
  roomId: string
  identity: Identity
  onRoomChanged: () => void
}) {
  const [events, setEvents] = useState<ChatEvent[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const memberByUid = useMemo(() => new Map(members.map((m) => [m.uid, m])), [members])
  const mentionNames = useMemo(() => members.map((m) => m.nickname), [members])
  const eventByMsgId = useMemo(() => new Map(events.map((e) => [e.msg_id, e])), [events])

  const refreshMembers = useCallback(() => {
    api.members(roomId, identity.token).then(setMembers).catch(console.error)
  }, [roomId, identity.token])

  useEffect(() => {
    refreshMembers()
    const timer = setInterval(refreshMembers, 10_000) // presence has no event; poll it
    return () => clearInterval(timer)
  }, [refreshMembers])

  useEffect(() => {
    const es = new EventSource(`/api/rooms/${roomId}/stream?token=${identity.token}`)
    es.addEventListener('chat', (e) => {
      const ev = JSON.parse((e as MessageEvent).data) as ChatEvent
      setEvents((prev) => (prev.some((p) => p.seq === ev.seq) ? prev : [...prev, ev]))
      if (ev.kind === 'room_updated') onRoomChanged()
      if (ev.kind === 'member_joined' || ev.kind === 'member_left') refreshMembers()
    })
    return () => es.close()
  }, [roomId, identity.token, onRoomChanged, refreshMembers])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [events.length])

  const send = async () => {
    const t = text.trim()
    if (!t) return
    try {
      await api.sendMessage(roomId, identity.token, t)
      setText('')
      setError('')
    } catch (err) {
      setError((err as Error).message)
    }
  }

  // mention autocomplete on a trailing "@partial"
  const mentionMatch = /(?:^|\s)@([^\s@]*)$/.exec(text)
  const suggestions = mentionMatch
    ? members.filter((m) => m.uid !== identity.uid && m.nickname.startsWith(mentionMatch[1]))
    : []
  const [mentionIdx, setMentionIdx] = useState(0)
  const clampedIdx = Math.min(mentionIdx, Math.max(0, suggestions.length - 1))
  const completeMention = (nickname: string) => {
    setText(text.slice(0, text.length - mentionMatch![1].length) + nickname + ' ')
    setMentionIdx(0)
    inputRef.current?.focus()
  }

  return (
    <>
      <main className="chat">
        <div className="messages">
          {events.map((ev) => (
            <EventLine
              key={ev.seq}
              ev={ev}
              eventByMsgId={eventByMsgId}
              memberByUid={memberByUid}
              myUid={identity.uid}
              mentionNames={mentionNames}
            />
          ))}
          <div ref={bottomRef} />
        </div>
        <div className="composer">
          {suggestions.length > 0 && (
            <div className="mention-pop">
              {suggestions.map((m, i) => (
                <button key={m.uid} className={i === clampedIdx ? 'active' : ''} onClick={() => completeMention(m.nickname)}>
                  @{m.nickname} <small>{m.type === 'agent' ? m.persona_name ?? 'agent' : 'human'}</small>
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={inputRef}
            value={text}
            placeholder="发消息，@昵称 召唤 agent，Enter 发送 / Shift+Enter 换行"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (suggestions.length > 0) {
                if (e.key === 'Tab') {
                  e.preventDefault()
                  completeMention(suggestions[clampedIdx].nickname)
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setMentionIdx((clampedIdx - 1 + suggestions.length) % suggestions.length)
                  return
                }
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setMentionIdx((clampedIdx + 1) % suggestions.length)
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setText(text.slice(0, text.length - mentionMatch![0].length))
                  return
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
          />
          {error && <p className="error">{error}</p>}
        </div>
      </main>
      <aside className="members">
        <h3>成员</h3>
        {members.map((m) => (
          <div key={m.uid} className="member">
            <span className={`dot ${m.online ? 'online' : ''}`} />
            <span className={`nick ${m.type}`}>{m.nickname}</span>
            {m.persona_name && <span className="badge">{m.persona_name}</span>}
            {m.uid === identity.uid && <span className="badge me">我</span>}
          </div>
        ))}
      </aside>
    </>
  )
}

function EventLine({
  ev,
  eventByMsgId,
  memberByUid,
  myUid,
  mentionNames,
}: {
  ev: ChatEvent
  eventByMsgId: Map<string, ChatEvent>
  memberByUid: Map<string, Member>
  myUid: string
  mentionNames: string[]
}) {
  if (ev.kind !== 'message') {
    const label =
      ev.kind === 'room_updated' ? `话题已命名：${(ev.payload as { title?: string })?.title ?? ''}` : ev.text
    return <div className="sysline">{label}</div>
  }
  const sender = ev.sender_uid ? memberByUid.get(ev.sender_uid) : undefined
  const mentioned = ev.mentions.includes(myUid) || ev.mentions.includes('all')
  const replyTarget = ev.in_reply_to ? eventByMsgId.get(ev.in_reply_to) : undefined
  const replyNick = replyTarget?.sender_uid ? (memberByUid.get(replyTarget.sender_uid)?.nickname ?? '未知用户') : undefined
  return (
    <div className={`msg ${sender?.type ?? ''} ${mentioned ? 'mentioned' : ''} ${ev.muted ? 'muted' : ''}`}>
      {replyTarget && (
        <div className="reply-preview">
          <span className="reply-icon">↩</span>
          <span className="reply-nick">{replyNick ?? replyTarget.sender_uid}</span>
          <span className="reply-text">{(replyTarget.text ?? '').slice(0, 80)}{(replyTarget.text?.length ?? 0) > 80 ? '…' : ''}</span>
        </div>
      )}
      <div className="msg-head">
        <span className={`nick ${sender?.type ?? ''}`}>{sender?.nickname ?? ev.sender_uid}</span>
        {sender?.persona_name && <span className="badge">{sender.persona_name}</span>}
        {ev.muted && <span className="badge muted-badge">已熔断</span>}
        <time>{new Date(ev.created_at).toLocaleTimeString()}</time>
      </div>
      <div className="msg-body">
        <Markdown text={ev.text ?? ''} mentionNames={mentionNames} />
      </div>
    </div>
  )
}

function PersonaPanel() {
  const [personas, setPersonas] = useState<Persona[]>([])
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState('')

  const refresh = useCallback(() => {
    api.personas().then(setPersonas).catch(console.error)
  }, [])
  useEffect(refresh, [refresh])

  const create = async () => {
    try {
      await api.createPersona(name.trim(), prompt.trim())
      setName('')
      setPrompt('')
      setError('')
      refresh()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <main className="personas">
      <h2>人设预设</h2>
      <p className="hint">agent 加入房间时可选择一个人设；人设 id 用于 `chatroom join --persona`。</p>
      {personas.map((p) => (
        <div key={p.id} className="persona-card">
          <div className="persona-head">
            <strong>{p.name}</strong>
            <code>{p.id}</code>
          </div>
          <pre>{p.system_prompt}</pre>
        </div>
      ))}
      <div className="persona-card new">
        <input placeholder="人设名，如：架构师" value={name} onChange={(e) => setName(e.target.value)} />
        <textarea
          placeholder="system prompt，描述这个角色的视角和说话方式"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <button disabled={!name.trim() || !prompt.trim()} onClick={create}>
          新建人设
        </button>
        {error && <p className="error">{error}</p>}
      </div>
    </main>
  )
}

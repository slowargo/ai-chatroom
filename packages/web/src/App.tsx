import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { version } from '../package.json'
import {
  api,
  identityKey,
  loadIdentity,
  saveIdentity,
  type ChatEvent,
  type Identity,
  type LlmInfo,
  type Member,
  type PendingJoin,
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

  useEffect(() => {
    const es = new EventSource('/api/rooms/stream')
    es.addEventListener('rooms:snapshot', (e) => {
      setRooms(JSON.parse((e as MessageEvent).data))
    })
    es.addEventListener('room:created', (e) => {
      const room = JSON.parse((e as MessageEvent).data) as Room
      setRooms(prev => prev.some(r => r.id === room.id) ? prev : [...prev, room])
    })
    es.addEventListener('room:deleted', (e) => {
      const { id } = JSON.parse((e as MessageEvent).data) as Room
      setRooms(prev => prev.filter(r => r.id !== id))
    })
    es.addEventListener('room:updated', (e) => {
      const room = JSON.parse((e as MessageEvent).data) as Room
      setRooms(prev => prev.map(r => r.id === room.id ? room : r))
    })
    let lastErrorPoll = 0
    es.onerror = () => {
      const now = Date.now()
      if (now - lastErrorPoll > 5_000) {
        lastErrorPoll = now
        refreshRooms()
      }
    }
    // 60s polling fallback for last_seq (message count) freshness
    const timer = setInterval(refreshRooms, 60_000)
    return () => { es.close(); clearInterval(timer) }
  }, [refreshRooms])

  useEffect(() => {
    const onHash = () => setRoomId(location.hash.slice(1) || null)
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const createRoom = async () => {
    const room = await api.createRoom()
    setRooms(prev => prev.some(r => r.id === room.id) ? prev : [...prev, room])
    location.hash = room.id
  }

  const deleteRoom = async (e: React.MouseEvent, id: string) => {
    e.preventDefault()
    e.stopPropagation()
    if (!confirm('确定删除此话题？所有消息将不可恢复。')) return
    try {
      await api.deleteRoom(id)
      localStorage.removeItem(identityKey(id))
      if (roomId === id) location.hash = ''
      setRooms(prev => prev.filter(r => r.id !== id))
    } catch (err) {
      console.error(err)
    }
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
              <span className="room-meta">
                {r.last_seq} 条
                <button className="room-delete" onClick={(e) => deleteRoom(e, r.id)} title="删除话题">×</button>
              </span>
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
        <ChatRoom key={roomId} roomId={roomId} />
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
      <span className="badge" title="LLM 服务提供商">{info.provider}</span>
      <select title="用于自动生成房间标题和 Agent 昵称" value={info.model ?? ''} onChange={(e) => switchModel(e.target.value)}>
        {options.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
    </div>
  )
}

function ChatRoom({ roomId }: { roomId: string }) {
  const [identity, setIdentity] = useState<Identity | null>(() => loadIdentity(roomId))
  if (!identity) {
    return <JoinGate roomId={roomId} onJoined={setIdentity} />
  }
  return <ChatView roomId={roomId} identity={identity} />
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
}: {
  roomId: string
  identity: Identity
}) {
  const [events, setEvents] = useState<ChatEvent[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [pendingJoins, setPendingJoins] = useState<PendingJoin[]>([])
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const offlineTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const prevOnlineRef = useRef<Map<string, boolean>>(new Map())
  const [graceUids, setGraceUids] = useState<Set<string>>(new Set())

  const memberByUid = useMemo(() => new Map(members.map((m) => [m.uid, m])), [members])
  const mentionNames = useMemo(() => members.map((m) => m.nickname), [members])
  const eventByMsgId = useMemo(() => new Map(events.map((e) => [e.msg_id, e])), [events])

  const refreshMembers = useCallback(() => {
    api.members(roomId, identity.token).then(setMembers).catch(console.error)
  }, [roomId, identity.token])

  useEffect(() => {
    refreshMembers()
    // SSE handles the fast path; fall back to 30s poll for resilience
    const timer = setInterval(refreshMembers, 30_000)
    return () => clearInterval(timer)
  }, [refreshMembers])

  useEffect(() => {
    const prev = prevOnlineRef.current
    for (const m of members) {
      const wasOnline = prev.get(m.uid) ?? false
      if (wasOnline && !m.online && !offlineTimers.current.has(m.uid)) {
        setGraceUids(s => new Set(s).add(m.uid))
        offlineTimers.current.set(m.uid, setTimeout(() => {
          offlineTimers.current.delete(m.uid)
          setGraceUids(s => { const n = new Set(s); n.delete(m.uid); return n })
        }, 10_000))
      } else if (m.online && offlineTimers.current.has(m.uid)) {
        clearTimeout(offlineTimers.current.get(m.uid)!)
        offlineTimers.current.delete(m.uid)
        setGraceUids(s => { const n = new Set(s); n.delete(m.uid); return n })
      }
      prev.set(m.uid, m.online)
    }
  }, [members])

  useEffect(() => {
    return () => { for (const t of offlineTimers.current.values()) clearTimeout(t) }
  }, [])

  // Poll pending joins every 5s (human/admin users only)
  const refreshPendingJoins = useCallback(() => {
    api.pendingJoins(roomId, identity.token).then(setPendingJoins).catch(() => {/* non-admin: ignore */})
  }, [roomId, identity.token])

  useEffect(() => {
    refreshPendingJoins()
    const timer = setInterval(refreshPendingJoins, 5_000)
    return () => clearInterval(timer)
  }, [refreshPendingJoins])

  useEffect(() => {
    const es = new EventSource(`/api/rooms/${roomId}/stream?token=${identity.token}`)
    es.addEventListener('chat', (e) => {
      const ev = JSON.parse((e as MessageEvent).data) as ChatEvent
      setEvents((prev) => (prev.some((p) => p.seq === ev.seq) ? prev : [...prev, ev]))
      if (ev.kind === 'room_deleted') { location.hash = ''; return }
      if (ev.kind === 'member_joined' || ev.kind === 'member_left' || ev.kind === 'nickname_changed') refreshMembers()
    })
    es.addEventListener('status', (e) => {
      const { uid, thinking } = JSON.parse((e as MessageEvent).data) as { uid: string; thinking: boolean }
      setMembers((prev) => prev.map((m) => m.uid === uid ? { ...m, thinking, online: m.online || thinking } : m))
    })
    es.addEventListener('presence:snapshot', (e) => {
      const { online } = JSON.parse((e as MessageEvent).data) as { online: string[] }
      const onlineSet = new Set(online)
      setMembers((prev) => prev.map((m) => ({ ...m, online: onlineSet.has(m.uid) || m.thinking })))
    })
    es.addEventListener('presence', (e) => {
      const { uid, online } = JSON.parse((e as MessageEvent).data) as { uid: string; online: boolean }
      setMembers((prev) => prev.map((m) => m.uid === uid ? { ...m, online: online || m.thinking } : m))
    })
    let lastErrorPoll = 0
    es.onerror = () => {
      const now = Date.now()
      if (now - lastErrorPoll > 5_000) {
        lastErrorPoll = now
        refreshMembers()
      }
    }
    return () => es.close()
  }, [roomId, identity.token, refreshMembers])

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
                if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
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
        {pendingJoins.length > 0 && (
          <PendingApprovalPanel
            roomId={roomId}
            token={identity.token}
            requests={pendingJoins}
            members={members}
            onDone={() => { refreshPendingJoins(); refreshMembers() }}
          />
        )}
        <h3>成员</h3>
        {members.map((m) => (
          <div key={m.uid} className="member">
            <span className={`dot ${m.online ? 'online' : graceUids.has(m.uid) ? 'grace' : ''}`} />
            <span className={`nick ${m.type}`}>{m.nickname}</span>
            {m.thinking && <span className="thinking-dots"><span /><span /><span /></span>}
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
      <div className="msg-head">
        <span className={`nick ${sender?.type ?? ''}`}>{sender?.nickname ?? ev.sender_uid}</span>
        {sender?.persona_name && <span className="badge">{sender.persona_name}</span>}
        {ev.muted && <span className="badge muted-badge">已熔断</span>}
        <time>{new Date(ev.created_at).toLocaleTimeString()}</time>
      </div>
      {replyTarget && (
        <div className="reply-preview">
          <span className="reply-icon">↩</span>
          <span className="reply-nick">{replyNick ?? replyTarget.sender_uid}</span>
          <span className="reply-text">{(replyTarget.text ?? '').slice(0, 80)}{(replyTarget.text?.length ?? 0) > 80 ? '…' : ''}</span>
        </div>
      )}
      <div className="msg-body">
        <Markdown text={ev.text ?? ''} mentionNames={mentionNames} />
      </div>
    </div>
  )
}

function PendingApprovalPanel({
  roomId,
  token,
  requests,
  members,
  onDone,
}: {
  roomId: string
  token: string
  requests: PendingJoin[]
  members: Member[]
  onDone: () => void
}) {
  // Per-request local state: nickname input, selected bind uid, reject reason
  const [nicknames, setNicknames] = useState<Record<string, string>>({})
  const [bindUids, setBindUids] = useState<Record<string, string>>({})
  const [reasons, setReasons] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})

  // Agent-only members for the bind dropdown
  const agentMembers = members.filter((m) => m.type === 'agent')

  const nickFor = (req: PendingJoin) => nicknames[req.request_id] ?? req.nickname_requested
  const bindFor = (req: PendingJoin) => {
    if (bindUids[req.request_id] !== undefined) return bindUids[req.request_id]
    // auto-select if nickname matches an existing agent member
    const match = agentMembers.find((m) => m.nickname === req.nickname_requested)
    return match?.uid ?? ''
  }

  const approveNew = async (req: PendingJoin) => {
    try {
      await api.approvePendingJoin(roomId, req.request_id, token, {
        action: 'new',
        nickname: nickFor(req),
      })
      onDone()
    } catch (err) {
      setErrors((prev) => ({ ...prev, [req.request_id]: (err as Error).message }))
    }
  }

  const approveBind = async (req: PendingJoin) => {
    const uid = bindFor(req)
    if (!uid) return
    try {
      await api.approvePendingJoin(roomId, req.request_id, token, {
        action: 'bind',
        bind_uid: uid,
      })
      onDone()
    } catch (err) {
      setErrors((prev) => ({ ...prev, [req.request_id]: (err as Error).message }))
    }
  }

  const reject = async (req: PendingJoin) => {
    try {
      await api.rejectPendingJoin(roomId, req.request_id, token, reasons[req.request_id])
      onDone()
    } catch (err) {
      setErrors((prev) => ({ ...prev, [req.request_id]: (err as Error).message }))
    }
  }

  return (
    <div className="pending-panel">
      <h4>待审批加入请求</h4>
      {requests.map((req) => {
        const hasExisting = members.some((m) => m.nickname === req.nickname_requested)
        return (
          <div key={req.request_id} className="pending-item">
            <div className="pending-info">
              <span className="nick agent">{req.nickname_requested}</span>
              {req.persona_name && <span className="badge">{req.persona_name}</span>}
              <time>{new Date(req.created_at).toLocaleTimeString()}</time>
            </div>
            {!hasExisting && (
              <div className="pending-actions">
                <label>新成员</label>
                <input
                  value={nickFor(req)}
                  onChange={(e) =>
                    setNicknames((prev) => ({ ...prev, [req.request_id]: e.target.value }))
                  }
                  size={12}
                />
                <button onClick={() => approveNew(req)}>批准（新）</button>
              </div>
            )}
            {agentMembers.length > 0 && (
              <div className="pending-actions">
                <label>绑定既有</label>
                <select
                  value={bindFor(req)}
                  onChange={(e) =>
                    setBindUids((prev) => ({ ...prev, [req.request_id]: e.target.value }))
                  }
                >
                  <option value="">-- 选择成员 --</option>
                  {agentMembers.map((m) => (
                    <option key={m.uid} value={m.uid}>
                      {m.nickname}
                    </option>
                  ))}
                </select>
                <button disabled={!bindFor(req)} onClick={() => approveBind(req)}>
                  批准（绑定）
                </button>
              </div>
            )}
            <div className="pending-actions">
              <input
                placeholder="拒绝原因（可选）"
                value={reasons[req.request_id] ?? ''}
                onChange={(e) =>
                  setReasons((prev) => ({ ...prev, [req.request_id]: e.target.value }))
                }
                size={16}
              />
              <button className="reject" onClick={() => reject(req)}>
                拒绝
              </button>
            </div>
            {errors[req.request_id] && <p className="error">{errors[req.request_id]}</p>}
          </div>
        )
      })}
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

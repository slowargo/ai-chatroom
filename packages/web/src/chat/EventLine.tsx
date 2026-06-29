import { memo } from 'react'
import { Markdown } from '../markdown'
import { useI18n } from '../i18n'
import type { ChatEvent, Member } from '../api'

// Memoized: typing in the composer re-renders ChatView on every keystroke, but the message list
// props (events/members-derived maps) stay referentially stable across keystrokes, so each line
// skips re-rendering — and crucially skips re-parsing its markdown. Without this, every keystroke
// re-parsed every message's markdown, so typing got linearly slower as the room filled up.
export const EventLine = memo(function EventLine({
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
  const { t } = useI18n()
  if (ev.kind !== 'message') {
    const label =
      ev.kind === 'room_updated'
        ? t('system.roomRenamed', { title: (ev.payload as { title?: string })?.title ?? '' })
        : ev.text
    return <div className="sysline">{label}</div>
  }
  const sender = ev.sender_uid ? memberByUid.get(ev.sender_uid) : undefined
  const mentioned = ev.mentions.includes(myUid) || ev.mentions.includes('all')
  const replyTarget = ev.in_reply_to ? eventByMsgId.get(ev.in_reply_to) : undefined
  const replyNick = replyTarget?.sender_uid ? (memberByUid.get(replyTarget.sender_uid)?.nickname ?? t('reply.unknownUser')) : undefined
  return (
    <div className={`msg ${sender?.type ?? ''} ${mentioned ? 'mentioned' : ''} ${ev.muted ? 'muted' : ''}`}>
      <div className="msg-head">
        <span className={`nick ${sender?.type ?? ''}`}>{sender?.nickname ?? ev.sender_uid}</span>
        {sender?.persona_name && <span className="badge">{sender.persona_name}</span>}
        {ev.muted && <span className="badge muted-badge">{t('msg.muted')}</span>}
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
})

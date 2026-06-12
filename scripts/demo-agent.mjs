// Scripted demo agent: runs the real wait → reply → ack loop without an LLM.
// usage: node scripts/demo-agent.mjs <server> <room_id> [persona_id] [nickname]
import { ChatroomClient } from '../packages/agent-client/src/client.js'

const [server, roomId, personaId, nickname = 'demo-bot'] = process.argv.slice(2)
const client = new ChatroomClient({ server })
const joined = await client.join({ roomId, personaId, nickname })
console.log(`joined as ${joined.nickname} (${joined.uid})`)

for (;;) {
  const res = await client.waitForMention({ windowMs: 5000 })
  const todo = res.events.filter((e) => e.mentions_you && !e.replied_by_you)
  for (const t of todo) {
    const sender = res.events.find((e) => e.msg_id === t.msg_id)?.sender_uid
    const members = await client.members()
    const senderNick = members.find((m) => m.uid === sender)?.nickname ?? '朋友'
    await client.post({
      text: `@${senderNick} 收到你的消息「${t.text?.slice(0, 40)}」。从架构角度看，事件日志 + cursor 的设计是合理的。（demo 自动回复）`,
      replyTo: t.msg_id,
    })
    console.log(`replied to seq ${t.seq}`)
  }
  await client.ack(res.latest_seq)
}

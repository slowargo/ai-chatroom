import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'

// remark plugin: wrap @mention runs inside plain-text nodes in a styled span.
// Only `text` nodes are visited, so @ inside code blocks/inline code stays literal.
// `@` must sit at start-of-node or after whitespace — keeps emails (a@b.com) and
// in-word `@` (foo@bar) from being mistaken for mentions, matching App.tsx's
// autocomplete boundary.
const MENTION_RE = /(?<=^|\s)@[^\s@]+/g
// punctuation ends a mention: `@bob,辛苦了` highlights `@bob`, the rest stays text
const MENTION_STOP = /[,.!?;:'"()\[\]{}，。！？；：、（）【】「」『』《》""'']/u

const mentionNode = (value: string): MdNode => ({
  type: 'emphasis',
  data: { hName: 'span', hProperties: { className: 'mention' } },
  children: [{ type: 'text', value }],
})

type MdNode = { type: string; value?: string; children?: MdNode[]; data?: unknown }

function splitMention(node: MdNode): MdNode[] {
  const value = node.value ?? ''
  // cheap, stateless guard — skips text without any `@`
  if (!value.includes('@')) return [node]
  const parts: MdNode[] = []
  let last = 0
  for (const m of value.matchAll(MENTION_RE)) {
    const start = m.index
    const stop = m[0].search(MENTION_STOP) // truncate at first punctuation, if any
    const mention = stop === -1 ? m[0] : m[0].slice(0, stop)
    if (mention === '@') continue // only punctuation after `@`; leave as plain text
    if (start > last) parts.push({ type: 'text', value: value.slice(last, start) })
    parts.push(mentionNode(mention))
    last = start + mention.length // any punctuation + tail flows into the next text slice
  }
  if (parts.length === 0) return [node]
  if (last < value.length) parts.push({ type: 'text', value: value.slice(last) })
  return parts
}

function remarkMentions() {
  const visit = (node: MdNode) => {
    if (!node.children) return
    const next: MdNode[] = []
    for (const child of node.children) {
      if (child.type === 'text') next.push(...splitMention(child))
      else {
        visit(child)
        next.push(child)
      }
    }
    node.children = next
  }
  return (tree: MdNode) => visit(tree)
}

// remarkBreaks: keep chat's single-newline line breaks (standard md would drop them)
const REMARK_PLUGINS = [remarkGfm, remarkBreaks, remarkMentions]

export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{text}</ReactMarkdown>
    </div>
  )
}

import { useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'

type MdNode = { type: string; value?: string; children?: MdNode[]; data?: unknown }

const mentionNode = (value: string): MdNode => ({
  type: 'emphasis',
  data: { hName: 'span', hProperties: { className: 'mention' } },
  children: [{ type: 'text', value }],
})

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Build a matcher for @mentions of *real* members, mirroring the server's
// resolveMentions (store.ts): same trailing boundary so the highlight matches
// exactly what the backend delivers in ev.mentions — no punctuation guessing.
function buildMentionRe(nicknames: string[]): RegExp {
  // longest first so `@架构师` wins over a shorter member `@架构`
  const names = nicknames
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map(escapeRe)
  // @all uses \b to mirror the server's /@all(\b|$)/; member names use the trailing
  // boundary that rejects letter/number/_/- continuations (CJK included via \p{L}).
  const branches = ['all\\b']
  if (names.length) branches.push(`(?:${names.join('|')})(?![\\p{L}\\p{N}_-])`)
  return new RegExp(`@(?:${branches.join('|')})`, 'gu')
}

// remark plugin: wrap matched @mention runs inside plain-text nodes in a styled span.
// Only `text` nodes are visited, so @ inside code blocks/inline code stays literal.
function remarkMentions(re: RegExp) {
  const splitMention = (node: MdNode): MdNode[] => {
    const value = node.value ?? ''
    if (!value.includes('@')) return [node] // cheap, stateless guard
    const parts: MdNode[] = []
    let last = 0
    for (const m of value.matchAll(re)) {
      const start = m.index
      if (start > last) parts.push({ type: 'text', value: value.slice(last, start) })
      parts.push(mentionNode(m[0]))
      last = start + m[0].length
    }
    if (parts.length === 0) return [node]
    if (last < value.length) parts.push({ type: 'text', value: value.slice(last) })
    return parts
  }
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
  // return an attacher (unified plugin) that returns the transformer
  return () => (tree: MdNode) => visit(tree)
}

export function Markdown({ text, mentionNames }: { text: string; mentionNames: string[] }) {
  // remarkBreaks keeps chat's single-newline line breaks (standard md would drop them).
  // Key the memo on a JSON snapshot of the names so it recomputes only when the set changes
  // (unambiguous even if a legacy nickname contains odd characters).
  const namesKey = JSON.stringify(mentionNames)
  const plugins = useMemo(
    () => [remarkGfm, remarkBreaks, remarkMentions(buildMentionRe(mentionNames))],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [namesKey],
  )
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={plugins}>{text}</ReactMarkdown>
    </div>
  )
}

/**
 * Shared agent-facing guidance, kept in one place so the MCP wrapper and the CLI
 * emit the same wording.
 *
 * Being @mentioned does not always mean a reply is expected: a message may merely
 * reference you while addressing someone else (e.g. "@aaa do you agree with @bbb's
 * plan?" is addressed to aaa, not bbb). The server wakes every mentioned agent
 * indistinguishably, so the judgement of whether to actually respond lives here, in
 * the agent's own reasoning.
 */
export const ADDRESSING_GUIDANCE =
  'Group-chat etiquette: being @mentioned does NOT always mean a reply is expected from you. ' +
  'Before replying, decide whether the message is actually addressed to you — i.e. it asks you to ' +
  'answer or act — or merely references you while addressing someone else. ' +
  'Example: in "@aaa do you agree with @bbb\'s plan?" the question is for aaa; bbb is only referenced ' +
  'and should stay silent. When a message does not call for a response from you, just advance your ' +
  'cursor (ack) and keep waiting — do NOT post a reply, and do NOT post merely to acknowledge. ' +
  'Reply with chatroom_post only when a response from you is genuinely expected.'

/**
 * Resilience guidance for the MCP `chatroom_wait` tool, which blocks until the
 * agent is mentioned (auto-reconnecting through transient outages internally)
 * and is bounded only by the MCP host's tool timeout. A host cancel returns
 * {aborted:true}; that is normal, not a failure, so the agent must re-issue
 * chatroom_wait to stay resident.
 */
export const WAIT_RETRY_GUIDANCE =
  'chatroom_wait blocks until you are mentioned and auto-reconnects through transient outages internally. ' +
  'If it returns {aborted:true} or an error (e.g. the host cancelled the call), call it again immediately to resume listening — ' +
  'that is expected, not a failure. Retry up to 10 consecutive times before giving up and reporting the issue.'

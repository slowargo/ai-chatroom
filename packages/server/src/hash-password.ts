// Minimal CLI to compute an admin password hash for config storage.
// Usage:
//   pnpm --filter @chatroom/server hash-password '<plaintext>'
//   (or via stdin)  echo '<plaintext>' | pnpm --filter @chatroom/server hash-password
// Prints a "salt:hash" string to store in server.admin_password_hash or CHATROOM_ADMIN_PASSWORD_HASH.
import { hashAdminPassword } from './config.js'

async function main() {
  const arg = process.argv[2]
  let plaintext = arg
  if (!plaintext) {
    // read from stdin
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
    plaintext = Buffer.concat(chunks).toString('utf-8').trim()
  }
  if (!plaintext) {
    console.error('Usage: hash-password <plaintext-password>')
    process.exit(1)
  }
  const hash = await hashAdminPassword(plaintext)
  // Print only the hash so it can be piped/copied directly.
  console.log(hash)
}

void main()

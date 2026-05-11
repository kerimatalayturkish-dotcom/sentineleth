// Generate an argon2id hash for ADMIN_PASSWORD_HASH with zero shell mangling.
//
// Usage:
//   1. Create a file (e.g. password.txt) and paste your password into it
//      using VS Code or notepad. The script trims a single trailing
//      \n / \r\n automatically.
//   2. Run:  node scripts/hash-password.mjs password.txt
//   3. Paste the printed line into .env.local (keep the single quotes).
//   4. Delete password.txt.
//
// The script also round-trips: it argon2.verify()s the new hash against the
// exact bytes from the file and refuses to print if verification fails. So
// if the printed line is shown, you are guaranteed it matches the file.

import argon2 from "argon2"
import { readFileSync, statSync } from "node:fs"
import { resolve } from "node:path"

const argPath = process.argv[2]
if (!argPath) {
  console.error("Usage: node scripts/hash-password.mjs <path-to-password-file>")
  console.error("Create a file with your password as its only contents, then pass its path.")
  process.exit(1)
}

const filePath = resolve(argPath)
const stat = statSync(filePath)
if (!stat.isFile()) {
  console.error(`Not a file: ${filePath}`)
  process.exit(1)
}

const raw = readFileSync(filePath) // Buffer, raw bytes, no shell involved

// Strip a single trailing newline (\n or \r\n) if present — most editors add one.
let bytes = raw
if (bytes.length >= 2 && bytes[bytes.length - 2] === 0x0d && bytes[bytes.length - 1] === 0x0a) {
  bytes = bytes.subarray(0, bytes.length - 2)
} else if (bytes.length >= 1 && bytes[bytes.length - 1] === 0x0a) {
  bytes = bytes.subarray(0, bytes.length - 1)
}

if (bytes.length < 8) {
  console.error(`Password must be at least 8 bytes (file has ${bytes.length}).`)
  process.exit(1)
}

const password = bytes.toString("utf8")
console.log(`Read ${bytes.length} bytes from ${filePath}`)
console.log(`First 4 chars: ${JSON.stringify(password.slice(0, 4))}  Last 4 chars: ${JSON.stringify(password.slice(-4))}`)

const hash = await argon2.hash(password, { type: argon2.argon2id })

// Sanity check: verify the hash against the same bytes we just read.
const ok = await argon2.verify(hash, password)
if (!ok) {
  console.error("Internal error: argon2.verify() failed against the freshly created hash. Aborting.")
  process.exit(1)
}

console.log("\nVerified - paste this line into .env.local (keep the single quotes):\n")
console.log(`ADMIN_PASSWORD_HASH='${hash}'`)
console.log("\nThen delete the password file and restart the dev server.")

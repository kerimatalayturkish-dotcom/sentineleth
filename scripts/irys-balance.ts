import { getIrysStatus } from "../lib/irys"

async function main() {
  const s = await getIrysStatus()
  console.log(JSON.stringify(s, null, 2))
}

main().catch((e) => { console.error(e); process.exit(1) })

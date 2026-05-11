import { getIrysStatus, getIrysPrice } from "../lib/irys"

async function main() {
  const s = await getIrysStatus()
  console.log(`network : ${s.network}`)
  console.log(`token   : ${s.token}`)
  console.log(`address : ${s.address}`)
  console.log(`balance : ${s.loadedBalance} ${s.token}`)
  const p50 = await getIrysPrice(50_000)
  console.log(`price/50KB : ${p50.price} ${s.token}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

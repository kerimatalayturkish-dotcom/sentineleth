import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import QRCode from "qrcode"
import { buildAdminTotpProvisioningUri, generateAdminTotpSecret } from "../lib/auth"

function wrapEnvValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

function groupSecret(secret: string): string {
  return secret.match(/.{1,4}/g)?.join(" ") ?? secret
}

const issuer = process.argv[2]?.trim() || "SentinelETH Admin"
const accountName = process.argv[3]?.trim() || "admin"

async function main() {
  const secret = generateAdminTotpSecret()
  const uri = buildAdminTotpProvisioningUri({ secret, issuer, accountName })
  const svgPath = join(tmpdir(), `sentineleth-admin-totp-${Date.now()}.svg`)
  const terminalQr = await QRCode.toString(uri, { type: "terminal", small: true })
  const svgQr = await QRCode.toString(uri, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 1,
    width: 512,
  })

  writeFileSync(svgPath, svgQr, "utf8")

  console.log("\nGoogle Authenticator admin 2FA setup\n")
  console.log(`Issuer:  ${issuer}`)
  console.log(`Account: ${accountName}`)
  console.log(`Secret:  ${groupSecret(secret)}`)
  console.log("\nPaste these lines into .env.local or your production secret store:\n")
  console.log(`ADMIN_TOTP_SECRET=${secret}`)
  console.log(`ADMIN_TOTP_ISSUER=${wrapEnvValue(issuer)}`)
  console.log("\nProvisioning URI (manual entry or trusted QR workflow):\n")
  console.log(uri)
  console.log("\nScan this QR with Google Authenticator:\n")
  console.log(terminalQr)
  console.log("\nSVG QR written to:\n")
  console.log(svgPath)
  console.log("\nDelete the SVG after scanning.\n")
  console.log("After saving the env vars, restart the Next server. The admin page will require username/password first, then a 6-digit authenticator code.\n")
}

void main()
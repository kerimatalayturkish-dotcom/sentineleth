import Link from "next/link"

export const metadata = {
  title: "How to Mint — SentinelETH",
  description: "Mint SentinelETH NFTs in three steps with Claude and MetaMask.",
}

// Public MCP server URL (single canonical endpoint).
const MCP_URL = "https://sentineleth-mcp.onrender.com/mcp"

export default function HowToMintPage() {
  return (
    <main className="container mx-auto max-w-3xl p-4 sm:p-6">
      <header className="mb-8">
        <h1 className="font-pixel text-base sm:text-lg text-sentinel animate-text-glow">
          HOW TO MINT
        </h1>
        <p className="mt-2 text-[10px] text-muted-foreground">
          {"// Three steps. MetaMask → Claude → mint."}
        </p>
      </header>

      <section className="space-y-8 text-[11px] sm:text-xs leading-relaxed text-muted-foreground">
        {/* ── Step 1 ─────────────────────────────────────────────── */}
        <article className="border border-sentinel/20 rounded-md p-4 bg-card/40">
          <h2 className="text-sentinel font-bold mb-3 text-xs sm:text-sm">
            STEP 1 — Prepare MetaMask (enable hex data)
          </h2>
          <p className="mb-3 text-foreground">
            SentinelETH mints carry a small hex payload in the transaction
            data. MetaMask hides this by default — you need to turn it on so
            you can review what you&apos;re signing.
          </p>
          <ol className="list-decimal list-inside space-y-1.5 marker:text-sentinel/70">
            <li>Open the MetaMask extension.</li>
            <li>
              Click the <span className="text-foreground">sandwich menu</span>{" "}
              (☰) in the top-right corner.
            </li>
            <li>
              Scroll down and click{" "}
              <span className="text-foreground">Settings</span>.
            </li>
            <li>
              Choose <span className="text-foreground">Advanced</span> (older
              builds: <span className="text-foreground">Transactions</span>).
            </li>
            <li>
              Find <span className="text-foreground">&ldquo;Show Hex Data&rdquo;</span>{" "}
              and toggle it <span className="text-sentinel">ON</span>.
            </li>
          </ol>
          <p className="mt-3 text-[10px] text-muted-foreground/80">
            Your MetaMask wallet is now ready to display the mint payload.
          </p>
        </article>

        {/* ── Step 2 ─────────────────────────────────────────────── */}
        <article className="border border-sentinel/20 rounded-md p-4 bg-card/40">
          <h2 className="text-sentinel font-bold mb-3 text-xs sm:text-sm">
            STEP 2 — Connect Claude to the SentinelETH MCP server
          </h2>
          <p className="mb-3 text-foreground">
            SentinelETH ships an MCP (Model Context Protocol) server so Claude
            can read collection state and build mint transactions for you.
            Connect it once, on either Claude.ai or the Claude Desktop app.
          </p>

          <div className="mb-4">
            <h3 className="text-foreground font-bold mb-1.5">
              Option A — Claude.ai (web)
            </h3>
            <ol className="list-decimal list-inside space-y-1.5 marker:text-sentinel/70">
              <li>
                Open{" "}
                <a
                  href="https://claude.ai/settings/connectors"
                  target="_blank"
                  rel="noreferrer"
                  className="text-sentinel underline"
                >
                  claude.ai → Settings → Connectors
                </a>
                .
              </li>
              <li>
                Click <span className="text-foreground">Add custom connector</span>.
              </li>
              <li>
                Name it <span className="text-foreground">SentinelETH</span> and
                paste the URL:
                <pre className="mt-2 p-2 rounded bg-background/60 border border-sentinel/20 text-[10px] text-sentinel overflow-x-auto">
                  {MCP_URL}
                </pre>
              </li>
              <li>
                Save. Start a new chat — the SentinelETH tools should appear in
                the connector list.
              </li>
            </ol>
          </div>

          <div>
            <h3 className="text-foreground font-bold mb-1.5">
              Option B — Claude Desktop
            </h3>
            <ol className="list-decimal list-inside space-y-1.5 marker:text-sentinel/70">
              <li>
                Open Claude Desktop →{" "}
                <span className="text-foreground">Settings → Connectors</span>.
              </li>
              <li>
                Click <span className="text-foreground">Add custom connector</span>{" "}
                and choose the <span className="text-foreground">URL (HTTP)</span>{" "}
                transport.
              </li>
              <li>
                Paste the same URL as above ({MCP_URL}).
              </li>
              <li>Save and restart Claude Desktop.</li>
            </ol>
            <p className="mt-2 text-[10px] text-muted-foreground/80">
              Claude Desktop also supports a JSON config — if you prefer that,
              add an entry under{" "}
              <code className="text-sentinel">mcpServers</code> with{" "}
              <code className="text-sentinel">type: &quot;http&quot;</code> and
              the URL above.
            </p>
          </div>
        </article>

        {/* ── Step 3 ─────────────────────────────────────────────── */}
        <article className="border border-sentinel/20 rounded-md p-4 bg-card/40">
          <h2 className="text-sentinel font-bold mb-3 text-xs sm:text-sm">
            STEP 3 — Ask Claude to mint
          </h2>
          <p className="mb-3 text-foreground">
            With MetaMask ready and the connector live, just talk to Claude.
            It will check collection status, build the transaction, and walk
            you through signing it in MetaMask.
          </p>
          <ul className="list-disc list-inside space-y-1.5 marker:text-sentinel/70">
            <li>
              <span className="text-foreground">&ldquo;How do I mint a SentinelETH?&rdquo;</span>{" "}
              — Claude explains the current phase, price, and per-wallet cap.
            </li>
            <li>
              <span className="text-foreground">
                &ldquo;Mint 1 (or more, up to 4) SentinelETH for me &mdash;
                &lt;your wallet address&gt;.&rdquo;
              </span>{" "}
              — Claude returns the exact{" "}
              <code className="text-sentinel">to</code>,{" "}
              <code className="text-sentinel">value</code>, and{" "}
              <code className="text-sentinel">data</code> for the transaction.
              Always include the wallet address you want the NFTs minted to.
            </li>
            <li>
              Open MetaMask, paste / approve the transaction, and confirm the
              hex data matches what Claude returned.
            </li>
            <li>
              Once the transaction confirms on Sepolia, your token shows up
              under{" "}
              <Link href="/my-holdings" className="text-sentinel underline">
                My Holdings
              </Link>
              {" "}within ~30 seconds.
            </li>
            <li>
              <span className="text-foreground">
                &ldquo;Show me the NFTs and metadata I just minted.&rdquo;
              </span>{" "}
              — Claude can read your tokens and their on-chain metadata
              directly. Metadata propagates within{" "}
              <span className="text-sentinel">30 seconds to 1 minute</span> after
              the mint transaction confirms.
            </li>
          </ul>
          <p className="mt-3 text-[10px] text-muted-foreground/80">
            Max 4 per wallet. Mint price and remaining supply are visible on
            the homepage and via Claude at any time.
          </p>
        </article>
      </section>
    </main>
  )
}

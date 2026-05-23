import { NextRequest } from 'next/server'
import { readMiningTimelineStreamSnapshot } from '@/lib/mining-winner'

export const runtime = 'nodejs'

const STREAM_INTERVAL_MS = 5_000
const encoder = new TextEncoder()

function encodeEvent(event: string, data: Record<string, unknown>) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

export async function GET(request: NextRequest) {
  let interval: ReturnType<typeof setInterval> | null = null
  let closed = false
  let pushing = false

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (closed) return
        closed = true
        if (interval) clearInterval(interval)
        try {
          controller.close()
        } catch {
          // Ignore duplicate close attempts from abort/cancel races.
        }
      }

      const pushRefresh = async () => {
        if (closed || pushing) return
        pushing = true

        try {
          const timeline = await readMiningTimelineStreamSnapshot()
          if (closed) return

          controller.enqueue(encodeEvent('refresh', {
            wallet: request.nextUrl.searchParams.get('wallet'),
            issuedAt: new Date().toISOString(),
            timeline,
          }))
        } catch {
          if (!closed) {
            controller.enqueue(encodeEvent('refresh', {
              wallet: request.nextUrl.searchParams.get('wallet'),
              issuedAt: new Date().toISOString(),
            }))
          }
        } finally {
          pushing = false
        }
      }

      controller.enqueue(encoder.encode('retry: 3000\n\n'))
      void pushRefresh()
      interval = setInterval(() => {
        void pushRefresh()
      }, STREAM_INTERVAL_MS)
      request.signal.addEventListener('abort', close)
    },
    cancel() {
      closed = true
      if (interval) clearInterval(interval)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}

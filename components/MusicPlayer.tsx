"use client"

import { useRef, useState, useEffect, useCallback } from "react"

const TRACKS = [
  "/music/track1.mp3",
  "/music/track2.mp3",
  "/music/track3.mp3",
  "/music/track4.mp3",
  "/music/track5.mp3",
  "/music/track6.mp3",
]

export function MusicPlayer() {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [trackIdx, setTrackIdx] = useState(0)

  const loadTrack = useCallback(
    (idx: number, autoplay: boolean) => {
      const audio = audioRef.current
      if (!audio) return
      audio.src = TRACKS[idx]
      audio.load()
      if (autoplay) audio.play().catch(() => {})
    },
    [],
  )

  useEffect(() => {
    const audio = new Audio()
    audio.volume = 0.3
    audioRef.current = audio

    const onEnded = () => {
      setTrackIdx((prev) => {
        const next = (prev + 1) % TRACKS.length
        loadTrack(next, true)
        return next
      })
    }
    audio.addEventListener("ended", onEnded)

    // Load first track (don't autoplay — requires user gesture)
    audio.src = TRACKS[0]
    audio.load()

    return () => {
      audio.removeEventListener("ended", onEnded)
      audio.pause()
      audio.src = ""
    }
  }, [loadTrack])

  const toggle = () => {
    const audio = audioRef.current
    if (!audio) return
    if (playing) {
      audio.pause()
    } else {
      audio.play().catch(() => {})
    }
    setPlaying(!playing)
  }

  const prev = () => {
    setTrackIdx((i) => {
      const next = (i - 1 + TRACKS.length) % TRACKS.length
      loadTrack(next, playing)
      return next
    })
  }

  const next = () => {
    setTrackIdx((i) => {
      const next = (i + 1) % TRACKS.length
      loadTrack(next, playing)
      return next
    })
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 flex items-center gap-1.5">
      {/* Prev */}
      <button
        onClick={prev}
        aria-label="Previous track"
        className="flex items-center justify-center w-8 h-8 rounded-full border border-sentinel/20 bg-background/80 backdrop-blur-sm text-sentinel/70 hover:bg-sentinel/10 hover:border-sentinel/40 transition-all text-[10px]"
      >
        ⏮
      </button>

      {/* Play / Pause */}
      <button
        onClick={toggle}
        aria-label={playing ? "Pause music" : "Play music"}
        className="flex items-center justify-center w-10 h-10 rounded-full border border-sentinel/30 bg-background/80 backdrop-blur-sm text-sentinel hover:bg-sentinel/10 hover:border-sentinel/50 transition-all"
      >
        {playing ? (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
          </svg>
        ) : (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            <line x1="23" y1="9" x2="17" y2="15" />
            <line x1="17" y1="9" x2="23" y2="15" />
          </svg>
        )}
      </button>

      {/* Next */}
      <button
        onClick={next}
        aria-label="Next track"
        className="flex items-center justify-center w-8 h-8 rounded-full border border-sentinel/20 bg-background/80 backdrop-blur-sm text-sentinel/70 hover:bg-sentinel/10 hover:border-sentinel/40 transition-all text-[10px]"
      >
        ⏭
      </button>

      {/* Track indicator */}
      <span className="text-[7px] text-sentinel/40 ml-1 font-mono">
        {trackIdx + 1}/{TRACKS.length}
      </span>
    </div>
  )
}

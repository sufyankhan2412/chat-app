import React, { useEffect, useRef, useState } from "react";
import { formatDuration } from "../utils/formatFileSize";

// A small custom play/pause + progress-bar player for voice note bubbles.
// Wraps a plain <audio> element rather than using its native `controls` UI,
// which looks nothing like WhatsApp's rounded pill player and differs
// between browsers.
export default function VoicePlayer({ src, duration }) {
  const audioRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [knownDuration, setKnownDuration] = useState(duration || 0);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleTimeUpdate = () => setCurrentTime(audio.currentTime);
    const handleLoadedMetadata = () => {
      // Some browsers report Infinity for streamed/webm blobs until
      // playback starts; fall back to the duration the recorder measured.
      if (Number.isFinite(audio.duration)) setKnownDuration(audio.duration);
    };
    const handleEnded = () => {
      setIsPlaying(false);
      setCurrentTime(0);
    };

    audio.addEventListener("timeupdate", handleTimeUpdate);
    audio.addEventListener("loadedmetadata", handleLoadedMetadata);
    audio.addEventListener("ended", handleEnded);

    return () => {
      audio.removeEventListener("timeupdate", handleTimeUpdate);
      audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
      audio.removeEventListener("ended", handleEnded);
    };
  }, []);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
    } else {
      audio.play();
    }
    setIsPlaying(!isPlaying);
  };

  const handleSeek = (e) => {
    const audio = audioRef.current;
    if (!audio || !knownDuration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    audio.currentTime = ratio * knownDuration;
    setCurrentTime(audio.currentTime);
  };

  const progressPct = knownDuration ? Math.min(100, (currentTime / knownDuration) * 100) : 0;

  return (
    <div className="voice-player">
      <audio ref={audioRef} src={src} preload="metadata" />
      <button
        type="button"
        className="voice-play-btn"
        onClick={togglePlay}
        aria-label={isPlaying ? "Pause voice message" : "Play voice message"}
      >
        {isPlaying ? (
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
            <rect x="6" y="5" width="4" height="14" rx="1" />
            <rect x="14" y="5" width="4" height="14" rx="1" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </button>
      <div className="voice-track" onClick={handleSeek}>
        <div className="voice-track-fill" style={{ width: `${progressPct}%` }} />
      </div>
      <span className="voice-duration">
        {formatDuration(isPlaying || currentTime > 0 ? currentTime : knownDuration)}
      </span>
    </div>
  );
}
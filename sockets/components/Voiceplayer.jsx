import React, { useEffect, useRef, useState } from "react";
import { formatDuration } from "../utils/Formatfilesize";

// A small custom play/pause + progress-bar player for voice note bubbles.
// Wraps a plain <audio> element rather than using its native `controls` UI,
// which looks nothing like WhatsApp's rounded pill player and differs
// between browsers.
export default function VoicePlayer({ src, duration }) {
  const audioRef = useRef(null);
  const rafRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [knownDuration, setKnownDuration] = useState(duration || 0);


  const tick = () => {
    const audio = audioRef.current;
    if (!audio) return;
    setCurrentTime(audio.currentTime);
    rafRef.current = requestAnimationFrame(tick);
  };

  const stopTicking = () => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handlePlay = () => {
      stopTicking();
      rafRef.current = requestAnimationFrame(tick);
    };
    const handlePauseOrEnded = () => {
      stopTicking();
      setCurrentTime(audio.currentTime);
    };
    const handleLoadedMetadata = () => {
      // Some browsers report Infinity for streamed/webm blobs until
      // playback starts; fall back to the duration the recorder measured.
      if (Number.isFinite(audio.duration)) setKnownDuration(audio.duration);
    };
    const handleEnded = () => {
      setIsPlaying(false);
      setCurrentTime(0);
    };
    const handleSeeked = () => setCurrentTime(audio.currentTime);

    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePauseOrEnded);
    audio.addEventListener("loadedmetadata", handleLoadedMetadata);
    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("seeked", handleSeeked);

    return () => {
      stopTicking();
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePauseOrEnded);
      audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("seeked", handleSeeked);
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
    <div className={`voice-player${isPlaying ? " is-playing" : ""}`}>
      <audio ref={audioRef} src={src} preload="metadata" />
      <button
        type="button"
        className="voice-play-btn"
        onClick={togglePlay}
        aria-label={isPlaying ? "Pause voice message" : "Play voice message"}
      >
        <span className="voice-play-btn-ring" aria-hidden="true" />
        {isPlaying ? (
          <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
            <rect x="6.5" y="5" width="4" height="14" rx="1.5" />
            <rect x="13.5" y="5" width="4" height="14" rx="1.5" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
            <path d="M7.5 4.5v15c0 .8.87 1.3 1.56.9l12-7.5a1 1 0 0 0 0-1.7l-12-7.5A1.02 1.02 0 0 0 7.5 4.5z" />
          </svg>
        )}
      </button>
      <div className="voice-track" onClick={handleSeek}>
        <div className="voice-track-fill" style={{ width: `${progressPct}%` }} />
        <div className="voice-track-thumb" style={{ left: `${progressPct}%` }} />
      </div>
      <span className="voice-duration">
        {formatDuration(isPlaying || currentTime > 0 ? currentTime : knownDuration)}
      </span>
    </div>
  );
}
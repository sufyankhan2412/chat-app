import { useEffect, useRef } from "react";
import "./LiveTranscript.css";

export default function LiveTranscript({ segments, callStartedAt }) {
  const containerRef = useRef(null);

  // Auto-scroll to bottom when new segments arrive
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [segments]);

  if (!segments || segments.length === 0) {
    return (
      <div className="live-transcript">
        <div className="live-transcript-empty">
          Waiting for transcription...
        </div>
      </div>
    );
  }

  return (
    <div className="live-transcript" ref={containerRef}>
      {segments.map((segment, index) => {
        const startSeconds = Math.floor(
          (segment.callId ? segment.startTimeMs : segment.startTimeMs - callStartedAt) / 1000
        );
        const minutes = Math.floor(startSeconds / 60);
        const seconds = startSeconds % 60;
        const timestamp = `${minutes}:${seconds.toString().padStart(2, "0")}`;

        return (
          <div key={index} className="transcript-segment">
            <div className="transcript-header">
              <span className="transcript-speaker">{segment.speakerName || "Unknown"}</span>
              <span className="transcript-time">{timestamp}</span>
            </div>
            <div className="transcript-text">{segment.text}</div>
          </div>
        );
      })}
    </div>
  );
}

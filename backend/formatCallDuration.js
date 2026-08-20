// Formats a completed call's duration (given in whole seconds) the way
// WhatsApp does: under a minute as plain seconds ("42s"), otherwise as
// clock time — mm:ss, or h:mm:ss once the call runs past an hour.
export function formatCallDuration(totalSeconds = 0) {
  const seconds = Math.max(0, Math.round(totalSeconds || 0));

  if (seconds < 60) return `${seconds}s`;

  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const ss = String(s).padStart(2, "0");

  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  }
  return `${m}:${ss}`;
}
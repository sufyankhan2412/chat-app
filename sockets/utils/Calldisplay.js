import { formatCallDuration } from "../../backend/formatCallDuration";

// Turns a call-log message's `call` sub-object + "was this call placed by
// me" into the copy shown for it — shared by the inline chat bubble and
// the dedicated Call Logs page so both always agree on wording.
//
// A call only ever reads as "missed" to the person who *didn't* answer —
// the caller instead sees "No answer", exactly like WhatsApp.
export function getCallDisplay(call, isOwn) {
  const isVideo = call?.callType === "video";
  const missed = call?.status !== "completed" && !isOwn;
  const kind = isVideo ? "video" : "voice";

  const title = missed ? `Missed ${kind} call` : isVideo ? "Video call" : "Voice call";

  const subtitle =
    call?.status === "completed"
      ? formatCallDuration(call.duration)
      : call?.status === "declined"
      ? "Declined"
      : isOwn
      ? "No answer"
      : "Missed call";

  return { isVideo, missed, outgoing: isOwn, title, subtitle };
}
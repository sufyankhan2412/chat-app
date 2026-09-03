// Browsers' autoplay-with-sound policies (Chrome's most notably) block
// HTMLMediaElement.play() until the page has seen SOME user interaction
// (a click, tap, or keypress anywhere on the page — not necessarily on
// the media element itself). The `autoPlay` attribute alone triggers ONE
// implicit play() call as soon as srcObject is assigned; if that initial
// call is blocked, the browser does NOT retry it later once an
// interaction satisfies the policy — nothing calls play() again unless
// the app does so itself.
//
// This is exactly what produced "I can't hear the other person unless I
// click mute first": the remote <audio>/<video> element's first play()
// attempt silently failed (rejected promise, nothing thrown, nothing
// visibly broken) the moment the call connected. The very first click
// anywhere on the call UI satisfies the browser's interaction
// requirement retroactively for FUTURE play() calls, but never retries
// the one that already failed — sound only came back because clicking
// mute happened to re-render the audio element (fresh autoPlay fires,
// this time allowed), not because anything actually fixed playback.
//
// FIX: always call play() ourselves whenever we assign srcObject
// (attachStreamAndPlay), AND listen once for the page's first
// interaction to retry play() on any currently-paused call media
// (registerAutoplayUnlock) — so playback starts the instant it's
// actually allowed to, not only if/when something else happens to
// re-trigger it.

export function attachStreamAndPlay(element, stream) {
  if (!element) return;
  element.srcObject = stream || null;
  if (!stream) return;
  const playResult = element.play();
  if (playResult && typeof playResult.catch === "function") {
    playResult.catch((err) => {
      // AbortError: srcObject got reassigned again before this play()
      // resolved — harmless, the newer assignment's own play() call is
      // the one that matters.
      // NotAllowedError (the common one): autoplay was blocked.
      // registerAutoplayUnlock's listener below will retry this exact
      // element on the page's next interaction.
      if (err?.name !== "AbortError") {
        console.warn(
          "[callMedia] play() blocked, will retry on next interaction:",
          err?.name || err
        );
      }
    });
  }
}

let unlockRegistered = false;

// Call once (safe to call from multiple components — it's a no-op after
// the first call). Retries play() on every call-audio/video element
// currently sitting paused with a live srcObject, the moment the page
// sees its first interaction. Elements must be marked `data-call-media`
// for this to find them.
export function registerAutoplayUnlock() {
  if (unlockRegistered || typeof document === "undefined") return;
  unlockRegistered = true;

  const retryStuckMedia = () => {
    document
      .querySelectorAll("audio[data-call-media], video[data-call-media]")
      .forEach((el) => {
        if (el.srcObject && el.paused) {
          el.play().catch(() => {
            // Still blocked, or no longer relevant (call ended) — the
            // next interaction will try again; nothing more to do here.
          });
        }
      });
  };

  // Any of these count as a qualifying interaction for autoplay policy
  // purposes across current browsers — listen for whichever fires
  // first, not just clicks, so a keyboard-only user isn't stuck either.
  ["pointerdown", "keydown", "touchstart"].forEach((evt) =>
    document.addEventListener(evt, retryStuckMedia, { passive: true })
  );
}
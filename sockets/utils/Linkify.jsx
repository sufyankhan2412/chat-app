import React from "react";

// Matches http(s) URLs as well as bare "www."-prefixed domains (WhatsApp
// linkifies both), stopping before trailing punctuation/closing brackets
// so "check https://example.com." doesn't swallow the period.
const URL_REGEX = /((?:https?:\/\/|www\.)[^\s<>"']+)/gi;
const TRAILING_PUNCTUATION = /[).,!?;:'"]+$/;

// Recognizes this app's own call-invite links (either a relative path or
// a full URL on any host, since a link may be opened on a different
// device/origin than the one it was generated on) so they can be
// rendered as a proper "Join call" invite chip instead of raw blue text —
// this is the piece that was missing: a pasted link previously rendered
// as inert plain text with no way to tell it was tappable at all.
const CALL_LINK_REGEX = /\/call\/([a-zA-Z0-9-]+)\/?$/;

function normalizeHref(rawUrl) {
  return /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
}

function splitTrailingPunctuation(rawUrl) {
  const match = rawUrl.match(TRAILING_PUNCTUATION);
  if (!match) return [rawUrl, ""];
  // Don't strip a closing paren that has a matching opening paren inside the URL.
  let trail = match[0];
  while (trail.endsWith(")") && (rawUrl.match(/\(/g) || []).length >= (rawUrl.match(/\)/g) || []).length) {
    trail = trail.slice(0, -1);
  }
  if (!trail) return [rawUrl, ""];
  return [rawUrl.slice(0, rawUrl.length - trail.length), trail];
}

function CallInviteChip({ href }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="message-call-invite">
      <span className="message-call-invite-icon">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="23 7 16 12 23 17 23 7" />
          <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
        </svg>
      </span>
      <span className="message-call-invite-info">
        <span className="message-call-invite-title">Call link</span>
        <span className="message-call-invite-subtitle">Tap to join</span>
      </span>
      <span className="message-call-invite-join">Join</span>
    </a>
  );
}

// Renders `text` with any URLs turned into clickable links. A message
// consisting of *only* a single call-invite link renders as the invite
// chip; otherwise call links (and any other URL) render inline as normal
// anchor tags, same as WhatsApp's chat-bubble link handling.
export function linkifyText(text) {
  if (!text) return text;

  const matches = [...text.matchAll(URL_REGEX)];
  if (matches.length === 0) return text;

  if (matches.length === 1 && matches[0][0] === text.trim()) {
    const [cleanUrl] = splitTrailingPunctuation(matches[0][0]);
    const href = normalizeHref(cleanUrl);
    if (CALL_LINK_REGEX.test(href)) {
      return <CallInviteChip href={href} />;
    }
  }

  const nodes = [];
  let lastIndex = 0;
  matches.forEach((match, i) => {
    const start = match.index;
    if (start > lastIndex) nodes.push(text.slice(lastIndex, start));

    const [cleanUrl, trail] = splitTrailingPunctuation(match[0]);
    const href = normalizeHref(cleanUrl);
    nodes.push(
      <a key={`link-${i}`} href={href} target="_blank" rel="noopener noreferrer" className="message-link">
        {cleanUrl}
      </a>
    );
    if (trail) nodes.push(trail);

    lastIndex = start + match[0].length;
  });
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));

  return nodes;
}
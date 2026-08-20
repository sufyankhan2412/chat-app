import React from "react";

// Plain line-style icons matching the rest of the app's icon set (see
// CallModal.jsx / ChatWindow.jsx's header buttons) — not any third-party
// brand's assets.

export function PhoneIcon(props) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}

export function VideoIcon(props) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </svg>
  );
}

// Small diagonal arrow drawn next to a call's title, matching the
// convention WhatsApp's own call log uses: an arrow pointing OUT of the
// icon (up-right) for a call I placed, IN toward it (down-left) for one I
// received — colored red whenever the call was missed, green otherwise.
export function CallDirectionArrow({ outgoing, missed }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke={missed ? "#e05252" : "#25d366"}
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="call-direction-arrow"
      aria-hidden="true"
    >
      {outgoing ? (
        <path d="M8 16 L16 8 M9 8 H16 V15" />
      ) : (
        <path d="M16 8 L8 16 M8 9 V16 H15" />
      )}
    </svg>
  );
}
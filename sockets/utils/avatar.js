const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";

// The API base URL points at .../api, but locally-uploaded avatars are
// served from the server root (see backend Server.js: app.use("/uploads", ...)).
export const ASSET_BASE_URL = API_URL.replace(/\/api\/?$/, "");

// Avatar values can be either:
//  - a full URL (the auto-generated dicebear avatar new users get), or
//  - a relative path like "/uploads/avatars/xyz.jpg" (a local upload)
// This turns either into something an <img src> can load directly.
export function resolveAvatarUrl(avatar) {
  if (!avatar) return "";
  if (/^https?:\/\//i.test(avatar)) return avatar;
  return `${ASSET_BASE_URL}${avatar}`;
}
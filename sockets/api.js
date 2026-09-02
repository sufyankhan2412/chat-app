import axios from "axios";

const API_URL =
  import.meta.env.VITE_API_URL || "http://localhost:5000/api";

const api = axios.create({
  baseURL: API_URL,
});

// Attach shared JWT to every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("token");

  if (!config.headers) {
    config.headers = {};
  }

  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  } else {
    delete config.headers.Authorization;
  }

  return config;
});

export const signup = (data) =>
  api.post("/auth/signup", data);

export const login = (data) =>
  api.post("/auth/login", data);

export const getMe = () =>
  api.get("/auth/me");

export const searchUsers = (q) =>
  api.get(`/users/search?q=${encodeURIComponent(q)}`);

export const addContact = (id) =>
  api.post(`/users/contacts/${id}`);

export const getContacts = () =>
  api.get("/users/contacts");

export const getMessages = (userId, params = {}) =>
  api.get(`/messages/${userId}`, { params });

// Clears the message history with this contact on MY side only —
// WhatsApp-style "Clear chat". The other participant's copy is untouched.
export const clearChat = (userId) => api.delete(`/messages/clear/${userId}`);

// Deletes a single message. `forEveryone: false` (default) removes it from
// only my own view. `forEveryone: true` is sender-only, time-limited, and
// replaces the message with a "This message was deleted" placeholder for
// both participants.
export const deleteMessage = (messageId, forEveryone = false) =>
  api.delete(`/messages/message/${messageId}`, { data: { forEveryone } });

export const undoDeleteMessage = (messageId) =>
  api.post(`/messages/${messageId}/undo-delete`);

// Uploads one chat attachment (image/video/voice/file) and returns
// { attachment: { url, fileName, fileSize, mimeType, duration? } }.
// `type` must be appended to the FormData BEFORE `file` — see the
// comment on the matching backend route for why the order matters.
export const uploadAttachment = (formData) =>
  api.post("/messages/upload", formData, {
    headers: { "Content-Type": "multipart/form-data" },
  });

// formData may include: username, about, avatar (file) — any subset
export const updateProfile = (formData) =>
  api.put("/users/profile", formData);

export const getUserProfile = (id) => api.get(`/users/${id}`);

export const blockUser = (id) => api.post(`/users/block/${id}`);

export const unblockUser = (id) => api.post(`/users/unblock/${id}`);

export const getBlockedUsers = () => api.get("/users/blocked");

export const muteUser = (id) => api.post(`/users/mute/${id}`);

export const unmuteUser = (id) => api.post(`/users/unmute/${id}`);

// duration is in milliseconds; 0 turns disappearing messages off
export const setDisappearing = (id, duration) =>
  api.put(`/users/contacts/${id}/disappearing`, { duration });

export const getMedia = (userId) => api.get(`/messages/${userId}/media`);

export const getStarredMessages = (userId) =>
  api.get(`/messages/${userId}/starred`);

export const starMessage = (id) => api.post(`/messages/${id}/star`);

export const unstarMessage = (id) => api.post(`/messages/${id}/unstar`);

// Every call I've been a part of (as caller or callee), newest first —
// powers the dedicated Calls page.
export const getCallLogs = (params = {}) => api.get("/calls", { params });

// Call history with one specific contact only.
export const getCallLogsWith = (userId, params = {}) =>
  api.get(`/calls/${userId}`, { params });

// ---- Link-based (group) calls ----

// Generates a new joinable call link. Returns { roomId, callType, link }.
// Creating this does NOT create a group/contact/chat — it's a bare,
// disposable room that only the resulting call log survives.
export const createCallLink = (callType = "video") =>
  api.post("/calls/link", { callType });

// Preview info for the join screen (who started it, audio/video, still
// live) before actually joining the room.
export const getCallRoomInfo = (roomId) => api.get(`/calls/room/${roomId}`);

// Full participant-by-participant log for one group call. 403s if I
// wasn't actually a participant.
export const getGroupCallLog = (roomId) => api.get(`/calls/group/${roomId}`);

// "Delete for me" on a group-call log entry.
export const deleteGroupCallLog = (roomId) => api.delete(`/calls/group/${roomId}`);

// Older page of a meeting's persistent chat (cursor pagination via
// `before`, same convention as getMessages). The newest page is already
// delivered over the socket on join/rejoin — this is only for scrolling
// further back.
export const getGroupCallChatHistory = (roomId, params = {}) =>
  api.get(`/calls/group/${roomId}/chat`, { params });

// ---- Group-call audio -> transcript ----

// One ~5s rolling chunk of MY OWN mic audio for this call session (see
// GroupCallContext.jsx's MediaRecorder). `joinedAt` must be the SERVER
// timestamp from the "groupCallJoined" socket event, not a client clock
// reading — the backend uses it to match this upload to the right
// Call.participants entry and to anchor it on the shared call timeline.
export const uploadCallAudioChunk = (roomId, joinedAt, seq, blob) => {
  const formData = new FormData();
  formData.append("joinedAt", joinedAt);
  // `seq` is this join session's chunk ordinal (0, 1, 2, ...), assigned
  // client-side in recording order. Chunk uploads race each other over
  // the network and can land out of order — the server uses `seq` to put
  // them back in the right order before transcribing, instead of trusting
  // arrival order.
  formData.append("seq", seq);
  formData.append("chunk", blob, `chunk-${seq}.webm`);

  // Diagnostic log requested for the recording pipeline: lets a failed
  // transcription be traced back to exactly which chunk(s), from which
  // join session, never made it out of the browser correctly.
  console.debug("[audio-chunk:upload]", {
    recordingId: roomId,
    joinedAt,
    chunkIndex: seq,
    chunkSize: blob.size,
    mimeType: blob.type,
    timestamp: new Date().toISOString(),
  });

  return api.post(`/calls/${roomId}/audio-chunk`, formData, {
    headers: { "Content-Type": "multipart/form-data" },
  });
};

// Poll target while a transcript is being generated —
// { status, missingParticipants, error? }.
export const getTranscriptStatus = (roomId) =>
  api.get(`/calls/${roomId}/transcript/status`);

// Fetches the finished .txt as a Blob (auth'd, so a plain <a href> to the
// API URL wouldn't carry the Bearer token) — the caller turns this into
// a download via URL.createObjectURL.
export const downloadTranscript = (roomId) =>
  api.get(`/calls/${roomId}/transcript`, { responseType: "blob" });

export default api;
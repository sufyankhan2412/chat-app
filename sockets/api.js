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

export default api;
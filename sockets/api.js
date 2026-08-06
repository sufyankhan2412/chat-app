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

export const getMessages = (userId) =>
  api.get(`/messages/${userId}`);

// formData may include: username, about, avatar (file) — any subset
export const updateProfile = (formData) =>
  api.put("/users/profile", formData);

export const getUserProfile = (id) => api.get(`/users/${id}`);

export default api;
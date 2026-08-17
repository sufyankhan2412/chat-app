import React, { useState } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
} from "react-router-dom";
import { AuthProvider, useAuth } from "../context/Authcontext";
import { SocketProvider } from "../context/Socketcontext";
import { CallProvider } from "../context/Callcontext";
import { ProfileModalProvider } from "../context/Profilemodalcontext";
import Login from "../components/Login";
import Signup from "../components/Signup";
import Sidebar from "../components/Sidebar";
import ChatWindow from "../components/ChatWindow";
import ProfileModal from "../components/ProfileModal";
import CallModal from "../components/CallModal";

function SocketProviderWrapper({ children }) {
  const { token, user } = useAuth();
  return (
    <SocketProvider token={token} user={user}>
      <CallProvider>
        {children}
        <CallModal />
      </CallProvider>
    </SocketProvider>
  );
}

function ChatPage() {
  const [activeContact, setActiveContact] = useState(null);
  return (
    <ProfileModalProvider>
      <div className={`chat-page ${activeContact ? "chat-open" : ""}`}>
        <Sidebar activeContact={activeContact} onSelectContact={setActiveContact} />
        <ChatWindow contact={activeContact} onBack={() => setActiveContact(null)} />
      </div>
      <ProfileModal />
    </ProfileModalProvider>
  );
}

function PrivateRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="loading-screen">Loading...</div>;
  return user ? children : <Navigate to="/login" />;
}

function PublicRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="loading-screen">Loading...</div>;
  return user ? <Navigate to="/chat" /> : children;
}

function AppRoutes() {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <PublicRoute>
            <Login />
          </PublicRoute>
        }
      />
      <Route
        path="/signup"
        element={
          <PublicRoute>
            <Signup />
          </PublicRoute>
        }
      />
      <Route
        path="/chat"
        element={
          <PrivateRoute>
            <ChatPage />
          </PrivateRoute>
        }
      />
      <Route path="*" element={<Navigate to="/chat" />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <SocketProviderWrapper>
          <AppRoutes />
        </SocketProviderWrapper>
      </AuthProvider>
    </BrowserRouter>
  );
}
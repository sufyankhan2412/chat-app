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
import ProfileModal from "../components/Profilemodal";
import CallModal from "../components/CallModal";
import CallLogsPage from "../components/CallLogs";

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

// Calls page also opens contact info (via "View contact" in the call
// detail modal), so it needs its own ProfileModalProvider + <ProfileModal />
// the same way ChatPage does — this context isn't global, it's per-page.
function CallsPage() {
  return (
    <ProfileModalProvider>
      <CallLogsPage />
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
      <Route
        path="/calls"
        element={
          <PrivateRoute>
            <CallsPage />
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
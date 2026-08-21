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
import { GroupCallProvider } from "../context/Groupcallcontext";
import { ProfileModalProvider } from "../context/Profilemodalcontext";
import Login from "../components/Login";
import Signup from "../components/Signup";
import Sidebar from "../components/Sidebar";
import ChatWindow from "../components/Chatwindow";
import ProfileModal from "../components/Profilemodal";
import CallModal from "../components/CallModal";
import GroupCallStage from "../components/Groupcallstage"
import CallLogsPage from "../components/Calllogs";
import JoinCallPage from "../components/Joincallpage"

function SocketProviderWrapper({ children }) {
  const { token, user } = useAuth();
  return (
    <SocketProvider token={token} user={user}>
      <CallProvider>
        <GroupCallProvider>
          {children}
          <CallModal />
          {/* Mounted globally (not just on /call/:roomId) because a group
              call can also start mid-conversation via CallModal's "Add
              people" button, from any page in the app. */}
          <GroupCallStage />
        </GroupCallProvider>
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
      {/* Link-based call join screen — anyone with the link needs an
          account and to be logged in (same as every other page here), but
          NOT to be a contact/friend of the caller — this route is the
          whole point of the shareable link. */}
      <Route
        path="/call/:roomId"
        element={
          <PrivateRoute>
            <JoinCallPage />
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
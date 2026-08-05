import React, {
  createContext,
  useContext,
  useEffect,
  useState,
} from "react";

import {
  login as loginApi,
  signup as signupApi,
  getMe,
} from "../api";

const AuthContext = createContext();

export const useAuth = () => useContext(AuthContext);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);

  // IMPORTANT:
  // localStorage is shared by all tabs.
  const [token, setToken] = useState(
    localStorage.getItem("token") || null
  );

  const [loading, setLoading] = useState(true);

  // -----------------------------------
  // Restore session
  // -----------------------------------
  useEffect(() => {
    const init = async () => {
      const storedToken = localStorage.getItem("token");

      if (!storedToken) {
        setLoading(false);
        return;
      }

      try {
        const res = await getMe();

        setUser(res.data.user);
        setToken(storedToken);
      } catch (err) {
        // Token is invalid/expired
        localStorage.removeItem("token");

        setToken(null);
        setUser(null);
      } finally {
        setLoading(false);
      }
    };

    init();
  }, []);

  // -----------------------------------
  // Synchronize all browser tabs
  // -----------------------------------
  useEffect(() => {
    const handleStorageChange = async (event) => {
      if (event.key !== "auth_event" || !event.newValue) {
        return;
      }

      try {
        const authEvent = JSON.parse(event.newValue);

        // -----------------------------------
        // Another tab logged out
        // -----------------------------------
        if (authEvent.type === "LOGOUT") {
          setToken(null);
          setUser(null);

          return;
        }

        // -----------------------------------
        // Another tab logged in
        // -----------------------------------
        if (authEvent.type === "LOGIN") {
          const newToken = localStorage.getItem("token");

          if (!newToken) {
            setToken(null);
            setUser(null);
            return;
          }

          try {
            const res = await getMe();

            setToken(newToken);
            setUser(res.data.user);
          } catch (err) {
            localStorage.removeItem("token");

            setToken(null);
            setUser(null);
          }
        }
      } catch (error) {
        console.error("Invalid auth event:", error);
      }
    };

    window.addEventListener("storage", handleStorageChange);

    return () => {
      window.removeEventListener("storage", handleStorageChange);
    };
  }, []);

  // -----------------------------------
  // Login
  // -----------------------------------
  const login = async (email, password) => {
    // Check if another user is already logged in
    const existingToken = localStorage.getItem("token");

    if (existingToken) {
      try {
        // Verify whether existing token is still valid
        const existingUser = await getMe();

        if (existingUser.data.user) {
          throw new Error(
            "Another user is already logged in. Please logout first."
          );
        }
      } catch (err) {
        // If the error is our own "already logged in" error,
        // stop the login.
        if (
          err.message ===
          "Another user is already logged in. Please logout first."
        ) {
          throw err;
        }

        // Existing token is invalid/expired
        localStorage.removeItem("token");
      }
    }

    // Now login is allowed
    const res = await loginApi({
      email,
      password,
    });

    const newToken = res.data.token;
    const newUser = res.data.user;

    // Shared by every tab
    localStorage.setItem("token", newToken);

    setToken(newToken);
    setUser(newUser);

    // Notify other tabs
    localStorage.setItem(
      "auth_event",
      JSON.stringify({
        type: "LOGIN",
        userId: newUser._id,
        timestamp: Date.now(),
      })
    );

    return newUser;
  };

  // -----------------------------------
  // Signup
  // -----------------------------------
  const signup = async (username, email, password) => {
    // Don't allow signup/login while another
    // user is already active.
    const existingToken = localStorage.getItem("token");

    if (existingToken) {
      try {
        const existingUser = await getMe();

        if (existingUser.data.user) {
          throw new Error(
            "Another user is already logged in. Please logout first."
          );
        }
      } catch (err) {
        if (
          err.message ===
          "Another user is already logged in. Please logout first."
        ) {
          throw err;
        }

        localStorage.removeItem("token");
      }
    }

    const res = await signupApi({
      username,
      email,
      password,
    });

    const newToken = res.data.token;
    const newUser = res.data.user;

    localStorage.setItem("token", newToken);

    setToken(newToken);
    setUser(newUser);

    // Notify other tabs
    localStorage.setItem(
      "auth_event",
      JSON.stringify({
        type: "LOGIN",
        userId: newUser._id,
        timestamp: Date.now(),
      })
    );

    return newUser;
  };

  // -----------------------------------
  // Logout
  // -----------------------------------
  const logout = () => {
    // Remove shared token
    localStorage.removeItem("token");

    setToken(null);
    setUser(null);

    // Tell all other tabs
    localStorage.setItem(
      "auth_event",
      JSON.stringify({
        type: "LOGOUT",
        timestamp: Date.now(),
      })
    );
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        loading,
        login,
        signup,
        logout,
        setUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};
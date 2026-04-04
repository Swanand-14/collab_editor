"use client";

import { useEffect, useRef, useState,useCallback } from "react";
import { Socket, io } from "socket.io-client";

// Import types from server
export interface CollabUser {
  userId: string;
  userName: string;
  userImage?: string;
  role: string;
  activeFile?: string;
  cursor?: {
    fileId: string;
    position: { lineNumber: number; column: number };
  };
}

// Define payload types here to avoid circular imports
export interface EditorChangePayload {
  sessionId: string;
  userId?: string;
  userName?: string;
  fileId: string;
  filePath: string;
  content: string;
  changes: any;
  timestamp: number;
}

export interface CursorPositionPayload {
  sessionId: string;
  userId?: string;
  userName?: string;
  fileId: string;
  filePath: string;
  position: {
    lineNumber: number;
    column: number;
  };
  selection?: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  };
}

export interface FileActionPayload {
  sessionId: string;
  userId?: string;
  userName?: string;
  action: "create" | "delete" | "rename";
  filePath: string;
  newPath?: string;
  content?: string;
}

export function useCollabSocket(sessionId: string, userId?: string, userName?: string,onError?:(message:string,details?:string) => void) {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [participants, setParticipants] = useState<CollabUser[]>([]);
  const recentActivityIds = useRef<Set<string>>(new Set());
  const hasRequestedInitialData = useRef(false); // 🔥 NEW: Prevent double request

  const socketRef = useRef<Socket | null>(null);
  const hasJoinedRef = useRef(false);

  useEffect(() => {
     console.log("\n🚀 useCollabSocket effect triggered");
    console.log("   userId:", userId);
    console.log("   userName:", userName);
    console.log("   sessionId:", sessionId);

    // 🔥 CRITICAL FIX: Don't connect if userId/userName not ready
    if (!userId || !userName || userName === "Anonymous") {
      console.warn("⏳ Waiting for auth data...");
      return;
    }

    // 🔥 CRITICAL FIX: Prevent duplicate connections
    if (socketRef.current?.connected) {
      console.log("♻️ Socket already connected, skipping");
      return;
    }

    console.log("✅ Auth data ready, initializing socket");

    // Initialize socket connection
    const socketInstance = io({
      path: "/api/socket",
      addTrailingSlash: false,
    });

    socketRef.current = socketInstance;
    setSocket(socketInstance);

    // Connection events
    socketInstance.on("connect", () => {
      console.log("✅ Connected to collaboration server");
      setIsConnected(true);

      // Join the collaboration session
      if (!hasJoinedRef.current) {
        console.log("📤 Emitting collab:join with:", { sessionId, userId, userName });
        
        socketInstance.emit("collab:join", {
          sessionId,
          userId,
          userName,
        });
        
        hasJoinedRef.current = true;
      } else {
        console.log("⚠️ Already joined, skipping join emission");
      }
    });

    socketInstance.on("disconnect", () => {
      console.log("❌ Disconnected from collaboration server");
      setIsConnected(false);
      hasJoinedRef.current = false;
    });

    // Session events
    socketInstance.on("collab:joined", (data: { participants: CollabUser[] }) => {
      console.log("✅ Joined collaboration session", data);
      setParticipants(data.participants);
    });

    socketInstance.on("collab:user-joined", (data: { userId: string; userName: string }) => {
      console.log("👤 User joined:", data.userName);
      setParticipants((prev) => {
        // 🔥 FIX: Check if already exists
        if (prev.some(p => p.userId === data.userId)) {
          console.log("⚠️ User already in list, skipping");
          return prev;
        }
        return [...prev, { userId: data.userId, userName: data.userName, role: "editor" }];
      });
    });

    socketInstance.on("collab:user-left", (data: { userId: string; userName: string }) => {
      console.log("👤 User left:", data.userName);
      setParticipants((prev) => prev.filter((p) => p.userId !== data.userId));
    });

    socketInstance.on("collab:error", (data: { message: string,details:string }) => {
      console.error("❌ Collaboration error:", data.message);
      onError?.(data.message,data.details);
    });

    // Cleanup
    return () => {
      console.log("🧹 Cleaning up socket connection");
      hasJoinedRef.current = false;
      socketInstance.disconnect();
      socketRef.current = null;
    };
  }, [sessionId, userId, userName]);

  // Helper functions to emit events
  const emitEditorChange = (payload: Omit<EditorChangePayload, "userId" | "userName" | "sessionId">) => {
    socket?.emit("editor:change", { ...payload, sessionId, userId, userName });
  };

  const emitCursorMove = useCallback((payload: Omit<CursorPositionPayload, "userId" | "userName" | "sessionId">) => {

    const currentSocket = socketRef.current;
    if (!currentSocket || !currentSocket.connected) {
      console.warn('[Socket] ⚠️ Cannot emit cursor: socket not connected');
      return;
    }
  // 🔥 ADD: Validation
  if (!payload.fileId || !payload.filePath) {
    console.warn('[Socket] ⚠️ Cannot emit cursor: missing fileId or filePath');
    return;
  }

  const fullPayload = { 
    ...payload, 
    sessionId, 
    userId, 
    userName 
  };

  // 🔥 ADD: Log emission
  console.log('[Socket Emit] 📤 cursor:move', {
    sessionId,
    userId,
    userName,
    fileId: payload.fileId,
    filePath: payload.filePath,
    line: payload.position.lineNumber,
    column: payload.position.column
  });
  console.log("🔍 Socket status:", {
  connected: currentSocket?.connected,
  id: currentSocket?.id,
  hasEventListeners: socket?.hasListeners("cursor:move")
});

  currentSocket?.emit("cursor:move", fullPayload);

  
},  [sessionId, userId, userName]);

  const emitFileAction = useCallback((payload: Omit<FileActionPayload, "userId" | "userName" | "sessionId">) => {
    socketRef.current?.emit("file:action", { ...payload, sessionId, userId, userName });
  },[sessionId, userId, userName]);
  const emitFileChange = useCallback((fileId: string, content: string, action: 'update' | 'delete') => {
    socketRef.current?.emit('file:change', { fileId, content, action });
  },[sessionId, userId, userName]);

  const emitFileOpen = useCallback((fileId: string, filePath: string) => {
    socketRef.current?.emit("file:open", { fileId, filePath });
  },[]);

  const emitPresenceUpdate = useCallback((status: "online" | "away" | "offline", activeFile?: string) => {
    socketRef.current?.emit("presence:update", { status, activeFile });
  },[]);

  const emitWebContainerCommand = useCallback(
    (command: "start" | "stop" | "restart") => {
      socketRef.current?.emit("webcontainer:command", {
        sessionId,
        userId,
        userName,
        command,
        timestamp: Date.now(),
      });
    },
    [socket, sessionId, userId, userName]
  );

  return {
    socket,
    isConnected,
    participants,
    emitEditorChange,
    emitCursorMove,
    emitFileAction,
    emitFileOpen,
    emitPresenceUpdate,
    emitFileChange,emitWebContainerCommand
  };
}
// ============================================
// 🔥 CREATE NEW FILE: hooks/useCollabParticipants.ts
// ============================================
"use client";

import { useEffect, useState,useRef } from "react";
import { Socket } from "socket.io-client";

export interface ParticipantInfo {
  userId: string;
  userName: string;
  userImage?: string;
  role: string;
  socketId: string;
  joinedAt: number;
  lastActivity: number;
  activeFile?: string;
  cursor?: {
    fileId: string;
    position: { lineNumber: number; column: number };
  };
}

export interface ActivityLogEntry {
  id: string;
  userId: string;
  userName: string;
  action: string;
  details?: string;
  timestamp: number;
  fileId?: string;
  filePath?: string;
}

interface UseCollabParticipantsProps {
  socket: Socket | null;
  sessionId: string;
  currentUserId?: string;
}

export function useCollabParticipants({
  socket,
  sessionId,
  currentUserId,
}: UseCollabParticipantsProps) {
  const [participants, setParticipants] = useState<ParticipantInfo[]>([]);
  const [activityLogs, setActivityLogs] = useState<ActivityLogEntry[]>([]);
  const recentActivityIds = useRef<Set<string>>(new Set());
  const hasRequestedInitialData = useRef(false);

  useEffect(() => {
    if (!socket) return;

    console.log("👥 Setting up participant listeners");

    // ============================================
    // 1️⃣ Initial participant list
    // ============================================
    const handleParticipantsUpdated = (data: { participants: ParticipantInfo[] }) => {
      console.log("📡 Received participants update:", data.participants.length);
      
      // 🔥 FIX: Deduplicate by userId
      const uniqueParticipants = new Map<string, ParticipantInfo>();
      data.participants.forEach(p => {
        uniqueParticipants.set(p.userId, p);
      });
      
      setParticipants(Array.from(uniqueParticipants.values()));
    };

    // ============================================
    // 2️⃣ Participant activity updates (file/cursor)
    // ============================================
    const handleParticipantActivity = (data: {
      userId: string;
      activeFile?: string;
      cursor?: any;
      lastActivity: number;
    }) => {
      setParticipants(prev => 
        prev.map(p => 
          p.userId === data.userId
            ? { ...p, activeFile: data.activeFile, cursor: data.cursor, lastActivity: data.lastActivity }
            : p
        )
      );
    };

    // ============================================
    // 3️⃣ Initial activity logs
    // ============================================
    const handleActivityLogs = (data: { logs: ActivityLogEntry[] }) => {
      console.log("📡 Received activity logs:", data.logs.length);
      recentActivityIds.current.clear();
      data.logs.forEach(log => {
        recentActivityIds.current.add(log.id);
      });
      setActivityLogs(data.logs);
    };

    // ============================================
    // 4️⃣ New activity entry
    // ============================================
    const handleNewActivity = (activity: ActivityLogEntry) => {
      // 🔥 FIX: Don't add duplicate if it's your own action
      if (activity.userId === currentUserId) {
        // Already logged locally, skip
        return;
      }
       if (recentActivityIds.current.has(activity.id)) {
        console.log("⚠️ Duplicate activity blocked on client:", activity.id);
        return;
      }
      const activityKey = `${activity.userId}-${activity.action}-${Math.floor(activity.timestamp / 2000)}`;

      setActivityLogs(prev => {
        // Check if already exists (by id)
        const hasSimilar = prev.slice(0, 5).some(a => {
          const existingKey = `${a.userId}-${a.action}-${Math.floor(a.timestamp / 2000)}`;
          return existingKey === activityKey;
        });
        
        if (hasSimilar) {
          console.log("⚠️ Similar activity already exists, skipping");
          return prev;
        }
        recentActivityIds.current.add(activity.id);
        
        // Clean up old IDs (keep last 100)
        if (recentActivityIds.current.size > 100) {
          const oldIds = Array.from(recentActivityIds.current).slice(0, recentActivityIds.current.size - 100);
          oldIds.forEach(id => recentActivityIds.current.delete(id));
        }
      
        
        // Add to front, keep last 50
        const updated = [activity, ...prev];
        return updated.slice(0, 50);
      });
    };

    // ============================================
    // 5️⃣ Attach listeners
    // ============================================
    socket.on("collab:participants-updated", handleParticipantsUpdated);
    socket.on("collab:participant-activity", handleParticipantActivity);
    socket.on("collab:activity-logs", handleActivityLogs);
    socket.on("collab:activity-new", handleNewActivity);

    // ============================================
    // 6️⃣ Request initial data
    // ============================================
    socket.emit("collab:request-participants", { sessionId });
    socket.emit("collab:request-activity", { sessionId });

    // ============================================
    // 7️⃣ Cleanup
    // ============================================
    return () => {
      socket.off("collab:participants-updated", handleParticipantsUpdated);
      socket.off("collab:participant-activity", handleParticipantActivity);
      socket.off("collab:activity-logs", handleActivityLogs);
      socket.off("collab:activity-new", handleNewActivity);
    };
  }, [socket, sessionId, currentUserId]);

  // ============================================
  // Helper: Update your own activity
  // ============================================
  const updateActivity = (activeFile?: string, cursor?: any) => {
    if (socket) {
      socket.emit("collab:update-activity", {
        sessionId,
        activeFile,
        cursor,
      });
    }
  };

  return {
    participants,
    activityLogs,
    updateActivity,
  };
}
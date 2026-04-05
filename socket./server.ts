import {Server as HttpServer} from 'http';
import {Server as SocketIOServer,Socket} from 'socket.io';
import { prisma } from '../db';

export interface CollabSocket extends Socket{
    userId?:string;
    sessionId?:string,
    userName?:string
}

export interface EditorChangePayload {
  sessionId: string;
  userId: string;
  userName: string;
  fileId: string;
  filePath: string;
  content: string;
  changes: any; // Monaco IModelContentChange[]
  timestamp: number;
}

export interface CursorPositionPayload {
  sessionId: string;
  userId: string;
  userName: string;
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
  userId: string;
  userName: string;
  action: "create" | "delete" | "rename";
  filePath: string;
  newPath?: string;
  content?: string;
}

export interface UserPresencePayload {
  sessionId: string;
  userId: string;
  userName: string;
  userImage?: string;
  activeFile?: string;
  status: "online" | "away" | "offline";
}

export interface ParticipantInfo {
  userId: string;
  userName: string;
  userImage?: string;
  role: string;
  socketId: string;
  joinedAt: number;
  lastActivity: number;
  activeFile?: string;
  socketIds: Set<string>;
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

type SerializedParticipant = {
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
};



// 🔥 NEW: WebContainer state management
interface WebContainerState {
  hostSocketId: string | null;
  hostUserId: string | null;
  serverUrl: string | null;
  isRunning: boolean;
  terminalHistory: string[];
  lastUpdate: number;
}

const sessionStates = new Map<string, WebContainerState>();
const sessionParticipants = new Map<string, Map<string, ParticipantInfo>>();
const sessionActivityLogs = new Map<string, ActivityLogEntry[]>();
const recentActivityIds = new Map<string, Set<string>>();

function isValidParticipant(userId?:string,userName?:string):boolean{
  if(!userId || !userName){
    console.warn("Invalid participant,missing username or userid",{userId,userName})
    return false;
  }
  if(userName==="Anonymous"){
    console.warn("Rejecting anomynous user ")
    return false;
  }

   if (userId.startsWith("guest-")) {
    console.warn("❌ Rejecting guest user without proper auth");
    return false;
  }
  
  return true;
}
function serializeParticipant(p: ParticipantInfo) {
  return {
    userId: p.userId,
    userName: p.userName,
    userImage: p.userImage,
    role: p.role,
    socketId: Array.from(p.socketIds)[0], // Send first socket for compatibility
    joinedAt: p.joinedAt,
    lastActivity: p.lastActivity,
    activeFile: p.activeFile,
    cursor: p.cursor,
  };
}
function addParticipant(sessionId: string, participant: ParticipantInfo): boolean {
  if (!sessionParticipants.has(sessionId)) {
    sessionParticipants.set(sessionId, new Map());
  }
  
  const participants = sessionParticipants.get(sessionId)!;
  const existing = participants.get(participant.userId);
  if (existing) {
    console.log(`♻️ Updating existing participant: ${participant.userName} (${participant.userId})`);
    const isNewSocket = !existing.socketIds.has(Array.from(participant.socketIds)[0]);

    // Update socketId for reconnection, keep other data
    // Update name in case it changed
    if (isNewSocket) {
      // Add the new socket to the set
      participant.socketIds.forEach(socketId => existing.socketIds.add(socketId));
      existing.lastActivity = Date.now();
      existing.userName = participant.userName; 
      existing.userImage = participant.userImage || existing.userImage;
      
      console.log(`♻️ Added new connection for ${existing.userName}: ${Array.from(participant.socketIds)[0]}`);
      console.log(`   Total connections for ${existing.userName}: ${existing.socketIds.size}`);
      
      return false; // Not a new join (user already existed)
    } else {
      console.log(`⚠️ Socket already tracked for ${existing.userName}`);
      return false;
    }
  }
  // 🔥 FIX: Use userId as key (prevents duplicates)
  participants.set(participant.userId, participant);
  
  console.log(`✅ Participant added: ${participant.userName} (${participant.userId})`);
  console.log(`   Initial connections: ${participant.socketIds.size}`);
  console.log(`   Total participants: ${participants.size}`);
  return true;
}

async function enrichParticipantsWithImages(
  sessionId: string
): Promise<SerializedParticipant[]> {
  const participants = sessionParticipants.get(sessionId);
  if (!participants) return [];

  const enrichedParticipants: SerializedParticipant[] = [];

  for (const participant of participants.values()) {
    let userImage = participant.userImage;

    // If image is missing, fetch it from database
    if (!userImage && participant.userId && !participant.userId.startsWith("guest-")) {
      try {
        const user = await prisma.user.findUnique({
          where: { id: participant.userId },
          select: { image: true },
        });
        userImage = user?.image || undefined;
        
        // Update in-memory cache
        participant.userImage = userImage;
      } catch (error) {
        console.error(`Failed to fetch image for user ${participant.userId}:`, error);
      }
    }

    enrichedParticipants.push(serializeParticipant(participant));
  }

  return enrichedParticipants;
}
function removeParticipant(sessionId: string, socketId: string): { 
  participant: ParticipantInfo | null; 
  wasLastConnection: boolean;
} {
  const participants = sessionParticipants.get(sessionId);
  if (!participants) {
    console.warn(`⚠️ No participants map for session ${sessionId}`);
    return { participant: null, wasLastConnection: false };
  }
  
  console.log(`🔍 Searching for socketId ${socketId} in ${participants.size} participants`);
  
  let foundParticipant: ParticipantInfo | null = null;
  let wasLastConnection = false;
  
  for (const [userId, participant] of participants.entries()) {
    if (participant.socketIds.has(socketId)) {
      foundParticipant = participant;
      
      // 🔥 Remove this socket from the set
      participant.socketIds.delete(socketId);
      
      console.log(`✅ Removed socket ${socketId} from ${participant.userName}`);
      console.log(`   Remaining connections: ${participant.socketIds.size}`);
      
      // 🔥 If no connections left, remove participant entirely
      if (participant.socketIds.size === 0) {
        participants.delete(userId);
        wasLastConnection = true;
        console.log(`✅ LAST CONNECTION - Removed ${participant.userName} from session`);
        console.log(`   Remaining participants: ${participants.size}`);
      } else {
        console.log(`⏳ ${participant.userName} still has ${participant.socketIds.size} connection(s)`);
      }
      
      break;
    }
  }
  
  if (!foundParticipant) {
    console.error(`❌ Could not find participant with socketId ${socketId}`);
  }
  
  return { participant: foundParticipant, wasLastConnection };
}
function getParticipants(sessionId: string) {
  const participants = sessionParticipants.get(sessionId);
  if (!participants) return [];
  
  // Serialize for broadcasting (convert Set to array)
  return Array.from(participants.values()).map(serializeParticipant);
}

function isActivityDuplicate(sessionId: string, activityId: string): boolean {
  if (!recentActivityIds.has(sessionId)) {
    recentActivityIds.set(sessionId, new Set());
  }
  
  const ids = recentActivityIds.get(sessionId)!;
  
  if (ids.has(activityId)) {
    console.log(`⚠️ Duplicate activity blocked: ${activityId}`);
    return true;
  }
  
  // Add to set
  ids.add(activityId);
  
  // Clean up old IDs (keep last 100)
  if (ids.size > 100) {
    const oldIds = Array.from(ids).slice(0, ids.size - 100);
    oldIds.forEach(id => ids.delete(id));
  }
  
  return false;
}

function logActivity(
  sessionId: string,
  userId: string,
  userName: string,
  action: string,
  details?: string,
  fileId?: string,
  filePath?: string
): ActivityLogEntry | null {
  if (!sessionActivityLogs.has(sessionId)) {
    sessionActivityLogs.set(sessionId, []);
  }
  
  const logs = sessionActivityLogs.get(sessionId)!;
  
  // 🔥 FIX: Create stable ID based on content + timestamp (rounded to second)
  const timestamp = Date.now();
  const timestampSecond = Math.floor(timestamp / 1000) * 1000; // Round to second
  const activityId = `${userId}-${action}-${timestampSecond}`;
  
  // 🔥 FIX: Check for duplicate
  if (isActivityDuplicate(sessionId, activityId)) {
    return null; // Skip duplicate
  }
  
  const entry: ActivityLogEntry = {
    id: `${timestamp}-${userId}-${Math.random().toString(36).substr(2, 9)}`, // Unique display ID
    userId,
    userName,
    action,
    details,
    timestamp,
    fileId,
    filePath,
  };
  
  logs.unshift(entry);
  
  if (logs.length > 50) {
    logs.length = 50;
  }
  
  console.log(`📝 Activity logged: ${userName} ${action}`);
  return entry;
}

function getActivityLogs(sessionId: string): ActivityLogEntry[] {
  return sessionActivityLogs.get(sessionId) || [];
}

let io:SocketIOServer|null = null;

export function initSocketServer(httpServer:HttpServer):SocketIOServer{
    if(io){
        return io;
    }


    io = new SocketIOServer(httpServer,{
        cors:{
            origin:process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
            methods:["GET","POST"],
            credentials:true
        },
        path:"/api/socket",
        addTrailingSlash:false
    })
    
    io.on("connection",async(socket:CollabSocket)=>{
        console.log("Client connected:",socket.id);

        // ============================================
        // COLLAB: Join Session
        // ============================================
        socket.on("collab:join",async(data:{sessionId:string;userId?:string;userName?:string})=>{
            const {sessionId,userId,userName} = data;
            console.log("\n📥 JOIN REQUEST:", {
              sessionId,
              userId,
              userName,
              socketId: socket.id
            });
            try {
                const session = await prisma.collabSession.findUnique({
                  where: { sessionId },
                  select: {
                    id: true,
                    sessionId: true,
                    isActive: true,
                    expiresAt: true,
                    hostId: true, // 🔥 NEW: Get host ID
                  }
                });

                if (!session || !session.isActive || new Date() > session.expiresAt) {
                  socket.emit("collab:error", { message: "Session not found or expired" });
                  return;
                }

                if (!isValidParticipant(userId, userName)) {
                  console.error("❌ REJECTED: Invalid participant data");
                  socket.emit("collab:error", { 
                    message: "Authentication required. Please wait for auth to complete." 
                  });
                  return;
                }

                // Store user info on socket
                socket.userId = userId || `guest-${socket.id}`;
                socket.sessionId = sessionId;
                socket.userName = userName || "Anonymous";

                // Join the session room
                socket.join(sessionId);

                // Update participant's last seen
                if (userId) {
                  await prisma.collabParticipant.updateMany({
                    where: { sessionId: session.id, userId },
                    data: { lastSeenAt: new Date() },
                  });
                }

                // Get all participants in the session
                const participants = await prisma.collabParticipant.findMany({
                  where: { sessionId: session.id },
                  include: { user: { select: { id: true, name: true, image: true } } },
                });

                // Notify user they joined successfully
                socket.emit("collab:joined", {
                  sessionId,
                  participants: participants.map((p) => ({
                    userId: p.userId,
                    userName: p.user?.name || p.displayName || "Anonymous",
                    userImage: p.user?.image,
                    role: p.role,
                    joinedAt: p.joinedAt,
                  })),
                });

                const isHost = session.hostId === userId;
                const role = isHost ? "Host" : "Guest";
                if (!isHost) {
  // Guest trying to join — check if host is present in the room
  const room = io!.sockets.adapter.rooms.get(sessionId);
  const socketsInRoom = room ? Array.from(room) : [];
  
  // Check if any socket in the room belongs to the host
  const hostPresent = socketsInRoom.some(socketId => {
    const s = io!.sockets.sockets.get(socketId) as CollabSocket;
    return s?.userId === session.hostId;
  });

  if (!hostPresent) {
    console.log(`❌ Guest ${userName} blocked — host not present in session ${sessionId}`);
    socket.emit("collab:error", { 
      message: "HOST_NOT_PRESENT",
      details: "The host has not joined yet. Please wait for the host to start the session."
    });
    return;
  }
}

                console.log(`🎭 Role determined: ${role} (hostId: ${session.hostId}, userId: ${userId})`);
                const userWithImage = await prisma.user.findUnique({
      where: { id: userId },
      select: { image: true }
    });

                const participantInfo: ParticipantInfo = {
                  userId: socket.userId,
                  userName: socket.userName,
                  role: role, 
                  socketIds: new Set([socket.id]),
                  joinedAt: Date.now(),
                  lastActivity: Date.now(),
                  socketId: socket.id,
                  userImage: userWithImage?.image || undefined,
                };

                const isNewJoin = addParticipant(sessionId, participantInfo);
                
                // Log join activity
               let activityEntry = null;
    if (isNewJoin) {
      activityEntry = logActivity(
        sessionId,
        participantInfo.userId,
        participantInfo.userName,
        "joined",
        `Joined as ${role}`
      );
    } else {
      console.log(`⏭️ Skipping join activity (user already in session)`);
    }


                // Notify others in the room
                const allParticipants = await enrichParticipantsWithImages(sessionId);
                console.log(`📢 Broadcasting ${allParticipants.length} participants to session`);
                
                io!.to(sessionId).emit("collab:participants-updated", {
                  participants: allParticipants,
                });
                
                // Send activity logs to the new user
                socket.emit("collab:activity-logs", {
                  logs: getActivityLogs(sessionId),
                });
                if (activityEntry) {
      socket.to(sessionId).emit("collab:activity-new", activityEntry);
    }

                // Broadcast activity to others (not yourself)
                
                // Notify others using old system
                socket.to(sessionId).emit("collab:user-joined", {
                  userId: socket.userId,
                  userName: socket.userName,
                  timestamp: Date.now(),
                });

                console.log(`✅ User ${socket.userName} joined session ${sessionId} as ${role}\n`);

            } catch (error) {
                console.error("Error joining collab session:", error);
                socket.emit("collab:error", { message: "Failed to join session" });
            }
        });

//         socket.on("collab:request-participants", (data: { sessionId: string }) => {
//   const participants = getParticipants(data.sessionId);
//   socket.emit("collab:participants-updated", { participants });
// });

socket.on("collab:request-participants", async (data: { sessionId: string }) => {
  const participants = await enrichParticipantsWithImages(data.sessionId);
  socket.emit("collab:participants-updated", { participants });
});





        
      
      

socket.on("collab:request-activity", (data: { sessionId: string }) => {
  const logs = getActivityLogs(data.sessionId);
  socket.emit("collab:activity-logs", { logs });

});
        socket.on("collab:update-activity", (data: {
  sessionId: string;
  activeFile?: string;
  cursor?: { fileId: string; position: any };
}) => {
  if (!socket.sessionId || !socket.userId) return;
  
  const participants = sessionParticipants.get(socket.sessionId);
  if (!participants) return;
  
  const participant = participants.get(socket.userId);
  if (participant) {
    participant.lastActivity = Date.now();
    if (data.activeFile !== undefined) participant.activeFile = data.activeFile;
    if (data.cursor !== undefined) participant.cursor = data.cursor;
    
    // Broadcast updated participant info
    socket.to(socket.sessionId).emit("collab:participant-activity", {
      userId: socket.userId,
      activeFile: participant.activeFile,
      cursor: participant.cursor,
      lastActivity: participant.lastActivity,
    });
  }
});



        // ============================================
        // COLLAB: Editor & File Operations
        // ============================================
        socket.on("editor:change", (payload: EditorChangePayload) => {
          if (!socket.sessionId) return;

          // Broadcast to all other users in the session
          socket.to(socket.sessionId).emit("editor:change", {
            ...payload,
            userId: socket.userId,
            userName: socket.userName,
          });

          if (socket.sessionId && socket.userId && socket.userName) {
    const activityEntry = logActivity(
      socket.sessionId,
      socket.userId,
      socket.userName,
      "edited file",
      `Modified ${payload.filePath}`,
      payload.fileId,
      payload.filePath
    );
      if (activityEntry) {
      socket.to(socket.sessionId).emit("collab:activity-new", activityEntry);
    }
   
    
  }
        });

        socket.onAny((eventName, ...args) => {
  console.log(`📨 [Server] Received event: ${eventName}`, {
    from: socket.userName,
    sessionId: socket.sessionId,
    argsCount: args.length
  });
});

        socket.on("cursor:move", (payload: CursorPositionPayload) => {
          if (!socket.sessionId) return;
          console.log(`[Server] 👆 Cursor from ${socket.userName || 'Unknown'}:`, {
    file: payload.filePath,
    line: payload.position.lineNumber,
    column: payload.position.column,
    hasSelection: !!payload.selection,
    session: socket.sessionId
  });

  // 🔥 FIX: Use consistent event name "collab:remote-cursor"
  // 🔥 FIX: Include filePath in broadcast
  socket.to(socket.sessionId).emit("collab:remote-cursor", {
    userId: socket.userId,
    userName: socket.userName,
    fileId: payload.fileId,
    filePath: payload.filePath, // ✅ Now included!
    position: payload.position,
    selection: payload.selection,
    timestamp: Date.now() // ✅ Added for staleness detection
  });

  console.log(`[Server] 📡 Broadcasted cursor to session ${socket.sessionId} (excluding ${socket.userName})`);
        });

        socket.on("file:action", (payload: FileActionPayload) => {
          if (!socket.sessionId) return;

          socket.to(socket.sessionId).emit("file:action", {
            ...payload,
            userId: socket.userId,
            userName: socket.userName,
          });

          if (socket.sessionId && socket.userId && socket.userName) {
    const actionText = {
      create: "created",
      delete: "deleted",
      rename: "renamed",
    }[payload.action];
    
   const activityEntry =  logActivity(
      socket.sessionId,
      socket.userId,
      socket.userName,
      actionText,
      payload.action === "rename" 
        ? `${payload.filePath} → ${payload.newPath}`
        : payload.filePath,
      undefined,
      payload.filePath
    );
    
     if (activityEntry) {
      socket.to(socket.sessionId).emit("collab:activity-new", activityEntry);
    }
  }
        });

        socket.on("file:open", (payload: { fileId: string; filePath: string }) => {
  if (!socket.sessionId || !socket.userId) return;

  // 🔥 NEW: Update participant's active file
  const participants = sessionParticipants.get(socket.sessionId);
  if (participants) {
    const participant = participants.get(socket.userId);
    if (participant) {
      participant.activeFile = payload.filePath;
      participant.lastActivity = Date.now();
      
      console.log(`📂 ${socket.userName} opened: ${payload.filePath}`);
      
      // 🔥 Broadcast updated participant info
      socket.to(socket.sessionId).emit("collab:participant-activity", {
        userId: socket.userId,
        userName: socket.userName,
        activeFile: payload.filePath,
        lastActivity: participant.lastActivity,
      });
    }
  }

  // Keep the existing broadcast for backward compatibility
  socket.to(socket.sessionId).emit("user:file-changed", {
    userId: socket.userId,
    userName: socket.userName,
    fileId: payload.fileId,
    filePath: payload.filePath,
  });
});

        socket.on("presence:update", (payload: Partial<UserPresencePayload>) => {
          if (!socket.sessionId) return;

          socket.to(socket.sessionId).emit("presence:update", {
            ...payload,
            userId: socket.userId,
            userName: socket.userName,
            sessionId: socket.sessionId,
          });
        });

        // ============================================
        // 🔥 NEW: WEBCONTAINER - Server Ready
        // ============================================
        socket.on("webcontainer:server-ready", (data: {
          sessionId: string;
          serverUrl: string;
          isRunning: boolean;
        }) => {
          console.log(`📡 [SERVER] Host ${socket.id} server ready: ${data.serverUrl}`);
          
          // Store/update state
          let state = sessionStates.get(data.sessionId);
          if (!state) {
            state = {
              hostSocketId: socket.id,
              hostUserId: socket.userId || null,
              serverUrl: null,
              isRunning: false,
              terminalHistory: [],
              lastUpdate: Date.now(),
            };
            sessionStates.set(data.sessionId, state);
          }
          
          state.hostSocketId = socket.id;
          state.hostUserId = socket.userId || null;
          state.serverUrl = data.serverUrl;
          state.isRunning = data.isRunning;
          state.lastUpdate = Date.now();
          
          // Broadcast to all guests in session
          socket.to(data.sessionId).emit("webcontainer:server-ready", {
            sessionId: data.sessionId,
            serverUrl: data.serverUrl,
            isRunning: data.isRunning,
          });
          
          console.log(`✅ Broadcasted server URL to session ${data.sessionId}`);
        });

        // ============================================
        // 🔥 NEW: WEBCONTAINER - State Updates
        // ============================================
        socket.on("webcontainer:state", (data: {
          sessionId: string;
          isLoading: boolean;
          isServerRunning: boolean;
          error: string | null;
        }) => {
          console.log(`📡 [SERVER] Host ${socket.id} state update for ${data.sessionId}`);
          
          const state = sessionStates.get(data.sessionId);
          if (state) {
            state.isRunning = data.isServerRunning;
            state.lastUpdate = Date.now();
          }
          
          // Broadcast to guests
          socket.to(data.sessionId).emit("webcontainer:state", data);
        });

        // ============================================
        // 🔥 NEW: WEBCONTAINER - Terminal Output
        // ============================================
        socket.on("webcontainer:terminal", (data: {
          sessionId: string;
          data: string;
          timestamp: number;
        }) => {
          // Store in history (limit to last 1000 entries)
          const state = sessionStates.get(data.sessionId);
          if (state) {
            state.terminalHistory.push(data.data);
            if (state.terminalHistory.length > 1000) {
              state.terminalHistory = state.terminalHistory.slice(-1000);
            }
            state.lastUpdate = Date.now();
          }
          
          // Broadcast to guests (real-time)
          socket.to(data.sessionId).emit("webcontainer:terminal", data);
        });

        // ============================================
        // 🔥 NEW: WEBCONTAINER - Request Initial Sync
        // ============================================
        socket.on("webcontainer:request-sync", (data: {
          sessionId: string;
        }) => {
          console.log(`📡 [SERVER] Guest ${socket.id} requesting sync for ${data.sessionId}`);
          
          const state = sessionStates.get(data.sessionId);
          
          if (state && state.hostSocketId && state.serverUrl) {
            // Send current state to requesting guest
            socket.emit("webcontainer:initial-sync", {
              sessionId: data.sessionId,
              serverUrl: state.serverUrl,
              isServerRunning: state.isRunning,
              terminalHistory: state.terminalHistory,
            });
            
            console.log(`✅ [SERVER] Sent initial sync to ${socket.id}`);
          } else {
            // No host yet or host hasn't booted container
            socket.emit("webcontainer:initial-sync", {
              sessionId: data.sessionId,
              serverUrl: null,
              isServerRunning: false,
              terminalHistory: ["⏳ Waiting for host to start WebContainer...\r\n"],
            });
            
            console.log(`⚠️ [SERVER] No host state available for ${data.sessionId}`);
          }
        });

        // ============================================
        // 🔥 NEW: WEBCONTAINER - File Sync Request (Guest → Host)
        // ============================================
        socket.on("webcontainer:file-sync", (data: {
          sessionId: string;
          path: string;
          content: string;
          userId: string;
        }) => {
          console.log(`📡 [SERVER] Guest ${socket.id} file sync: ${data.path}`);
          
          const state = sessionStates.get(data.sessionId);
          
          if (state && state.hostSocketId) {
            // Forward to host
            io!.to(state.hostSocketId).emit("webcontainer:file-sync", data);
            console.log(`✅ Forwarded file sync to host ${state.hostSocketId}`);
          } else {
            // No host available
            socket.emit("webcontainer:sync-error", {
              sessionId: data.sessionId,
              path: data.path,
              error: "Host is not available",
            });
            console.warn(`⚠️ No host available for session ${data.sessionId}`);
          }
        });

        // ============================================
        // 🔥 NEW: WEBCONTAINER - Sync Error
        // ============================================
        socket.on("webcontainer:sync-error", (data: {
          sessionId: string;
          path: string;
          error: string;
        }) => {
          // Broadcast error to all guests
          socket.to(data.sessionId).emit("webcontainer:sync-error", data);
        });

        // ============================================
        // 🔥 NEW: WEBCONTAINER - Command (for future extensibility)
        // ============================================
        socket.on("webcontainer:command", (data: {
          sessionId: string;
          userId: string;
          userName: string;
          command: "start" | "stop" | "restart";
          timestamp: number;
        }) => {
          console.log(`📡 [SERVER] Command ${data.command} from ${data.userName}`);
          
          // Broadcast to host for execution
          const state = sessionStates.get(data.sessionId);
          if (state && state.hostSocketId) {
            io!.to(state.hostSocketId).emit("webcontainer:command", data);
          }
        });

        socket.on("workspace:request-snapshot", (data: { sessionId: string }) => {
  console.log(`📸 [SERVER] Guest ${socket.id} requesting workspace snapshot for ${data.sessionId}`);
  const room = io!.sockets.adapter.rooms.get(data.sessionId);
  const otherSockets = room ? room.size - 1 : 0; // minus the requester

  if (otherSockets === 0) {
    // No host in room — tell guest to fall back immediately
    console.log(`⚠️ [SERVER] No host in session ${data.sessionId} — emitting snapshot-unavailable`);
    socket.emit("workspace:snapshot-unavailable", { sessionId: data.sessionId });
    return;
  }
 
  socket.to(data.sessionId).emit("workspace:snapshot-requested", {
    sessionId: data.sessionId,
    requesterSocketId: socket.id,
  });
  console.log(`✅ [SERVER] Snapshot request forwarded to host for session ${data.sessionId}`);
 
 
});
socket.on("workspace:snapshot", (data: {
  sessionId: string;
  requesterSocketId: string;
  snapshot: {
    files: any[];
    modifiedFiles: string[];
    createdFiles: string[];
    deletedFiles: string[];
    repoFullName: string;
    branch: string;
  };
}) => {
  console.log(`📸 [SERVER] Host sending snapshot to guest ${data.requesterSocketId}`);
 
  // Send directly to the requesting guest socket only
  io!.to(data.requesterSocketId).emit("workspace:snapshot", {
    sessionId: data.sessionId,
    snapshot: data.snapshot,
  });
 
  console.log(`✅ [SERVER] Snapshot delivered to ${data.requesterSocketId}`);
});

        // ============================================
        // DISCONNECT - Cleanup
        // ============================================
        socket.on("disconnect", async () => {
  console.log("\n🔌 DISCONNECT:", socket.id);
  console.log("   userId:", socket.userId);
  console.log("   userName:", socket.userName);
  console.log("   sessionId:", socket.sessionId);

  if (socket.sessionId && socket.userId) {
    // 🔥 CRITICAL: Check if this was the last connection
    const { participant, wasLastConnection } = removeParticipant(socket.sessionId, socket.id);
    
    if (participant) {
      if (wasLastConnection) {
        // 🔥 Only log "left" activity if ALL connections closed
        console.log(`👋 ${participant.userName} fully disconnected (all tabs closed)`);
        
        const activityEntry = logActivity(
          socket.sessionId,
          participant.userId,
          participant.userName,
          "left",
          "Left the session"
        );
        
        const updatedParticipants = getParticipants(socket.sessionId);
        console.log(`📢 Broadcasting ${updatedParticipants.length} remaining participants`);
        
        io!.to(socket.sessionId).emit("collab:participants-updated", {
          participants: updatedParticipants,
        });
        
        if (activityEntry) {
          io!.to(socket.sessionId).emit("collab:activity-new", activityEntry);
        }

        socket.to(socket.sessionId).emit("collab:user-left", {
          userId: socket.userId,
          userName: socket.userName,
          timestamp: Date.now(),
        });
      } else {
        // 🔥 User still has other connections, no activity needed
        console.log(`⏳ ${participant.userName} still connected (${participant.socketIds.size} tab(s) remaining)`);
      }
    } else {
      console.error("❌ Failed to remove participant from tracking");
    }

    if (socket.userId && !socket.userId.startsWith("guest-")) {
      await prisma.collabParticipant.updateMany({
        where: { 
          sessionId: socket.sessionId,
          userId: socket.userId,
        },
        data: { lastSeenAt: new Date() },
      });
    }

    // WebContainer cleanup (keep existing code)
    const state = sessionStates.get(socket.sessionId);
    if (state && state.hostSocketId === socket.id) {
      console.log(`⚠️ Host disconnected from session ${socket.sessionId}`);
      io!.to(socket.sessionId).emit("webcontainer:host-disconnected", {
        sessionId: socket.sessionId,
        message: "Host has disconnected. WebContainer is paused.",
      });
      state.isRunning = false;
      state.lastUpdate = Date.now();

      setTimeout(() => {
        const currentState = sessionStates.get(socket.sessionId!);
        if (currentState && currentState.hostSocketId === socket.id) {
          sessionStates.delete(socket.sessionId!);
          io!.to(socket.sessionId!).emit("webcontainer:session-expired", {
            sessionId: socket.sessionId,
            message: "Host has been offline for too long. Session state cleared.",
          });
        }
      }, 5 * 60 * 1000);
    }
  }
  
  console.log("✅ Disconnect cleanup complete\n");
});
    });

    return io;
}

export function getSocketServer(): SocketIOServer | null {
  return io;
}

// 🔥 NEW: Utility functions for monitoring/debugging
export function getSessionState(sessionId: string): WebContainerState | null {
  return sessionStates.get(sessionId) || null;
}

export function clearSessionState(sessionId: string): void {
  sessionStates.delete(sessionId);
  console.log(`🗑️ Manually cleared state for session ${sessionId}`);
}

export function getAllSessionStates(): Map<string, WebContainerState> {
  return new Map(sessionStates);
}

export function cleanupSessionParticipants(sessionId: string): void {
  sessionParticipants.delete(sessionId);
  sessionActivityLogs.delete(sessionId);
  recentActivityIds.delete(sessionId);
  console.log(`🗑️ Cleaned up participants/activity for session ${sessionId}`);
}
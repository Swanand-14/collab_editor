"use client";

import { useEffect, useState, useRef } from "react";
import type { Socket } from "socket.io-client";
import  { CURSOR_COLORS,CursorColor } from "../lib/cursorColors";



export interface RemoteCursor {
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
  color: CursorColor;
  lastUpdate: number;
}

interface UseRemoteCursorsProps {
  socket: Socket | null;
  sessionId: string;
  currentUserId?: string;
  currentFileId?: string;
}
 const userColorMap = new Map<string, CursorColor>();

export function useRemoteCursors({socket,sessionId,currentFileId,currentUserId}:UseRemoteCursorsProps){
    const [remoteCursors,setRemoteCursors] = useState<Map<string,RemoteCursor>>(new Map())
    const timeoutRefsRef = useRef<Map<string, NodeJS.Timeout>>(new Map());
   
    function assignCursorColor(userId: string): CursorColor {
  if (!userColorMap.has(userId)) {
    const index = userColorMap.size % CURSOR_COLORS.length;
    userColorMap.set(userId, CURSOR_COLORS[index]);
    console.log(`🎨 Assigned ${CURSOR_COLORS[index].name} to user ${userId}`);
  }
  return userColorMap.get(userId)!;
}
    useEffect(()=>{
        if(!socket)return;
        console.log("👆 Setting up remote cursor listeners");
        const handleRemoteCursor = (data:{userId: string;
      userName: string;
      fileId: string;
      filePath: string;
      position: { lineNumber: number; column: number };
      selection?: {
        startLineNumber: number;
        startColumn: number;
        endLineNumber: number;
        endColumn: number;
      };
      color: CursorColor;})=>{
        if(data.userId === currentUserId)return;

        console.log('[Remote Cursor] 👆 Received:', {
    from: data.userName,
    userId: data.userId,
    file: data.filePath,
    line: data.position.lineNumber,
    column: data.position.column,
    hasSelection: !!data.selection,
    isCurrentFile: data.fileId === currentFileId
  });

  const color = assignCursorColor(data.userId);

        console.log(`👆 Remote cursor from ${data.userName} at ${data.filePath}:${data.position.lineNumber}:${data.position.column}`);
        setRemoteCursors(prev=>{
            const updated = new Map(prev);
            updated.set(data.userId,{...data,color,lastUpdate:Date.now()});
            return updated
        });
        
        // 🔥 FIX: Clear previous timeout for this user and set a new one
        const existingTimeout = timeoutRefsRef.current.get(data.userId);
        if(existingTimeout) {
            clearTimeout(existingTimeout);
        }
        
        const newTimeout = setTimeout(()=>{
            console.log(`🔥 Removing stale cursor of ${data.userName} (no update for 6s)`);
            setRemoteCursors(prev=>{
                const updated = new Map(prev)
                updated.delete(data.userId);
                return updated
            });
            timeoutRefsRef.current.delete(data.userId);
        }, 6000); // 6 second timeout for stale cursors
        
        timeoutRefsRef.current.set(data.userId, newTimeout);

      }

      const handleUserLeft = (data:{userId:string}) =>{
        console.log(`Removing cursor for user ${data.userId}`);
        setRemoteCursors(prev=>{
            const updated = new Map(prev);
            updated.delete(data.userId);
            return updated;
        });
      }

      socket.on("collab:remote-cursor",handleRemoteCursor)
      socket.on("collab:user-left",handleUserLeft)

      return ()=>{
        socket.off("collab:remote-cursor",handleRemoteCursor)
        socket.off("collab:user-left",handleUserLeft)
        
        // 🔥 FIX: Clean up all pending timeouts
        timeoutRefsRef.current.forEach(timeout => clearTimeout(timeout));
        timeoutRefsRef.current.clear();
      }

        
    },[socket,currentUserId])
    const CursorsInCurrentFile = Array.from(remoteCursors.values()).filter(
        cursor=>cursor.fileId === currentFileId
    );

    return {
        remoteCursors,
        CursorsInCurrentFile
    }
}
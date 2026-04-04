"use client";

import { useEffect, useState, useCallback, useRef, use } from "react";
import { Users, Clock, AlertCircle, Wifi, WifiOff, FileText, X, Save, Play, Square, RotateCcw } from "lucide-react"; // 🔥 Added Play, Square, RotateCcw
import { toast } from "sonner";
import { joinCollabSession } from "../actions";
import { useCollabSocket } from "../hooks/useCollabSocket";
import type { CollabSessionData } from "../types";
import { LoadingStep } from "@/modules/playground/components/loader";
import { currentUser } from "@/modules/auth/actions";
import { CollabEditor } from "./CollabEditor";
import React from "react";
import { TemplateFile } from "@prisma/client";
import { enrichTemplateWithPaths } from "@/modules/playground/lib";
import { TemplateFolder } from "@/modules/playground/lib/path-to-json";
import { getCollabWorkspaceBySession, updateCollabWorkspace } from "../workspaces/actions";
import { SidebarProvider } from "@/components/ui/sidebar";
import { TemplateFileTree } from "@/modules/playground/components/playgroundExplorer";
import { useFileExplorer } from "@/modules/playground/hooks/useFileExplorer";
import { Button } from "@/components/ui/button";
import { generateFileId } from "@/modules/playground/lib/index";
import { useRemoteCursors } from "../hooks/useRemoteCursors";
import { useProximityWarnings } from "../hooks/useProximityWarnings";
import { editor } from "monaco-editor";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useWorkspaceAutoSave } from "../hooks/useWorkspaceAutoSave";
import { webContainerService } from "@/modules/webContainers/services/webContainer-services";

// 🔥 NEW: Import WebContainer components
import { useCollabWebContainer } from "@/modules/webContainers/hooks/useCollabWebContainer";
import { WebContainerPreview } from "@/modules/webContainers/components/WebContainerPreview";
import { HostOfflineBanner } from "./HostOfflineBanner";
import TerminalComponent, { TerminalRef } from "@/modules/webContainers/components/terminal";
import { useCollabParticipants } from "../hooks/useCollabParticipants";
import { ParticipantsPanel } from "./ParticipantsPanel";
import { getEditorLanguage } from "@/modules/playground/lib/editor-config";
import { fileCreationWatcher } from "@/modules/webContainers/services/fileWatcher";
import { SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";

interface CollabPlaygroundProps {
  session: CollabSessionData;
}

export function CollabPlayground({ session }: CollabPlaygroundProps) {
  const [isJoining, setIsJoining] = useState(true);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [user, setUser] = useState<{ id: string; name: string,image?:string } | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [localCursorPosition,setLocalCursorPosition] = useState<{lineNumber:number;column:number}>({lineNumber:1,column:1});
  const [followingUserId, setFollowingUserId] = useState<string | null>(null);
  const [isReadyTerminal, setIsReadyTerminal] = useState(false);
  const [isParticipantsVisible, setIsParticipantsVisible] = useState(true);
const editorInstanceRef = useRef<editor.IStandaloneCodeEditor | null>(null);
const manuallyCreatedFilesRef = useRef<Set<string>>(new Set());
  const autoStartAttempted = useRef(false);
  
  // 🔥 NEW: Preview toggle state
  const [showPreview, setShowPreview] = useState(true);
  
  // 🔥 NEW: Terminal ref for WebContainer
  const terminalRef = useRef<TerminalRef>(null);

  // 🔥 Use the same Zustand store as main playground
  const {
    templateData,
    setTemplateData,
    setPlaygroundId,
    setOpenFiles,
    setActiveFileId,
    activeFileId,
    closeAllFiles,
    closeFile,
    openFile,
    openFiles,
    handleAddFile,
    handleAddFolder,
    handleDeleteFile,
    handleDeleteFolder,
    handleRenameFile,
    handleRenameFolder,
    updateFileContent,
  } = useFileExplorer();

  // Initialize WebSocket connection
  const { socket, isConnected, participants:oldparticipants, emitFileOpen, emitFileChange, emitFileAction } = useCollabSocket(
    session.sessionId,
    user?.id,
    user?.name
  );

  const { 
  participants, 
  activityLogs, 
  updateActivity 
} = useCollabParticipants({
  socket,
  sessionId: session.sessionId,
  currentUserId: user?.id,
});
const activeFile = Array.isArray(openFiles) ? openFiles.find((f) => f.id === activeFileId) : undefined;

  
  const { saveWorkSpace } = useWorkspaceAutoSave(session.sessionId, templateData, user?.id, true);

  // 🔥 NEW: Determine if current user is host
  const isHost = user?.id === session.hostId;

  // 🔥 NEW: Initialize WebContainer (host-only boot)
  const webContainer = useCollabWebContainer({
    sessionId: session.sessionId,
    templateData,
    isHost,
    userId: user?.id,
    userName: user?.name,
    terminalRef,
  });
  const { remoteCursors, CursorsInCurrentFile } = useRemoteCursors({
  socket,
  sessionId: session.sessionId,
  currentUserId: user?.id,
  currentFileId: activeFileId || undefined, // Pass current file
});

useProximityWarnings({
  remoteCursors: CursorsInCurrentFile,
  localCursorLine: localCursorPosition.lineNumber,
  enabled: true, // Set to false to disable warnings
});

// 🔥 NEW: Auto-start server when BOTH WebContainer AND Terminal are ready (HOST ONLY)
useEffect(() => {
  console.log("🔄 [COLLAB] Auto-start useEffect triggered", {
    isHost,
    webContainerReady: webContainer.isReady,
    terminalReady: isReadyTerminal,
    serverRunning: webContainer.isServerRunning,
    autoStartAttempted: autoStartAttempted.current,
    terminalRefExists: !!terminalRef.current,
  });

  if (!isHost) {
    console.log("⏭️ [COLLAB] Skipping auto-start - not host");
    return;
  }
  
  if (!webContainer.isReady) {
    console.log("⏳ [COLLAB HOST] WebContainer not ready yet");
    return;
  }
  
  if (!isReadyTerminal) {
    console.log("⏳ [COLLAB HOST] Terminal not ready yet");
    return;
  }
  if (!terminalRef.current) {
    console.log("⏳ [COLLAB HOST] Terminal ref not available yet");
    return;
  }
  
  if (autoStartAttempted.current) {
    console.log("⏭️ [COLLAB HOST] Auto-start already attempted");
    return;
  }
  
  if (webContainer.isServerRunning) {
    console.log("⏭️ [COLLAB HOST] Server already running");
    return;
  }
  
  console.log("✅ [COLLAB HOST] All conditions met - scheduling auto-start");
  autoStartAttempted.current = true;
  
  const timer = setTimeout(async () => {
    console.log("🚀 [COLLAB HOST] Executing auto-start now");
     if (!terminalRef.current) {
      console.error("❌ [COLLAB HOST] Terminal ref disappeared - aborting auto-start");
      autoStartAttempted.current = false;
      return;
    }
    
    try {
      await webContainer.startServer();
      console.log("✅ [COLLAB HOST] Auto-start completed successfully");
    } catch (err) {
      console.error("❌ [COLLAB HOST] Auto-start failed:", err);
      autoStartAttempted.current = false;
    }
  }, 2000);
  
  return () => {
    console.log("🧹 [COLLAB] Auto-start useEffect cleanup");
    clearTimeout(timer);
  };
}, [isHost, webContainer.isReady, isReadyTerminal, webContainer.isServerRunning, webContainer.startServer, terminalRef]);

// 🔥 DEBUG: Log when cursors update
useEffect(() => {
  if (CursorsInCurrentFile.length > 0) {
    console.log("👥 Remote cursors in current file:", CursorsInCurrentFile);
  }
}, [CursorsInCurrentFile]);

  // 🔥 NEW: Listen for remote editor changes at the parent level
  useEffect(() => {
    if (!socket) return;

    const handleRemoteEditorChange = (payload: {
      userId: string;
      userName: string;
      fileId: string;
      content: string;
      filePath: string;
    }) => {
      const isPackageJson = payload.filePath === "package.json";
      if (payload.userId === user?.id && !isPackageJson) return;

      console.log(`📡 Received remote change from ${payload.userName} for file ${payload.fileId}`);

      const currentTemplate = useFileExplorer.getState().templateData;
      if (currentTemplate) {
        const updatedTemplate = JSON.parse(JSON.stringify(currentTemplate));

        const updateFileInTree = (items: any[]): any[] => {
          return items.map((item) => {
            if ("folderName" in item) {
              return {
                ...item,
                items: updateFileInTree(item.items),
              };
            } else {
              // 🔥 FIX: Generate the ID to match
              const itemId = generateFileId(item, currentTemplate);

              if (itemId === payload.fileId) {
                console.log(`✅ Updated ${item.filename}.${item.fileExtension} in template`);
                return { ...item, content: payload.content };
              }
              return item;
            }
          });
        };

        updatedTemplate.items = updateFileInTree(updatedTemplate.items);
        setTemplateData(updatedTemplate);
      }

      // 🔥 Update open files (if the file is open)
      const currentOpenFiles = useFileExplorer.getState().openFiles;
      if (Array.isArray(currentOpenFiles)) {
        const fileIsOpen = currentOpenFiles.some((f) => f.id === payload.fileId);

        if (fileIsOpen) {
          console.log(`📝 Updating open file: ${payload.fileId}`);
          const updatedOpenFiles = currentOpenFiles.map((file) => {
            if (file.id === payload.fileId) {
              // Only update if it's not the active file being edited
              // (active file updates are handled by CollabEditor)
              if (file.id !== activeFileId) {
                return {
                  ...file,
                  content: payload.content,
                  originalContent: payload.content,
                  hasUnsavedChanges: false,
                };
              }
            }
            return file;
          });
          setOpenFiles(updatedOpenFiles);
        }
      }
    };

    socket.on("editor:change", handleRemoteEditorChange);

    return () => {
      socket.off("editor:change", handleRemoteEditorChange);
    };
  }, [socket, user?.id, setTemplateData, setOpenFiles, activeFileId]);

  useEffect(() => {
    if (!socket) return;

    const handleRemoteFileAction = async (payload: {
      userId: string;
      userName: string;
      action: "create" | "delete" | "rename";
      filePath: string;
      newPath?: string;
      content?: string;
      isFolder?: boolean;
    }) => {
      // Skip if it's from current user
      if (payload.userId === user?.id) return;

      console.log(`🔧 Received file action from ${payload.userName}:`, payload.action, payload.filePath);

      // Reload the workspace from database to get the latest state
      try {
        const workspace = await getCollabWorkspaceBySession(session.sessionId);
        if (workspace && workspace.templateData) {
          const enrichedTemplate = enrichTemplateWithPaths(workspace.templateData);
          setTemplateData(enrichedTemplate);

          // Show notification to user
          const fileName = payload.filePath.split('/').pop();
          switch (payload.action) {
            case "create":
              toast.info(`${payload.userName} ${payload.isFolder ? 'created folder' : 'created file'}: ${fileName}`);
              break;
            case "delete":
              toast.info(`${payload.userName} ${payload.isFolder ? 'deleted folder' : 'deleted file'}: ${fileName}`);

              // 🔥 Close the file if it's currently open
              const currentOpenFiles = useFileExplorer.getState().openFiles;
              const fileToClose = currentOpenFiles.find((f) =>
                `${f.path}/${f.filename}.${f.fileExtension}`.replace(/^\//, '') === payload.filePath
              );
              if (fileToClose) {
                closeFile(fileToClose.id);
              }
              break;
            case "rename":
              toast.info(`${payload.userName} renamed: ${fileName} → ${payload.newPath?.split('/').pop()}`);
              break;
          }

          console.log("✅ Template reloaded after file operation");
        }
      } catch (error) {
        console.error("❌ Error reloading workspace after file action:", error);
      }
    };

    socket.on("file:action", handleRemoteFileAction);

    return () => {
      socket.off("file:action", handleRemoteFileAction);
    };
  }, [socket, user?.id, session.sessionId, setTemplateData, closeFile]);




  

  // 🔥 Save function similar to main playground
  const saveCollabWorkspace = useCallback(
    async (updatedTemplate: TemplateFolder) => {
      try {
        setIsSaving(true);
        const result = await updateCollabWorkspace({
          sessionId: session.sessionId,
          templateData: updatedTemplate,
          userId: user?.id,
        });

        if (!result.success) {
          throw new Error(result.error || "Failed to save");
        }

        console.log("✅ Collab workspace saved");
        return updatedTemplate;
      } catch (error) {
        console.error("❌ Save error:", error);
        toast.error("Failed to save changes");
        return null;
      } finally {
        setIsSaving(false);
      }
    },
    [session.sessionId, user?.id]
  );

    useEffect(() => {
  if (!webContainer.instance || !templateData) return;

  console.log("🔍 [Collab] Setting up package.json listener...");

  const handlePackageJsonChange = async (data: { content: string }) => {
    console.log("📦 [Collab] package.json changed in WebContainer!");
    
    try {
      const newPkg = JSON.parse(data.content);
      console.log("[Collab] New dependencies:", Object.keys(newPkg.dependencies || {}));
      
      // Clone template data
      const updatedTemplateData = JSON.parse(JSON.stringify(templateData));
      
      // Find and update package.json in template
      let found = false;
      let packageJsonFile : any = null;
      for (let i = 0; i < updatedTemplateData.items.length; i++) {
        const item = updatedTemplateData.items[i];
        if (item.filename === "package" && item.fileExtension === "json") {
          console.log("✅ [Collab] Updating package.json in template");
          updatedTemplateData.items[i].content = data.content;
          packageJsonFile = updatedTemplateData.items[i];
          found = true;
          break;
        }
      }
      
      if (!found || !packageJsonFile) {
        console.warn("❌ [Collab] package.json not found in template");
        return;
      }
      
      // Update Zustand store
      const properFileId = generateFileId(packageJsonFile, updatedTemplateData);
      console.log("🆔 [Collab] Generated proper fileId:", properFileId);
      setTemplateData(updatedTemplateData);
      
      // 🔥 CRITICAL: Broadcast to other collaborators via socket
      if (socket) {
        socket.emit("editor:change", {
          userId: user?.id,
          userName: user?.name || "Anonymous",
          fileId: properFileId, // Special ID for package.json
          content: data.content,
          filePath: "package.json",
        });
        console.log("📡 [Collab] Broadcasted package.json to collaborators");
      }
      
      // Save to database
      await saveCollabWorkspace(updatedTemplateData);
      
      // Update open file if package.json is open
      const openPkgJson = openFiles.find(
        f => f.filename === "package" && f.fileExtension === "json"
      );
      
      if (openPkgJson) {
        const updatedOpenFiles = openFiles.map(f => 
          f.id === openPkgJson.id 
            ? { 
                ...f, 
                content: data.content, 
                originalContent: data.content, 
                hasUnsavedChanges: false 
              }
            : f
        );
        setOpenFiles(updatedOpenFiles);
      }
      
      toast.success("📦 package.json synced from terminal");
      
    } catch (error) {
      console.error("[Collab] Failed to sync package.json:", error);
      toast.error("Failed to sync package.json");
    }
  };

  // Register listener
  webContainerService.on("package-json-changed", handlePackageJsonChange);

  // Cleanup
  return () => {
    webContainerService.off("package-json-changed", handlePackageJsonChange);
  };
}, [webContainer.instance, templateData, openFiles, setTemplateData, saveCollabWorkspace, setOpenFiles, socket, user]);

  // 🔥 Wrapped handlers (same pattern as main playground)
  const wrappedHandleAddFile = useCallback(
    async (newFile: TemplateFile, parentPath: string) => {
      const filePath = parentPath
        ? `${parentPath}/${newFile.filename}.${newFile.fileExtension}`
        : `${newFile.filename}.${newFile.fileExtension}`;
      
      console.log(`🏷️ [Collab] Tracking new file to ignore: ${filePath}`);
      manuallyCreatedFilesRef.current.add(filePath);
      
      setTimeout(() => {
        manuallyCreatedFilesRef.current.delete(filePath);
        console.log(`🧹 [Collab] Stopped ignoring: ${filePath}`);
      }, 3000);

      const result = await handleAddFile(
        newFile,
        parentPath,
        async () => { },
        webContainer.instance,
        saveCollabWorkspace
      );

      // 🔥 Emit file creation to other participants
      

      emitFileAction({
        action: "create",
        filePath,
        content: newFile.content || "",
      });

      console.log(`📤 Emitted file creation: ${filePath}`);

      return result;
    },
    [handleAddFile, saveCollabWorkspace, emitFileAction,webContainer.instance]
  );

  const wrappedHandleAddFolder = useCallback(
    async (newFolder: TemplateFolder, parentPath: string) => {
      const folderPath = parentPath
        ? `${parentPath}/${newFolder.folderName}`
        : newFolder.folderName;
      
      console.log(`🏷️ [Collab] Tracking new folder to ignore: ${folderPath}`);
      manuallyCreatedFilesRef.current.add(folderPath);
      
      setTimeout(() => {
        manuallyCreatedFilesRef.current.delete(folderPath);
        console.log(`🧹 [Collab] Stopped ignoring: ${folderPath}`);
      }, 3000);
      const result = await handleAddFolder(
        newFolder,
        parentPath,
        webContainer.instance,
        saveCollabWorkspace
      );

      // 🔥 Emit folder creation to other participants
     

      emitFileAction({
        action: "create",
        filePath: folderPath,
        content: "",
      });

      console.log(`📤 Emitted folder creation: ${folderPath}`);

      return result;
    },
    [handleAddFolder, saveCollabWorkspace, emitFileAction,webContainer.instance]
  );

  const wrappedHandleDeleteFile = useCallback(
    async (file: TemplateFile, parentPath: string) => {
      const result = await handleDeleteFile(file, parentPath, webContainer.instance,saveCollabWorkspace);

      // 🔥 Emit file deletion to other participants
      const filePath = parentPath
        ? `${parentPath}/${file.filename}.${file.fileExtension}`
        : `${file.filename}.${file.fileExtension}`;

        manuallyCreatedFilesRef.current.delete(filePath);
      console.log(`🗑️ [Collab] Removing file from tracking: ${filePath}`);

      emitFileAction({
        action: "delete",
        filePath,
      });

      console.log(`📤 Emitted file deletion: ${filePath}`);

      return result;
    },
    [handleDeleteFile, saveCollabWorkspace, emitFileAction,webContainer.instance]
  );

  const wrappedHandleDeleteFolder = useCallback(
    async (folder: TemplateFolder, parentPath: string) => {
      const result = await handleDeleteFolder(folder, parentPath, webContainer.instance,saveCollabWorkspace);

      // 🔥 Emit folder deletion to other participants
      const folderPath = parentPath
        ? `${parentPath}/${folder.folderName}`
        : folder.folderName;

        manuallyCreatedFilesRef.current.delete(folderPath);
      console.log(`🗑️ [Collab] Removing folder from tracking: ${folderPath}`);

      emitFileAction({
        action: "delete",
        filePath: folderPath,
      });

      console.log(`📤 Emitted folder deletion: ${folderPath}`);

      return result;
    },
    [handleDeleteFolder, saveCollabWorkspace, emitFileAction,webContainer.instance]
  );

  const wrappedHandleRenameFile = useCallback(
    async (
      file: TemplateFile,
      newFilename: string,
      newExtension: string,
      parentPath: string
    ) => {
      const oldPath = parentPath
        ? `${parentPath}/${file.filename}.${file.fileExtension}`
        : `${file.filename}.${file.fileExtension}`;

      const newPath = parentPath
        ? `${parentPath}/${newFilename}.${newExtension}`
        : `${newFilename}.${newExtension}`;

        console.log(`🏷️ [Collab] Tracking renamed file to ignore: ${newPath}`);
      manuallyCreatedFilesRef.current.add(newPath);
      manuallyCreatedFilesRef.current.delete(oldPath);
      
      setTimeout(() => {
        manuallyCreatedFilesRef.current.delete(newPath);
        console.log(`🧹 [Collab] Stopped ignoring: ${newPath}`);
      }, 3000);

      const result = await handleRenameFile(
        file,
        newFilename,
        newExtension,
        parentPath,
        webContainer.instance,
        saveCollabWorkspace
      );

      // 🔥 Emit file rename to other participants
      emitFileAction({
        action: "rename",
        filePath: oldPath,
        newPath: newPath,
      });

      console.log(`📤 Emitted file rename: ${oldPath} → ${newPath}`);

      return result;
    },
    [handleRenameFile, saveCollabWorkspace, emitFileAction,webContainer.instance]
  );

  const wrappedHandleRenameFolder = useCallback(
    async (folder: TemplateFolder, newFolderName: string, parentPath: string) => {
      const oldPath = parentPath
        ? `${parentPath}/${folder.folderName}`
        : folder.folderName;

      const newPath = parentPath
        ? `${parentPath}/${newFolderName}`
        : newFolderName;

      console.log(`🏷️ [Collab] Tracking renamed folder to ignore: ${newPath}`);
      manuallyCreatedFilesRef.current.add(newPath);
      manuallyCreatedFilesRef.current.delete(oldPath);
      
      // Track nested files
      const trackFolderContents = (folder: TemplateFolder, basePath: string) => {
        folder.items.forEach((item) => {
          if ('filename' in item) {
            const filePath = `${basePath}/${item.filename}.${item.fileExtension}`;
            manuallyCreatedFilesRef.current.add(filePath);
            console.log(`  🏷️ [Collab] Tracking nested file: ${filePath}`);
          } else if ('folderName' in item) {
            const subFolderPath = `${basePath}/${item.folderName}`;
            manuallyCreatedFilesRef.current.add(subFolderPath);
            console.log(`  🏷️ [Collab] Tracking nested folder: ${subFolderPath}`);
            trackFolderContents(item, subFolderPath);
          }
        });
      };
      
      trackFolderContents(folder, newPath);
      
      setTimeout(() => {
        manuallyCreatedFilesRef.current.delete(newPath);
        console.log(`🧹 [Collab] Stopped ignoring: ${newPath}`);
      }, 3000);

      const result = await handleRenameFolder(
        folder,
        newFolderName,
        parentPath,
        webContainer.instance,
        saveCollabWorkspace
      );

      // 🔥 Emit folder rename to other participants
      emitFileAction({
        action: "rename",
        filePath: oldPath,
        newPath: newPath,
      });

      console.log(`📤 Emitted folder rename: ${oldPath} → ${newPath}`);

      return result;
    },
    [handleRenameFolder, saveCollabWorkspace, emitFileAction,webContainer.instance]
  );

  // 🔥 File selection handler
  const handleFileSelect = useCallback(
    (file: TemplateFile & { path?: string }) => {
      console.log("📄 File selected:", file);

      openFile(file);

      const filePath = `${file.path || ""}/${file.filename}.${file.fileExtension}`.replace(
        /^\//, ""
      );
      emitFileOpen(file.id, filePath);
      updateActivity(filePath);
    },
    [openFile, emitFileOpen]
  );

  // 🔥 Content change handler - Now syncs with socket AND WebContainer
  const handleFileContentChange = useCallback(
    (fileId: string, newContent: string) => {
      console.log("✏️ Content changed for file:", fileId);

      // Update local Zustand state
      updateFileContent(fileId, newContent);

      // 🔥 CRITICAL: Also update the template data immediately
      const currentTemplate = useFileExplorer.getState().templateData;
      if (currentTemplate) {
        const updatedTemplate = JSON.parse(JSON.stringify(currentTemplate));

        const updateFileInTree = (items: any[]): any[] => {
          return items.map((item) => {
            if ("folderName" in item) {
              return {
                ...item,
                items: updateFileInTree(item.items),
              };
            } else {
              const itemid = generateFileId(item, currentTemplate)
              if (itemid === fileId) {
                return { ...item, content: newContent };
              }
              return item;
            }
          });
        };

        updatedTemplate.items = updateFileInTree(updatedTemplate.items);
        setTemplateData(updatedTemplate);

        // 🔥 NEW: Sync to WebContainer
        const file = openFiles.find(f => f.id === fileId);
        if (file) {
          const filePath = `/${file.path || ""}/${file.filename}.${file.fileExtension}`.replace(/^\/+/, '/');
          webContainer.syncFileToContainer(filePath, newContent);
        }
      }

      // Note: Socket emission is handled by CollabEditor's emitEditorChange
    },
    [updateFileContent, setTemplateData, openFiles, webContainer]
  );

  // 🔥 Save current file
  const handleSave = useCallback(async () => {
    if (!activeFileId || !templateData) {
      toast.error("No active file to save");
      return;
    }

    const fileToSave = openFiles.find((f) => f.id === activeFileId);
    if (!fileToSave || !fileToSave.hasUnsavedChanges) {
      toast.info("No changes to save");
      return;
    }

    try {
      setIsSaving(true);

      // Template data should already be updated from handleFileContentChange
      // Just save it to database
      const result = await saveCollabWorkspace(templateData);
      if (!result) {
        throw new Error("Failed to save");
      }

      // Mark as saved in open files
      const updatedOpenFiles = openFiles.map((f) =>
        f.id === activeFileId
          ? {
            ...f,
            originalContent: f.content,
            hasUnsavedChanges: false,
          }
          : f
      );
      setOpenFiles(updatedOpenFiles);

      toast.success(`Saved ${fileToSave.filename}.${fileToSave.fileExtension}`);
    } catch (error) {
      console.error("Save error:", error);
      toast.error("Failed to save file");
    } finally {
      setIsSaving(false);
    }
  }, [
    activeFileId,
    templateData,
    openFiles,
    saveCollabWorkspace,
    setOpenFiles,
  ]);

  // 🔥 Save all files
  const handleSaveAll = useCallback(async () => {
    const unsavedFiles = openFiles.filter((f) => f.hasUnsavedChanges);
    if (unsavedFiles.length === 0) {
      toast.info("No unsaved changes");
      return;
    }

    try {
      setIsSaving(true);

      if (!templateData) return;

      // Template data should already be updated from handleFileContentChange
      // Just save it to database
      const result = await saveCollabWorkspace(templateData);
      if (!result) throw new Error("Failed to save");

      // Mark all as saved
      const updatedOpenFiles = openFiles.map((f) => ({
        ...f,
        originalContent: f.content,
        hasUnsavedChanges: false,
      }));
      setOpenFiles(updatedOpenFiles);

      toast.success(`Saved ${unsavedFiles.length} files`);
    } catch (error) {
      console.error("Save all error:", error);
      toast.error("Failed to save files");
    } finally {
      setIsSaving(false);
    }
  }, [openFiles, templateData, saveCollabWorkspace, setOpenFiles]);

  // 🔥 Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "s") {
        e.preventDefault();
        if (e.shiftKey) {
          handleSaveAll();
        } else {
          handleSave();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleSave, handleSaveAll]);

  const toggleFollow = useCallback((userId: string) => {
  if (followingUserId === userId) {
    setFollowingUserId(null);
    console.log('❌ Stopped following');
  } else {
    setFollowingUserId(userId);
    console.log(`✅ Following user ${userId}`);
  }
}, [followingUserId]);

useEffect(() => {
  if (!isHost) {
    console.log("⏭️ [COLLAB] Skipping terminal listener - not host");
    return;
  }
  
  console.log("👂 [COLLAB HOST] Setting up terminal ready listener");
  
  const handleTerminalReady = () => {
    console.log("✅ [COLLAB HOST] Terminal ready event received!");
    setIsReadyTerminal(true);
  };
  
  window.addEventListener('terminalReady', handleTerminalReady);
  
  return () => {
    console.log("🧹 [COLLAB HOST] Cleaning up terminal listener");
    window.removeEventListener('terminalReady', handleTerminalReady);
  };
}, [isHost]);

useEffect(() => {

  if (!editorInstanceRef.current || !followingUserId) return;

  const targetCursor = remoteCursors.get(followingUserId);
  
  if (!targetCursor) {
    // User left current file - stop following
    setFollowingUserId(null);
    console.log('⚠️ Followed user left - stopping');
    return;
  }

  const currentFilePath = activeFile?`${activeFile.path || ""}/${activeFile.filename}.${activeFile.fileExtension}`.replace(/^\//, ''):null;
  if(targetCursor.filePath !== currentFilePath){
    console.log('Switching file to follow user:', targetCursor.filePath);
    const findfile = (items:any[],targetPath:string):any=>{
      for(const item of items){
        if("folderName" in item){
          const found = findfile(item.items,targetPath);
          if(found) return found;
        }else{
          const fullPath = `${item.path || ""}/${item.filename}.${item.fileExtension}`.replace(/^\//, '');
          if(fullPath === targetPath){
            return item;
          }

      }
    }
    return null;
  }

  if(templateData){
    const fileToOpen = findfile(templateData.items,targetCursor.filePath);
    if(fileToOpen){
      console.log('📄 Opening file to follow:', targetCursor.filePath);
      handleFileSelect(fileToOpen);
      setTimeout(()=>{
        if(editorInstanceRef.current){
          editorInstanceRef.current.revealLineInCenterIfOutsideViewport(targetCursor.position.lineNumber);
          console.log(`👁️ Scrolling to line ${targetCursor.position.lineNumber} after file open`);
        }
      },100)
    }else{
      console.warn('❌ Could not find file to follow:', targetCursor.filePath);
      setFollowingUserId(null);
    }
  }

  
}else{
editorInstanceRef.current.revealLineInCenterIfOutsideViewport(
    targetCursor.position.lineNumber
  );
  
  console.log(`👁️ Scrolling to line ${targetCursor.position.lineNumber}`);
}



  // Auto-scroll to target line
  
}, [remoteCursors,activeFile,templateData,handleFileSelect,CursorsInCurrentFile, followingUserId]);


useEffect(() => {
  if (!webContainer.instance || !templateData || !webContainer.isReady || !isHost) return;
  
  console.log("🚀 [Collab] Starting file watcher...");
  
  const handleFileCreated = async (filePath: string, parentPath: string) => {
    if (manuallyCreatedFilesRef.current.has(filePath)) return;
    try {
      const content = await webContainer.instance!.fs.readFile(`/${filePath}`, 'utf-8');
      const fileName = filePath.split('/').pop() || '';
      const [filename, ...ext] = fileName.split('.');
      await handleAddFile({
        id: '', filename, fileExtension: ext.join('.') || 'txt', content,
        playgroundId: session.sessionId, folderId: null,
        createdAt: new Date(), updatedAt: new Date(),
      }, parentPath, async () => {}, webContainer.instance, saveCollabWorkspace);
      emitFileAction({ action: "create", filePath, content });
      toast.success(`📄 Created ${fileName}`);
    } catch (err) { console.error(err); }
  };

  const handleFolderCreated = async (folderPath: string, parentPath: string) => {
    if (manuallyCreatedFilesRef.current.has(folderPath)) return;
    try {
      await handleAddFolder({
        folderName: folderPath.split('/').pop() || '', items: [],
        playgroundId: session.sessionId, parentFolderId: null,
        createdAt: new Date(), updatedAt: new Date(),
      }, parentPath, webContainer.instance, saveCollabWorkspace);
      emitFileAction({ action: "create", filePath: folderPath, content: "" });
      toast.success(`📁 Created ${folderPath.split('/').pop()}/`);
    } catch (err) { console.error(err); }
  };

  const handleFileDeleted = async (filePath: string) => {
    if (manuallyCreatedFilesRef.current.has(filePath)) return;
    try {
      const currentTemplate = useFileExplorer.getState().templateData;
      if (!currentTemplate) return;
      const findFile = (items: any[]): any => {
        for (const item of items) {
          if ('folderName' in item) { const found = findFile(item.items); if (found) return found; }
          else {
            const p = item.path ? `${item.path}/${item.filename}.${item.fileExtension}` : `${item.filename}.${item.fileExtension}`;
            if (p === filePath) return { file: item, parentPath: item.path || '' };
          }
        }
      };
      const result = findFile(currentTemplate.items);
      if (result) {
        await handleDeleteFile(result.file, result.parentPath, null, saveCollabWorkspace);
        emitFileAction({ action: "delete", filePath });
        toast.info(`🗑️ Deleted ${filePath.split('/').pop()}`);
      }
    } catch (err) { console.error(err); }
  };

  const handleFolderDeleted = async (folderPath: string) => {
    if (manuallyCreatedFilesRef.current.has(folderPath)) return;
    try {
      const currentTemplate = useFileExplorer.getState().templateData;
      if (!currentTemplate) return;
      const findFolder = (items: any[], target: string, curr = ''): any => {
        for (const item of items) {
          if ('folderName' in item) {
            const p = curr ? `${curr}/${item.folderName}` : item.folderName;
            if (p === target) return { folder: item, parentPath: curr };
            const found = findFolder(item.items, target, p);
            if (found) return found;
          }
        }
      };
      const result = findFolder(currentTemplate.items, folderPath);
      if (result) {
        await handleDeleteFolder(result.folder, result.parentPath, null, saveCollabWorkspace);
        emitFileAction({ action: "delete", filePath: folderPath });
        toast.info(`🗑️ Deleted ${folderPath.split('/').pop()}/`);
      }
    } catch (err) { console.error(err); }
  };

  const handleFileRenamed = async (oldPath: string, newPath: string) => {
    if (manuallyCreatedFilesRef.current.has(newPath)) return;
    try {
      const currentTemplate = useFileExplorer.getState().templateData;
      if (!currentTemplate) return;
      const findFile = (items: any[]): any => {
        for (const item of items) {
          if ('folderName' in item) { const found = findFile(item.items); if (found) return found; }
          else {
            const p = item.path ? `${item.path}/${item.filename}.${item.fileExtension}` : `${item.filename}.${item.fileExtension}`;
            if (p === oldPath) return { file: item, parentPath: item.path || '' };
          }
        }
      };
      const result = findFile(currentTemplate.items);
      if (result) {
        const [newFilename, ...newExt] = newPath.split('/').pop()!.split('.');
        manuallyCreatedFilesRef.current.add(newPath);
        setTimeout(() => manuallyCreatedFilesRef.current.delete(newPath), 3000);
        await handleRenameFile(result.file, newFilename, newExt.join('.'), result.parentPath, null, saveCollabWorkspace);
        emitFileAction({ action: "rename", filePath: oldPath, newPath });
        toast.info(`✏️ Renamed`);
      }
    } catch (err) { console.error(err); }
  };

  fileCreationWatcher.initialize(
    webContainer.instance, handleFileCreated, handleFolderCreated,
    ['node_modules', '.git', '.next', 'dist', 'build', '.vercel'],
    { onFileDeleted: handleFileDeleted, onFolderDeleted: handleFolderDeleted, onFileRenamed: handleFileRenamed }
  );

  return () => fileCreationWatcher.stop();
},[webContainer.instance, webContainer.isReady, templateData, isHost, session.sessionId, 
    handleAddFile, handleAddFolder, handleDeleteFile, handleDeleteFolder, handleRenameFile, 
    saveCollabWorkspace, emitFileAction])


useEffect(() => {
  const handleEsc = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && followingUserId) {
      setFollowingUserId(null);
      console.log('❌ ESC - Stopped following');
    }
  };
  
  window.addEventListener('keydown', handleEsc);
  return () => window.removeEventListener('keydown', handleEsc);
}, [followingUserId]);
  // 🔥 Initialize
  useEffect(() => {
    let mounted = true;

    const join = async () => {
      try {
        setIsReadyTerminal(false);
        autoStartAttempted.current = false;
        console.log("🚀 Starting join process for session:", session.sessionId);

        const currentUserData = await currentUser();
        if (!mounted) return;
        setUser(
          currentUserData ? { id: currentUserData.id!, name: currentUserData.name!,image: currentUserData.image } : null
        );

        const result = await joinCollabSession(session.sessionId);
        if (!mounted) return;

        if (!result.success) {
          setJoinError(result.error || "Failed to join session");
          toast.error(result.error);
          setIsJoining(false);
          return;
        }

        const workspace = await getCollabWorkspaceBySession(session.sessionId);
        if (!mounted) return;

        if (!workspace || !workspace.templateData) {
          console.error("❌ No workspace/template found");
          toast.error("No template data found");
          setIsJoining(false);
          return;
        }

        const enrichedTemplate = enrichTemplateWithPaths(workspace.templateData);
        console.log("✅ Enriched template with", enrichedTemplate.items.length, "items");

        setPlaygroundId(session.sessionId);
        setTemplateData(enrichedTemplate);

        const firstFile = findFirstFile(enrichedTemplate);
        if (firstFile && mounted) {
          console.log("📄 Auto-opening first file:", firstFile.filename);
          setTimeout(() => {
            if (mounted) {
              handleFileSelect(firstFile);
            }
          }, 100);
        }

        if (mounted) {
          toast.success("Successfully joined collaboration session!");
        }
      } catch (error) {
        console.error("❌ Error joining session:", error);
        if (mounted) {
          setJoinError("An error occurred while joining");
          toast.error("Failed to join session");
        }
      } finally {
        if (mounted) {
          setIsJoining(false);
        }
      }
    };

    join();

    return () => {
      mounted = false;
      closeAllFiles();
      setTemplateData(null);
    };
  }, [session.sessionId, setPlaygroundId, setTemplateData, closeAllFiles]);

  const findFirstFile = (
    folder: TemplateFolder
  ): (TemplateFile & { path?: string }) | null => {
    for (const item of folder.items) {
      if ("folderName" in item) {
        const found = findFirstFile(item);
        if (found) return found;
      } else {
        return item as TemplateFile & { path?: string };
      }
    }
    return null;
  };

  if (isJoining) {
    return (
      <div className="flex flex-col items-center justify-center h-screen p-4">
        <div className="w-full max-w-md p-6 rounded-lg shadow-sm border">
          <h2 className="text-xl font-semibold mb-6 text-center">
            Joining Collaboration Session
          </h2>
          <div className="mb-8">
            <LoadingStep currentStep={1} step={1} label="Connecting to session" />
            <LoadingStep currentStep={2} step={2} label="Loading template" />
            <LoadingStep currentStep={3} step={3} label="Ready to collaborate" />
          </div>
        </div>
      </div>
    );
  }

  if (joinError) {
    return (
      <div className="flex flex-col items-center justify-center h-screen p-4">
        <AlertCircle className="h-16 w-16 text-red-500 mb-4" />
        <h1 className="text-2xl font-bold mb-2">Failed to Join</h1>
        <p className="text-muted-foreground mb-6">{joinError}</p>
      </div>
    );
  }

  const expiresAt = new Date(session.expiresAt);
  const now = new Date();
  const hoursRemaining = Math.max(
    0,
    Math.floor((expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60))
  );

  
  const hasUnsavedChanges = Array.isArray(openFiles) ? openFiles.some((f) => f.hasUnsavedChanges) : false;
  return (
  <SidebarProvider>
    <TooltipProvider>
      <div className="flex h-screen w-full bg-background">
        
        {!isHost && (
          <HostOfflineBanner
            socket={socket}
            sessionId={session.sessionId}
            isHost={isHost}
          />
        )}

        {templateData && (
          <TemplateFileTree
            data={templateData}
            onFileSelect={handleFileSelect}
            selectedFile={activeFile}
            title="Files (Collab)"
            onAddFile={wrappedHandleAddFile}
            onAddFolder={wrappedHandleAddFolder}
            onDeleteFile={wrappedHandleDeleteFile}
            onDeleteFolder={wrappedHandleDeleteFolder}
            onRenameFile={wrappedHandleRenameFile}
            onRenameFolder={wrappedHandleRenameFolder}
          />
        )}

        <SidebarInset className="flex flex-1 flex-col min-w-0">
        
        <header className="flex h-16 shrink-0 items-center gap-2 border-b border-border px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 h-4" />
          
          <div className="flex flex-1 items-center gap-4">
            <div className="flex items-center gap-3">
              <Users className="h-5 w-5 text-primary" />
              <div>
                <h1 className="font-semibold">Collaboration Session</h1>
                <p className="text-xs text-muted-foreground">
                  {openFiles.length} file{openFiles.length !== 1 ? "s" : ""} open
                  {hasUnsavedChanges && " • Unsaved changes"}
                </p>
              </div>
            </div>

            <div className="ml-auto flex items-center gap-4">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleSave}
                    disabled={!activeFile?.hasUnsavedChanges || isSaving}
                    aria-label="Save current file"
                  >
                    <Save className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Save (Ctrl+S)</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleSaveAll}
                    disabled={!hasUnsavedChanges || isSaving}
                    aria-label="Save all files"
                  >
                    <Save className="h-4 w-4" />
                    <span className="ml-1 text-xs">All</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Save All (Ctrl+Shift+S)</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant={isParticipantsVisible ? "default" : "outline"}
                    onClick={() => setIsParticipantsVisible(v => !v)}
                    aria-label="Toggle participants panel"
                  >
                    <Users className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Toggle participants</TooltipContent>
              </Tooltip>

              <Button
                size="sm"
                variant={showPreview ? "default" : "outline"}
                onClick={() => setShowPreview(!showPreview)}
              >
                {showPreview ? "Hide Preview" : "Show Preview"}
              </Button>

              {isHost && (
                <div className="flex items-center gap-2 border-l pl-4">
                  {!webContainer.isServerRunning ? (
                    <Button
                      size="sm"
                      onClick={webContainer.startServer}
                      disabled={webContainer.isLoading}
                    >
                      <Play className="h-4 w-4 mr-1" />
                      Start Server
                    </Button>
                  ) : (
                    <>
                      <Button size="sm" variant="outline" onClick={webContainer.stopServer}>
                        <Square className="h-4 w-4 mr-1" />
                        Stop
                      </Button>
                      <Button size="sm" variant="outline" onClick={webContainer.restartServer}>
                        <RotateCcw className="h-4 w-4 mr-1" />
                        Restart
                      </Button>
                    </>
                  )}
                  {webContainer.isLoading && (
                    <span className="text-xs text-muted-foreground">Loading...</span>
                  )}
                  {webContainer.serverUrl && (
                    <span className="text-xs text-green-600">● Live</span>
                  )}
                </div>
              )}

              <div className="flex items-center gap-2">
                {isConnected ? (
                  <>
                    <Wifi className="h-4 w-4 text-green-500" />
                    <span className="text-sm text-green-600">Connected</span>
                  </>
                ) : (
                  <>
                    <WifiOff className="h-4 w-4 text-red-500" />
                    <span className="text-sm text-red-600">Disconnected</span>
                  </>
                )}
              </div>

              <div className="flex items-center gap-2">
                <Users className="h-4 w-4" />
                <span className="text-sm">{participants.length} online</span>
              </div>

              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Clock className="h-4 w-4" />
                <span className="text-sm">Expires in {hoursRemaining}h</span>
              </div>
            </div>
          </div>
        </header>

        {participants.length > 0 && (
          <div className="border-b bg-muted/10 px-4 py-2">
            <div className="flex items-center gap-2 flex-wrap">
              {participants.map((participant, index) => (
                <div
                  key={`${participant.userId}-${index}`}
                  className="flex items-center gap-1 px-2 py-1 bg-background rounded text-sm border"
                >
                  <div className="h-2 w-2 rounded-full bg-green-500" />
                  <span>{participant.userName}</span>
                  <span className="text-xs text-muted-foreground">
                    ({participant.role})
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Main content area: editor + optional preview ── */}
        <div className="flex flex-1 overflow-hidden">

          {showPreview ? (
            <ResizablePanelGroup direction="horizontal" className="flex-1">
              
              <ResizablePanel defaultSize={50} minSize={20}>
                <div className="flex flex-col h-full">
                  
                  {/* File tabs */}
                  {openFiles.length > 0 && (
                    <div className="border-b border-border bg-muted/30">
                      <div className="flex items-center justify-between px-4 py-2">
                        <div className="flex items-center gap-1 overflow-x-auto">
                          {openFiles.map((file) => {
                            const isDuplicate = openFiles.some(
                              (f) =>
                                f.filename === file.filename &&
                                f.fileExtension === file.fileExtension &&
                                f.id !== file.id
                            );
                            const displayName =
                              isDuplicate && file.path
                                ? `${file.path}/${file.filename}.${file.fileExtension}`
                                : `${file.filename}.${file.fileExtension}`;
                            return (
                              <div
                                key={file.id}
                                onClick={() => setActiveFileId(file.id)}
                                className={`flex items-center gap-2 px-3 py-1 rounded-t-md cursor-pointer border-b-2 transition-all ${
                                  activeFileId === file.id
                                    ? "border-primary bg-background"
                                    : "border-transparent hover:bg-muted"
                                }`}
                              >
                                <FileText className="h-3 w-3" />
                                <span className="text-sm" title={displayName}>
                                  {displayName}
                                </span>
                                {file.hasUnsavedChanges && (
                                  <span className="h-2 w-2 rounded-full bg-orange-500" />
                                )}
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    closeFile(file.id);
                                  }}
                                  className="ml-1 hover:bg-destructive hover:text-white rounded p-0.5"
                                >
                                  <X className="h-3 w-3" />
                                </button>
                              </div>
                            );
                          })}
                        </div>
                        {openFiles.length > 1 && (
                          <button
                            onClick={closeAllFiles}
                            className="text-xs text-muted-foreground hover:text-foreground"
                          >
                            Close All
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Editor */}
                  <div className="flex-1 overflow-hidden">
                    {activeFile ? (
                      <CollabEditor
                        sessionId={session.sessionId}
                        userId={user?.id}
                        userName={user?.name || "Anonymous"}
                        fileId={activeFile.id}
                        filePath={(() => {
                          const basePath = activeFile.path || "";
                          const fileName = `${activeFile.filename}.${activeFile.fileExtension}`;
                          const fullPath = basePath ? `${basePath}/${fileName}` : fileName;
                          return fullPath.replace(/^\//, "");
                        })()}
                        initialContent={
                          typeof activeFile.content === "string" ? activeFile.content : ""
                        }
                        language={getEditorLanguage(activeFile.fileExtension || "")}
                        onContentChange={(content) =>
                          handleFileContentChange(activeFile.id, content)
                        }
                        remoteCursors={CursorsInCurrentFile}
                        onCursorPositionChange={setLocalCursorPosition}
                        onEditorReady={(editor) => { editorInstanceRef.current = editor; }}
                      />
                    ) : (
                      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                        No files open. Select a file from the sidebar.
                      </div>
                    )}
                  </div>

                </div>
              </ResizablePanel>

              <ResizableHandle />

              <ResizablePanel defaultSize={50} minSize={20}>
                <WebContainerPreview
                  serverUrl={webContainer.serverUrl}
                  isLoading={webContainer.isLoading}
                  error={webContainer.error}
                  instance={isHost ? webContainer.instance : null}
                  onRestartServer={isHost ? webContainer.restartServer : undefined}
                  terminalRef={isHost ? terminalRef : undefined}
                  showTerminal={isHost}
                />
              </ResizablePanel>

            </ResizablePanelGroup>
          ) : (
            /* Full-width editor, no preview */
            <div className="flex flex-col flex-1 overflow-hidden">
              
              {openFiles.length > 0 && (
                <div className="border-b border-border bg-muted/30">
                  <div className="flex items-center justify-between px-4 py-2">
                    <div className="flex items-center gap-1 overflow-x-auto">
                      {openFiles.map((file) => {
                        const isDuplicate = openFiles.some(
                          (f) =>
                            f.filename === file.filename &&
                            f.fileExtension === file.fileExtension &&
                            f.id !== file.id
                        );
                        const displayName =
                          isDuplicate && file.path
                            ? `${file.path}/${file.filename}.${file.fileExtension}`
                            : `${file.filename}.${file.fileExtension}`;
                        return (
                          <div
                            key={file.id}
                            onClick={() => setActiveFileId(file.id)}
                            className={`flex items-center gap-2 px-3 py-1 rounded-t-md cursor-pointer border-b-2 transition-all ${
                              activeFileId === file.id
                                ? "border-primary bg-background"
                                : "border-transparent hover:bg-muted"
                            }`}
                          >
                            <FileText className="h-3 w-3" />
                            <span className="text-sm" title={displayName}>
                              {displayName}
                            </span>
                            {file.hasUnsavedChanges && (
                              <span className="h-2 w-2 rounded-full bg-orange-500" />
                            )}
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                closeFile(file.id);
                              }}
                              className="ml-1 hover:bg-destructive hover:text-white rounded p-0.5"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                    {openFiles.length > 1 && (
                      <button
                        onClick={closeAllFiles}
                        className="text-xs text-muted-foreground hover:text-foreground"
                      >
                        Close All
                      </button>
                    )}
                  </div>
                </div>
              )}

              <div className="flex-1 overflow-hidden">
                {activeFile ? (
                  <CollabEditor
                    sessionId={session.sessionId}
                    userId={user?.id}
                    userName={user?.name || "Anonymous"}
                    fileId={activeFile.id}
                    filePath={(() => {
                      const basePath = activeFile.path || "";
                      const fileName = `${activeFile.filename}.${activeFile.fileExtension}`;
                      const fullPath = basePath ? `${basePath}/${fileName}` : fileName;
                      return fullPath.replace(/^\//, "");
                    })()}
                    initialContent={
                      typeof activeFile.content === "string" ? activeFile.content : ""
                    }
                    language={getEditorLanguage(activeFile.fileExtension || "")}
                    onContentChange={(content) =>
                      handleFileContentChange(activeFile.id, content)
                    }
                    remoteCursors={CursorsInCurrentFile}
                    onCursorPositionChange={setLocalCursorPosition}
                    onEditorReady={(editor) => { editorInstanceRef.current = editor; }}
                  />
                ) : (
                  <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                    {templateData
                      ? "No files open. Select a file from the sidebar."
                      : "Loading template..."}
                  </div>
                )}
              </div>

            </div>
          )}

          {/* Participants panel — togglable, sits INSIDE the content flex row */}
          {isParticipantsVisible && (
            <ParticipantsPanel
              participants={participants.map(p => {
                const cursor = remoteCursors.get(p.userId);
                return cursor
                  ? {
                      ...p,
                      cursor: { fileId: cursor.fileId, position: cursor.position },
                      activeFile: cursor.filePath,
                    }
                  : p;
              })}
              activityLogs={activityLogs}
              currentUserId={user?.id}
              followingUserId={followingUserId}
              onFollowToggle={toggleFollow}
            />
          )}

        </div>
        {/* ── end main content area ── */}

      </SidebarInset>

      </div>
    </TooltipProvider>
  </SidebarProvider>
);

  
}
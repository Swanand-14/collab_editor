import React from "react";
import { Users, Clock, FileText, FolderPlus, Trash2, Edit3 } from "lucide-react";

interface ParticipantInfo {
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

interface ActivityLogEntry {
  id: string;
  userId: string;
  userName: string;
  action: string;
  details?: string;
  timestamp: number;
  fileId?: string;
  filePath?: string;
}

interface ParticipantsPanelProps {
  participants: ParticipantInfo[];
  activityLogs: ActivityLogEntry[];
  currentUserId?: string;
  followingUserId?: string | null; 
  onFollowToggle?: (userId: string) => void;
}

export function ParticipantsPanel({ 
  participants, 
  activityLogs, 
  currentUserId , followingUserId, onFollowToggle
}: ParticipantsPanelProps) {
  const formatTime = (timestamp: number) => {
    const now = Date.now();
    const diff = now - timestamp;
    
    if (diff < 60000) return "just now";
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return new Date(timestamp).toLocaleDateString();
  };

  const getActivityIcon = (action: string) => {
    switch (action) {
      case "edited file":
        return <Edit3 className="h-3 w-3" />;
      case "created":
        return <FolderPlus className="h-3 w-3" />;
      case "deleted":
        return <Trash2 className="h-3 w-3" />;
      case "renamed":
        return <FileText className="h-3 w-3" />;
      case "joined":
        return <Users className="h-3 w-3 text-green-500" />;
      case "left":
        return <Users className="h-3 w-3 text-red-500" />;
      default:
        return <FileText className="h-3 w-3" />;
    }
  };

  // Helper to get proxied image URL
  const getProxiedImageUrl = (imageUrl?: string) => {
    if (!imageUrl) return null;
    
    // Check if it's a Google profile image that needs proxying
    if (imageUrl.includes('googleusercontent.com') || imageUrl.includes('lh3.google')) {
      return `/api/proxy-image?url=${encodeURIComponent(imageUrl)}`;
    }
    
    return imageUrl;
  };
 const getFileName = (filePath?: string) => {
    if (!filePath) return null;
    const parts = filePath.split('/');
    return parts[parts.length - 1];
  };
  return (
    <div className="flex flex-col h-full bg-background border-l w-80">
      {/* Participants Section */}
      <div className="border-b">
        <div className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <Users className="h-4 w-4 text-primary" />
            <h3 className="font-semibold text-sm">
              Participants ({participants.length})
            </h3>
          </div>
          
          <div className="space-y-2">
            {participants.map((participant) => {
              const isCurrentUser = participant.userId === currentUserId;
              const proxiedImageUrl = getProxiedImageUrl(participant.userImage);
              const fileName = getFileName(participant.activeFile);
              const isFollowing = followingUserId === participant.userId;
              
              return (
                <div
                  key={participant.userId}
                  onClick={() => !isCurrentUser && onFollowToggle?.(participant.userId)}
                  className={`
                    flex items-center gap-3 p-2 rounded-md transition-all
                    ${isCurrentUser 
                      ? 'bg-muted/30' 
                      : 'cursor-pointer hover:bg-muted/50'
                    }
                    ${isFollowing 
                      ? 'bg-blue-50 dark:bg-blue-950/30 border-l-4 border-blue-500 pl-[6px]' 
                      : ''
                    }
                  `}
                >
                  <div className="relative">
                    {proxiedImageUrl ? (
                      <img
                        src={proxiedImageUrl}
                        alt={participant.userName}
                        className="h-8 w-8 rounded-full object-cover"
                        onError={(e) => {
                          // Fallback if proxy fails
                          const target = e.target as HTMLImageElement;
                          target.style.display = 'none';
                          const fallback = target.nextElementSibling as HTMLElement;
                          if (fallback) fallback.style.display = 'flex';
                        }}
                      />
                    ) : null}
                    <div 
                      className="h-8 w-8 rounded-full bg-primary/20 flex items-center justify-center"
                      style={{ display: proxiedImageUrl ? 'none' : 'flex' }}
                    >
                      <span className="text-xs font-semibold">
                        {participant.userName.charAt(0).toUpperCase()}
                      </span>
                    </div>
                    <div className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full bg-green-500 border-2 border-background" />
                  </div>
                  
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium truncate">
                        {participant.userName}
                        {isCurrentUser && " (You)"}
                      </p>
                      <span className="text-xs text-muted-foreground px-1.5 py-0.5 rounded bg-muted">
                        {participant.role}
                      </span>
                    </div>
                    {!isCurrentUser && fileName && (
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <p className="text-xs text-muted-foreground truncate">
                          {fileName}
                          {participant.cursor?.position && (
                            <span className="text-primary font-medium ml-1">
                              :{participant.cursor.position.lineNumber}
                            </span>
                          )}
                        </p>
                      </div>
                    )}
                  </div>
                   {!isCurrentUser && (
                    <div className="flex items-center">
                      <div 
                        className={`
                          w-2 h-2 rounded-full transition-all
                          ${isFollowing 
                            ? 'bg-blue-500 shadow-[0_0_0_4px_rgba(59,130,246,0.3)] animate-pulse' 
                            : 'bg-gray-400 dark:bg-gray-600'
                          }
                        `}
                      />
                    </div>
                  )}
                  
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Activity Feed Section */}
      <div className="flex-1 overflow-hidden flex flex-col">
        <div className="p-4 pb-2 border-b">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-primary" />
            <h3 className="font-semibold text-sm">Recent Activity</h3>
          </div>
        </div>
        
        <div className="flex-1 overflow-y-auto">
          <div className="p-4 space-y-3">
            {activityLogs.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-4">
                No activity yet
              </p>
            ) : (
              activityLogs.map((log) => (
                <div
                  key={log.id}
                  className="flex gap-3 text-xs group hover:bg-muted/30 p-2 rounded-md transition-colors"
                >
                  <div className="mt-0.5 text-muted-foreground">
                    {getActivityIcon(log.action)}
                  </div>
                  
                  <div className="flex-1 min-w-0">
                    <p className="text-foreground">
                      <span className="font-medium">{log.userName}</span>
                      {" "}
                      <span className="text-muted-foreground">{log.action}</span>
                    </p>
                    
                    {log.details && (
                      <p className="text-muted-foreground truncate mt-0.5">
                        {log.details}
                      </p>
                    )}
                    
                    <p className="text-muted-foreground/70 mt-1">
                      {formatTime(log.timestamp)}
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
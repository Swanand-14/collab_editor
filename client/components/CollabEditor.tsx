"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Editor, { Monaco } from "@monaco-editor/react";
import { editor } from "monaco-editor";
import { useCollabSocket } from "../hooks/useCollabSocket";
import { Loader2 } from "lucide-react";
import { RemoteCursor } from "../hooks/useRemoteCursors";
import "@/modules/collaboration/styles/remote-cursor.css";
import { useProximityWarnings } from "../hooks/useProximityWarnings";
import { configureMonaco, getEditorLanguage } from "@/modules/playground/lib/editor-config";

interface CollabEditorProps {
  sessionId: string;
  userId?: string;
  userName?: string;
  fileId: string;
  filePath: string;
  initialContent: string;
  language: string;
  onContentChange?: (content: string) => void;
  remoteCursors?:RemoteCursor[];
  onEditorReady?: (editor: editor.IStandaloneCodeEditor) => void;
  onCursorPositionChange?: (position: { lineNumber: number; column: number }) => void;
}

class CursorLabelWidget implements editor.IContentWidget {
  private readonly _id: string;
  private readonly _domNode: HTMLElement;
  private _position: editor.IContentWidgetPosition | null = null;
  private _editor: editor.IStandaloneCodeEditor | null = null;

  constructor(
    private readonly userId: string,
    private readonly userName: string,
    private readonly color: string,
    private readonly position: { lineNumber: number; column: number }
  ) {
    this._id = `cursor.label.${userId}`;
    this._domNode = document.createElement("div");
    this._domNode.className = `cursorLabel cursorLabel${color}`;
    this._domNode.textContent = userName;
    // 🔥 FIX: Remove position: absolute from inline styles - let Monaco handle positioning
    this._domNode.style.pointerEvents = "none";
    this._domNode.style.position = "relative"; // Monaco widgets are positioned relative
    this._domNode.style.marginTop = "-24px"; // Push up above the line instead of using absolute positioning
    this._domNode.style.marginBottom = "20px"; // Add space below so text doesn't overlap
    this._domNode.style.display = "inline-block"; // Make sure it takes up space properly
  }

  getId(): string {
    return this._id;
  }

  getDomNode(): HTMLElement {
    return this._domNode;
  }

  getPosition(): editor.IContentWidgetPosition | null {
    return this._position;
  }

  setEditor(ed: editor.IStandaloneCodeEditor): void {
    this._editor = ed;
  }

  updatePosition(position: { lineNumber: number; column: number }): void {
    this._position = {
      position: {
        lineNumber: position.lineNumber,
        column: position.column,
      },
      preference: [
        editor.ContentWidgetPositionPreference.ABOVE,
        editor.ContentWidgetPositionPreference.BELOW,
      ],
    };
    
    // 🔥 FIX: Force Monaco to re-layout the widget at the new position
    if (this._editor) {
      this._editor.layoutContentWidget(this);
    }
  }

  dispose(): void {
    this._domNode.remove();
  }
}


class ProximityGlyphWidget implements editor.IContentWidget {
  private readonly _id: string;
  private readonly _domNode: HTMLElement;
  private _position: editor.IContentWidgetPosition | null = null;
  private _editor: editor.IStandaloneCodeEditor | null = null;

  constructor(
    private readonly lineNumber: number,
    private readonly severity: "warning" | "info",
    private readonly tooltip: string,
    private readonly uniqueId: string
  ) {
    this._id = `proximity.glyph.${uniqueId}.${lineNumber}`;
    this._domNode = document.createElement("div");
    
    // Create the icon
    if (severity === "warning") {
      this._domNode.innerHTML = '⚠️'; // Red warning
      this._domNode.className = 'proximity-glyph proximity-warning-glyph';
      this._domNode.style.color = '#ef4444';
    } else {
      this._domNode.innerHTML = '👥'; // Yellow info
      this._domNode.className = 'proximity-glyph proximity-info-glyph';
      this._domNode.style.color = '#f59e0b';
    }
    
    this._domNode.style.position = 'absolute';
    this._domNode.style.left = '-22px'; // Position in glyph margin area
    this._domNode.style.fontSize = '14px';
    this._domNode.style.lineHeight = '1';
    this._domNode.style.cursor = 'help';
    this._domNode.style.zIndex = '10';
    this._domNode.title = tooltip;
    
    if (severity === "warning") {
      this._domNode.style.animation = 'proximity-pulse 2s ease-in-out infinite';
    }
  }

  getId(): string {
    return this._id;
  }

  getDomNode(): HTMLElement {
    return this._domNode;
  }

  getPosition(): editor.IContentWidgetPosition | null {
    return this._position;
  }

  setEditor(ed: editor.IStandaloneCodeEditor): void {
    this._editor = ed;
  }

  setPosition(lineNumber: number): void {
    this._position = {
      position: {
        lineNumber: lineNumber,
        column: 1,
      },
      preference: [editor.ContentWidgetPositionPreference.EXACT],
    };
    
    if (this._editor) {
      this._editor.layoutContentWidget(this);
    }
  }

  dispose(): void {
    this._domNode.remove();
  }
}



export function CollabEditor({
  sessionId,
  userId,
  userName,
  fileId,
  filePath,
  initialContent,
  language,
  onContentChange,remoteCursors = [], onCursorPositionChange,onEditorReady
}: CollabEditorProps) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const [content, setContent] = useState<string>(initialContent);
  const [localCursorPosition,setLocalCursorPosition] = useState<{lineNumber:number;column:number}>({lineNumber:1,column:1});
  const isRemoteChange = useRef<boolean>(false);
  const cursorUpdateTimeout = useRef<NodeJS.Timeout | null>(null);
  const previousFileId = useRef<string>(fileId);
  
  // 🔥 FIX: Track if this is the initial mount
  const isInitialMount = useRef<boolean>(true);
  const currentFileIdRef = useRef<string>(fileId);
  const currentFilePathRef = useRef<string>(filePath);
  const decorationIdsRef = useRef<string[]>([]);
  const cursorWidgetsRef = useRef<Map<string, CursorLabelWidget>>(new Map());
  const glyphWidgetsRef = useRef<Map<string, ProximityGlyphWidget>>(new Map());

  const { socket, isConnected, emitCursorMove, emitEditorChange } = useCollabSocket(
    sessionId,
    userId,
    userName
  );

 

  useEffect(()=>{
    currentFileIdRef.current = fileId;
    currentFilePathRef.current = filePath;
    console.log(`📁 Updated current file refs: ${fileId} | ${filePath}`);

  },[fileId,filePath])
   const updateEditorLanguage = useCallback(() => {
    if (!monacoRef.current || !editorRef.current) return;
    
    const model = editorRef.current.getModel();
    if (!model) return;

    // Extract file extension from filePath
    const fileExtension = filePath.split('.').pop() || '';
    const detectedLanguage = getEditorLanguage(fileExtension);
    
    console.log(`🎨 Setting language for ${filePath}: ${detectedLanguage} (extension: ${fileExtension})`);
    
    try {
      monacoRef.current.editor.setModelLanguage(model, detectedLanguage);
    } catch (error) {
      console.warn("Failed to set editor language:", error);
    }
  }, [filePath]);

  const handleEditorDidMount = useCallback(
    (editor: editor.IStandaloneCodeEditor, monaco: Monaco) => {
      editorRef.current = editor;
      monacoRef.current = monaco;

      console.log("✅ Monaco editor mounted for collab");
      configureMonaco(monaco);
      
      // 🔥 FIX: Set initial language (was missing!)
      updateEditorLanguage();
      onEditorReady?.(editor);

      // Listen for cursor position changes
      editor.onDidChangeCursorPosition((e) => {
      if (!isRemoteChange.current) {
        onCursorPositionChange?.(e.position);
        setLocalCursorPosition(e.position);
        const currentFileId = currentFileIdRef.current;
        const currentFilePath = currentFilePathRef.current;
        // 🔥 FIX: Safely check if selection exists and is not empty
        const selection = editor.getSelection();
        const hasSelection = selection ? !selection.isEmpty() : false;
        
        // 🔥 ADD: Log local cursor movement
        console.log('[Cursor Detection] 📍 Local cursor moved:', {
          line: e.position.lineNumber,
          column: e.position.column,
          file: currentFilePath,
          fileId: currentFileId,
          hasSelection
        });

        // Debounce cursor updates
        if (cursorUpdateTimeout.current) {
          clearTimeout(cursorUpdateTimeout.current);
        }

        cursorUpdateTimeout.current = setTimeout(() => {
          // Get fresh selection state
          const currentSelection = editor.getSelection();
          
          const payload = {
            fileId:currentFileId,
            filePath:currentFilePath, // ✅ NOW INCLUDED!
            position: {
              lineNumber: e.position.lineNumber,
              column: e.position.column,
            },
            selection: currentSelection && !currentSelection.isEmpty()
              ? {
                  startLineNumber: currentSelection.startLineNumber,
                  startColumn: currentSelection.startColumn,
                  endLineNumber: currentSelection.endLineNumber,
                  endColumn: currentSelection.endColumn,
                }
              : undefined,
          };

          // 🔥 ADD: Log socket emission
          console.log('[Socket Emit] 📤 cursor:move', {
            sessionId,
            userId,
            userName,
            ...payload
          });

          emitCursorMove(payload);
        }, 100); // Debounced to 100ms
      }
    });

    },
    [ emitCursorMove, sessionId, userId, userName, onCursorPositionChange]
  );

  const handleEditorChange = useCallback(
    (value: string | undefined) => {
      if (!value || isRemoteChange.current) return;

      const newContent = value;
      setContent(newContent);
      onContentChange?.(newContent);

      // Emit change to other users
      const editor = editorRef.current;
      if (editor) {
        const model = editor.getModel();
        if (model) {
          emitEditorChange({
            fileId:currentFileIdRef.current,
            filePath:currentFilePathRef.current,
            content: newContent,
            changes: [],
            timestamp: Date.now(),
          });
        }
      }
    },
    [fileId, filePath, emitEditorChange, onContentChange]
  );
   useEffect(() => {
    updateEditorLanguage();
  }, [filePath, updateEditorLanguage]);
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco || !remoteCursors) return;

    console.log(`🎨 Rendering ${remoteCursors.length} remote cursors`);
    

    const newDecorations: editor.IModelDeltaDecoration[] = [];
    const oldWidgets = cursorWidgetsRef.current;
    const newWidgets = new Map<string, CursorLabelWidget>();
    
   

    const oldGlyphs = glyphWidgetsRef.current;
    const newGlyphs = new Map<string, ProximityGlyphWidget>();
    const ZONE_RADIUS = 2;



    remoteCursors.forEach((cursor) => {
      const colorName = cursor.color?.name || 'blue';
      const capitalizedColor = colorName.charAt(0).toUpperCase() + colorName.slice(1);
      const cursorClassName = `remoteCursor${capitalizedColor}`;
      const lightClassName = 'proximity-zone-yellow';
      const distance = Math.abs(cursor.position.lineNumber - localCursorPosition.lineNumber);
      const ZONE_VISIBILITY_THRESHOLD = 15;
    const shouldShowZones = distance <= ZONE_VISIBILITY_THRESHOLD;
      if(shouldShowZones){
      for(let offset = -ZONE_RADIUS; offset <= ZONE_RADIUS; offset++) {
        const zoneClassName = (offset === 0) 
        ? 'proximity-zone-danger'  // 🔥 Main cursor line = YELLOW DANGER
        : lightClassName;
        const zoneLine = cursor.position.lineNumber + offset;
        if(zoneLine<1)continue;
        newDecorations.push({
        range: new monaco.Range(zoneLine, 1, zoneLine, 1),
        options: {
          isWholeLine: true,
          className: zoneClassName,
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      });
      }
    }

     let severity: "warning" | "info" | null = null;
    let hoverMessage = `👤 **${cursor.userName}** is editing here`;

      if(distance<=3){
        severity = "warning";
        hoverMessage = `⚠️ **${cursor.userName}** is ${distance} line${distance !== 1 ? 's' : ''} away (close proximity)`;
      } else if (distance <= 7) {
        severity = "info";
        hoverMessage = `ℹ️ **${cursor.userName}** is ${distance} line${distance !== 1 ? 's' : ''} away`;
      }

      if (severity) {
        const glyphKey = `${cursor.userId}-${cursor.position.lineNumber}`;
        let glyphWidget = oldGlyphs.get(glyphKey);
        
        if (!glyphWidget) {
          glyphWidget = new ProximityGlyphWidget(
            cursor.position.lineNumber,
            severity,
            hoverMessage,
            cursor.userId
          );
          glyphWidget.setEditor(editor);
          glyphWidget.setPosition(cursor.position.lineNumber);
          editor.addContentWidget(glyphWidget);
          console.log(`✨ Created glyph widget for ${cursor.userName} at line ${cursor.position.lineNumber} (${severity})`);
        } else {
          glyphWidget.setPosition(cursor.position.lineNumber);
          console.log(`🔄 Updated glyph widget for ${cursor.userName}`);
        }
        
        newGlyphs.set(glyphKey, glyphWidget);
      }
      
      console.log(`🎨 Decorating cursor for ${cursor.userName} at line ${cursor.position.lineNumber} with color ${colorName}, class: ${cursorClassName}`);
      
      // 🔥 Main cursor decoration - using className which Monaco recognizes
      newDecorations.push({
        range: new monaco.Range(
          cursor.position.lineNumber,
          cursor.position.column,
          cursor.position.lineNumber,
          cursor.position.column + 1  // Give it some width so it's visible
        ),
        options: {
          className: cursorClassName,
          hoverMessage: { value: `👤 **${cursor.userName}** is editing here` },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          isWholeLine: false,
          

        },
      });

      // 🔥 Selection highlight (if exists)
      if (cursor.selection) {
        const selectionClassName = `remoteSelection${capitalizedColor}`;
        newDecorations.push({
          range: new monaco.Range(
            cursor.selection.startLineNumber,
            cursor.selection.startColumn,
            cursor.selection.endLineNumber,
            cursor.selection.endColumn
          ),
          options: {
            className: selectionClassName,
            isWholeLine: false,
          },
        });
      }

      let widget = oldWidgets.get(cursor.userId);
      
      if (!widget) {
        // Create new widget
        widget = new CursorLabelWidget(
          cursor.userId,
          cursor.userName,
          capitalizedColor,
          cursor.position
        );
        
        // 🔥 FIX: Pass editor reference so widget can trigger layout updates
        widget.setEditor(editor);
        
        // Set position BEFORE adding to editor
        widget.updatePosition(cursor.position);
        
        editor.addContentWidget(widget);
        console.log(`✨ Created label widget for ${cursor.userName}`);
        console.log(`  Widget ID: ${widget.getId()}, DOM Element: ${widget.getDomNode().className}, Position: line ${cursor.position.lineNumber}, col ${cursor.position.column}`);
      } else {
        // Update position for existing widget
        widget.updatePosition(cursor.position);
        console.log(`🔄 Updated position for ${cursor.userName} to line ${cursor.position.lineNumber}, col ${cursor.position.column}`);
      }
      
      newWidgets.set(cursor.userId, widget);
    });
   

    oldGlyphs.forEach((widget, key) => {
      if (!newGlyphs.has(key)) {
        editor.removeContentWidget(widget);
        widget.dispose();
        console.log(`🗑️ Removed glyph widget ${key}`);
      }
    });
     glyphWidgetsRef.current = newGlyphs;

    oldWidgets.forEach((widget, userId) => {
      if (!newWidgets.has(userId)) {
        editor.removeContentWidget(widget);
        widget.dispose();
        console.log(`🗑️ Removed label widget for user ${userId}`);
      }
    });

    cursorWidgetsRef.current = newWidgets;

    // Apply decorations
    const oldDecorations = decorationIdsRef.current;
    decorationIdsRef.current = editor.deltaDecorations(
      oldDecorations,
      newDecorations
    );

    console.log(`✅ Applied ${newDecorations.length} decorations (replaced ${oldDecorations.length} old ones)`);
    
    // 🔥 DEBUG: Check if decorations exist in DOM - look in multiple places
    setTimeout(() => {
      const decorationElements = document.querySelectorAll('[class*="remoteCursor"]');
      const glyphElements = document.querySelectorAll('[class*="cursorGlyph"]');
      const labelElements = document.querySelectorAll('.cursorLabel');
      const allWidgets = document.querySelectorAll('[id*="cursor.label"]');
      
      console.log(`🔍 Found ${decorationElements.length} cursor decoration elements + ${glyphElements.length} glyph elements in DOM`);
      console.log(`🔍 Found ${labelElements.length} label elements + ${allWidgets.length} widget elements in DOM`);
      
      // Log specific classes found
      if (decorationElements.length > 0) {
        decorationElements.forEach((el, i) => {
          const htmlEl = el as HTMLElement;
          console.log(`  [Decoration ${i}] Classes: ${el.className}, Text: "${el.textContent}", Visible: ${htmlEl.offsetHeight > 0}`);
        });
      }
      
      if (labelElements.length > 0) {
        labelElements.forEach((el, i) => {
          const htmlEl = el as HTMLElement;
          console.log(`  [Label ${i}] Classes: ${el.className}, Text: "${el.textContent}", Visible: ${htmlEl.offsetHeight > 0}, Parent: ${htmlEl.parentElement?.className}`);
        });
      }
      
      if (decorationElements.length === 0 && glyphElements.length === 0 && labelElements.length === 0) {
        console.warn("⚠️ No cursor decorations found in DOM!");
        console.warn("Checking if CSS is loaded...");
        const cssRules = Array.from(document.styleSheets).flatMap(sheet => {
          try {
            return Array.from(sheet.cssRules);
          } catch {
            return [];
          }
        });
        const hasCursorCss = cssRules.some(rule => rule.cssText?.includes('remoteCursor'));
        console.warn(`CSS loaded: ${hasCursorCss}`);
        
        // Check if Monaco editor itself is rendering anything
        const monacoWidgetArea = document.querySelector('.monaco-editor .contentWidgets');
        console.warn(`Monaco content widgets area exists: ${!!monacoWidgetArea}`);
        if (monacoWidgetArea) {
          console.warn(`  Content in area: ${monacoWidgetArea.children.length} children`);
        }
      }
    }, 100);
  }, [remoteCursors,localCursorPosition]);

  // 🔥 FIX: Listen for remote changes
  useEffect(() => {
    if (!socket) return;

    const handleRemoteChange = (payload: {
      userId: string;
      userName: string;
      fileId: string;
      content: string;
    }) => {
      // Only apply if it's for this file and from another user
      if (payload.fileId === fileId && payload.userId !== userId) {
        console.log(`📝 Remote change from ${payload.userName} on ${payload.fileId}`);
        
        isRemoteChange.current = true;
        const editor = editorRef.current;
        
        if (editor) {
          const currentPosition = editor.getPosition();
          const currentScrollTop = editor.getScrollTop();
          
          // Update content
          setContent(payload.content);
          editor.setValue(payload.content);
          
          // Restore cursor and scroll position
          if (currentPosition) {
            editor.setPosition(currentPosition);
          }
          editor.setScrollTop(currentScrollTop);
        }
        
        setTimeout(() => {
          isRemoteChange.current = false;
        }, 50);
      }
    };

    const handleRemoteCursor = (payload: {
      userId: string;
      userName: string;
      fileId: string;
      position: { lineNumber: number; column: number };
    }) => {
      if (payload.fileId === fileId && payload.userId !== userId) {
        console.log(`👆 Remote cursor from ${payload.userName} on file ${fileId}`);
        // TODO - render cursor decoration
      }
    };

    socket.on("editor:change", handleRemoteChange);
    socket.on("cursor:move", handleRemoteCursor);

    return () => {
      socket.off("editor:change", handleRemoteChange);
      socket.off("cursor:move", handleRemoteCursor);
    };
  }, [socket, fileId, userId]);

  // 🔥 FIX: Only update editor when switching files, NOT on every content change
  useEffect(() => {
    // Check if the file has actually changed
    const fileChanged = previousFileId.current !== fileId;
    
    if (fileChanged || isInitialMount.current) {
      console.log(`📂 Switching to file: ${fileId}`);
      
      // Update content
      setContent(initialContent);
      
      if (editorRef.current) {
        isRemoteChange.current = true;
        editorRef.current.setValue(initialContent);
        
        // Reset cursor to start when switching files
        editorRef.current.setPosition({ lineNumber: 1, column: 1 });
        updateEditorLanguage();
        
        setTimeout(() => {
          isRemoteChange.current = false;
        }, 50);
      }
      
      // Update refs
      previousFileId.current = fileId;
      isInitialMount.current = false;
    } else if (initialContent !== content) {
      // Same file but content changed (e.g., package.json updated from WebContainer)
      console.log(`📝 Content updated for file: ${fileId}`);
      setContent(initialContent);
      
      if (editorRef.current) {
        isRemoteChange.current = true;
        editorRef.current.setValue(initialContent);
        
        setTimeout(() => {
          isRemoteChange.current = false;
        }, 50);
      }
    }
  }, [fileId, initialContent]); // ✅ Now also depends on initialContent for external updates

  useEffect(() => {
    return () => {
      const editor = editorRef.current;
      if (editor) {
        cursorWidgetsRef.current.forEach((widget) => {
          editor.removeContentWidget(widget);
          widget.dispose();
        });
        cursorWidgetsRef.current.clear();

         glyphWidgetsRef.current.forEach((widget) => {
          editor.removeContentWidget(widget);
          widget.dispose();
        });
        glyphWidgetsRef.current.clear();
      }
    };
  }, []);

  return (
    <div className="relative h-full w-full">
      {/* Connection indicator */}
      {!isConnected && (
        <div className="absolute top-2 right-2 z-10 flex items-center gap-2 px-3 py-1 bg-yellow-100 dark:bg-yellow-900 text-yellow-800 dark:text-yellow-200 rounded-md text-sm">
          <Loader2 className="h-3 w-3 animate-spin" />
          Reconnecting...
        </div>
      )}

      <Editor
        height="100%"
        language={language}
        value={content}
        onChange={handleEditorChange}
        onMount={handleEditorDidMount}
        theme="vs-dark"
        options={{
          minimap: { enabled: true },
          fontSize: 14,
          lineNumbers: "on",
          roundedSelection: false,
          scrollBeyondLastLine: false,
          automaticLayout: true,
          tabSize: 2,
          wordWrap: "on",
          glyphMargin:true
        }}
      />
    </div>
  );
}
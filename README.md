Real-Time Collaborative Text Editor

🚀 Overview

This project is a real-time collaborative text editor where multiple users can edit the same document simultaneously. It demonstrates low-latency synchronization, user presence tracking, and live cursor updates using WebSockets.

This project is a focused extraction of a larger collaborative code editor system, refined specifically for this hackathon.

⸻

✨ Features
	•	🔄 Real-time text synchronization across multiple users
	•	👥 User presence (see who is connected)
	•	🎯 Live cursor tracking with visual indicators
	•	⚡ Low-latency updates using WebSockets (Socket.IO)
	•	🧠 Basic conflict handling for concurrent edits

⸻

🛠️ Tech Stack
	•	Frontend: React (Next.js)
	•	Backend: Node.js + Socket.IO
	•	Communication: WebSockets

⸻

🏗️ Architecture (Simplified)
	•	Each document/session is handled as a Socket.IO room
	•	Clients emit text changes → server broadcasts to all connected users
	•	Cursor positions are synced in real-time per user
	•	Participant list updates dynamically on join/leave

⸻

📹 Demo Video
https://drive.google.com/file/d/1gcbWXBzfdHsrxx2c_gMpYYnYppM1mlfL/view?usp=drive_link

⸻

🌐 Live Deployment

Not deployed due to time constraints.
Full functionality is demonstrated in the demo video.

ow to Run Locally

1. Clone the repository
    git clone https://github.com/your-username/collab-editor.git
cd collab-editor

2. Install dependencies
 npm install
3.Start backend server
cd server
node server.ts

4. Start frontend
 cd client
npm run dev

 Key Engineering Decisions
	•	Socket.IO used for reliable real-time communication
	•	Room-based architecture for session isolation
	•	Event-driven updates for efficient synchronization
	•	Lightweight approach instead of heavy CRDT frameworks (optimized for simplicity and speed)

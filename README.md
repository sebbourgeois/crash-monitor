# Stake Crash Clone

A local clone of the Stake.com Crash game statistics interface. This project consists of a Node.js backend that scrapes real-time data (using Puppeteer) and a React frontend for visualization.

## Architecture

- **Backend (`/`)**: Node.js + Express + Socket.io + Puppeteer.
  - Connects to a data source (EdgeGPT) via a headless browser to bypass bot protections.
  - Broadcasts game events (STARTING, TICK, CRASH) via WebSocket (Socket.io) on port `3005`.
  - Includes a "Mock Mode" fallback that generates simulated data if the live feed is blocked.
- **Frontend (`/frontend`)**: React + Vite.
  - Connects to the backend via Socket.io.
  - Displays real-time multiplier, game status, and session history.

## Prerequisites

- Node.js (v18+ recommended)
- NPM

## Installation

1.  **Backend Setup**
    ```bash
    # Install dependencies in the root directory
    npm install
    ```

2.  **Frontend Setup**
    ```bash
    cd frontend
    npm install
    ```

## Running Locally

You need to run both the backend and frontend terminals simultaneously.

### 1. Start the Backend
```bash
# From root directory
node server.js
```
*You will see logs indicating the headless browser is launching. If valid data isn't received within 15 seconds, it will switch to Mock Mode automatically.*

### 2. Start the Frontend
```bash
# From /frontend directory
npm run dev
```
Open [http://localhost:5173](http://localhost:5173) to view the app.

## Deployment

### Frontend (Static Site)
The frontend is a standard Vite React app.
1.  Build the project:
    ```bash
    cd frontend
    npm run build
    ```
2.  Deploy the `frontend/dist` folder to any static host (Vercel, Netlify, Cloudflare Pages, S3).

### Backend (Node.js + Puppeteer)
The backend requires a runtime environment that supports Headless Chrome (Puppeteer).

**Option A: VPS (DigitalOcean, EC2, etc.)**
1.  Clone repo.
2.  Install Chrome dependencies (libraries for Puppeteer).
3.  Run `node server.js` (suggest using `pm2` for process management).

**Option B: Platform as a Service (Render, Heroku)**
If deploying to platforms like Render:
1.  Add a **Build Output** directory of `.` (root).
2.  **Environment Command**: `node server.js`.
3.  **Puppeteer Support**: You MUST verify the platform supports Puppeteer.
    - On **Render**: Add an Environment Variable `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD` = `true` (if using their chrome image) or follow their [Puppeteer guide](https://render.com/docs/puppeteer). You may need to add a Build Key to install the Chrome binaries.

**IMPORTANT**: 
The `server.js` is configured to run on specific ports. For deployment, ensure you update the `PORT` variable or use `process.env.PORT`.
- Update `frontend/src/App.jsx` to point to your deployed backend URL instead of `localhost:3005`.

## Troubleshooting
- **No Data?** The backend waits 15 seconds for real data. If blocked by Cloudflare, it switches to Mock Mode. Check the terminal for "Mock: Game Starting" logs.
- **Port Conflicts?** Ensure ports 3005 and 5173 are free.

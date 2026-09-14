# Friend Mode Signaling Relay

A tiny WebSocket server with **one job**: let two phones find each other
and exchange WebRTC handshake data (SDP offer/answer + ICE candidates) so
they can open a direct peer-to-peer connection.

- No database. No accounts. No persistence.
- Never sees Gemini API keys, game state, chat, votes, or roles.
- Once the two phones' WebRTC connection is up, this server is out of
  the loop completely - gameplay traffic goes phone-to-phone.
- Rooms are single-use, in-memory, and expire automatically (5 minutes
  if nobody joins).

Total dependency footprint: one package (`ws`).

---

## 1. Run it locally first (sanity check)

```bash
cd signaling-server
npm install
npm start
```

You should see:

```
Friend Mode signaling relay listening on port 8080
```

Visit `http://localhost:8080` in a browser - you should see a plain
text "running" message. That's the health-check endpoint hosting
platforms use to confirm the service is alive.

### Quick manual protocol test (optional, no app needed yet)

Install a WebSocket CLI client once:

```bash
npm install -g wscat
```

Terminal A (acts as Host):
```bash
wscat -c ws://localhost:8080
> {"type":"host-create"}
< {"type":"host-created","code":"AB3XQ9"}
```

Terminal B (acts as Friend), using the code from Terminal A:
```bash
wscat -c ws://localhost:8080
> {"type":"friend-join","code":"AB3XQ9"}
< {"type":"friend-joined","code":"AB3XQ9"}
```

Terminal A should now receive:
```
< {"type":"peer-joined"}
```

Now either side can relay a handshake payload:
```bash
# In Terminal A:
> {"type":"signal","payload":{"sdp":"...test..."}}
```
Terminal B receives:
```
< {"type":"signal","payload":{"sdp":"...test..."}}
```

If that round-trip works, the relay logic is correct and you're ready
to deploy.

---

## 2. Why Koyeb (not Render/Fly.io) for this project

| Platform | Card needed? | Runs this `server.js` unmodified? | Notes |
|---|---|---|---|
| **Koyeb** | Free web service is designed to not require one (may ask only if their abuse-detection flags an account, not the norm) | **Yes** - plain Node + `ws`, git-based deploy | Cold start after 1h idle: ~1-5s |
| Render | Free tier is documented as card-free, but a number of accounts get asked for one anyway (region/signup-method dependent) - you already hit this | Yes | Not worth fighting with |
| Fly.io | **Always asks for a card**, even for the free allowance | Yes | Ruled out - contradicts "no card" |
| Cloudflare Workers | No card, genuinely free (Durable Objects are free-tier since 2025) | **No** - Workers don't run plain Node `http`/`ws`; the relay logic would need a rewrite into the Workers/Durable Object API | Worth revisiting later if Koyeb ever becomes annoying, but not the simple path today |

**Koyeb** is the pick: it deploys this exact `server.js` with zero code
changes, and its own official docs use this exact stack (Node/`ws`
WebSocket server, git-deployed, free instance) as their example.

## 3. Deploy on Koyeb - entirely from an Android phone (no computer, no Termux)

You don't need `git` on your phone. GitHub's website lets you upload
files directly through its "Add file" button, and Koyeb's dashboard
connects to that GitHub repo with a few taps.

### Step A - Get the files onto your phone

1. Download `signaling-server.zip` (the file shared above) to your phone.
2. Open it with your file manager's built-in "Extract"/"Unzip" (most
   Android file managers, including Files by Google, do this without
   installing anything extra). You should now have a folder containing
   `server.js`, `package.json`, `Procfile`, `README.md`, `.gitignore`,
   `.env.example`.

### Step B - Create the GitHub repo (mobile browser)

1. Go to github.com in your phone's browser and sign up/log in.
2. Tap **+** → **New repository**.
3. Name it `friend-mode-signaling`. Keep it **Public** or **Private**
   (either works for Koyeb). Leave "Initialize with README" **unchecked**.
   Tap **Create repository**.
4. On the new empty repo's page, tap **"uploading an existing file"**
   (the link GitHub shows on an empty repo).
5. Tap **choose your files**, and from your phone's file picker select
   `server.js`, `package.json`, `Procfile`, `.gitignore`, `.env.example`,
   and `README.md` (select all of them at once if your file picker
   allows multi-select; otherwise upload them one at a time by
   repeating "Add file → Upload files").
6. Scroll down, tap **Commit changes**.
7. Refresh the repo page and confirm all the files are there.

### Step C - Deploy on Koyeb (mobile browser)

1. Go to koyeb.com in your phone's browser and sign up (GitHub login
   is the fastest option - it also handles the GitHub authorization
   step below in one tap).
2. In the Koyeb control panel, tap **Create Web Service** (or **Create
   App** → **Web Service**).
3. Choose **GitHub** as the deployment method. If prompted, **Install
   and authorize the Koyeb GitHub App**, and grant it access to the
   `friend-mode-signaling` repo (or "All repositories" if that's
   simpler on mobile).
4. Select the `friend-mode-signaling` repo and the `main` branch.
5. Confirm the **Free** instance type is selected (Koyeb defaults to
   this - don't tap anything that says "Starter"/"Pro"/"Scale").
6. On the health check step: change protocol from **TCP** to **HTTP**
   and set the path to `/` (this matches the plain health-check
   response already built into `server.js`). Leave everything else at
   its default.
7. Tap **Deploy**.
8. Wait for the build/deploy log to finish and show the service as
   **Healthy**. Koyeb shows your app's URL, something like:
   ```
   https://friend-mode-signaling-<your-org>.koyeb.app
   ```
9. Your app's WebSocket URL is the same host with `wss://` instead of
   `https://`:
   ```
   wss://friend-mode-signaling-<your-org>.koyeb.app
   ```
   That single URL is the only thing the Friend Mode client code needs
   to know about this server.

### Step D - Confirm it's actually alive

You don't need a terminal for this - open, on your phone's browser,
any free browser-based WebSocket test tool (search "websocket test
client online"; e.g. websocketking.com or piehost.com's WebSocket
tester both run entirely in the browser, no install, no card). Paste
your `wss://...` URL, connect, and send:
```json
{"type":"host-create"}
```
You should get back something like:
```json
{"type":"host-created","code":"AB3XQ9"}
```
If that comes back, the relay is live and ready for the app to use.

### One thing to expect

Koyeb's free instance scales to zero after **1 hour** with no active
connections. The next "Create Friend Game" tap after that triggers a
cold start - Koyeb's own docs put this at roughly 1-5 seconds, much
shorter than Render's free-tier wake-up. A brief "Connecting..." state
in the app (already in your Connection Status list) covers this
naturally.

---

## 4. What the app needs to know

Just one value: the deployed WebSocket URL
(`wss://<your-app>.onrender.com`). That's the only configuration the
Friend Mode client code needs - no keys, no secrets.

---

## 5. Protocol reference (for the app-side signaling client)

All messages are JSON text frames over a single WebSocket connection.

| Direction | Message | Fields | Meaning |
|---|---|---|---|
| → server | `host-create` | - | "I'm creating a Friend Game" |
| ← server | `host-created` | `code` | Show this code to the player |
| → server | `friend-join` | `code` | "I'm joining with this code" |
| ← server | `friend-joined` | `code` | Join accepted |
| ← server | `peer-joined` | - | (to Host) Friend has joined |
| ↔ server | `signal` | `payload` | Opaque SDP/ICE data, relayed as-is to the other side |
| → server | `leave` | - | Explicit disconnect |
| ← server | `peer-left` | `reason` | Other side disconnected (`"left"` or `"disconnected"`) |
| ← server | `room-expired` | - | (to Host) Nobody joined within 5 minutes |
| ← server | `error` | `reason` | One of: `NOT_FOUND`, `ROOM_FULL`, `ALREADY_IN_ROOM`, `NOT_IN_ROOM`, `PEER_NOT_CONNECTED`, `SERVER_BUSY`, `BAD_MESSAGE`, `UNKNOWN_TYPE` |

`ROOM_FULL` is what enforces "no third human player can join" at the
transport level - a room only ever holds one Host and one Friend slot.

This is intentionally the *entire* server-side surface. Everything
else (game actions, redacted state broadcast, Gemini calls) happens
client-side over the WebRTC DataChannel once the two phones are
connected, exactly as scoped in the Friend Mode plan.

/**
 * FRIEND MODE - SIGNALING RELAY (Imposter AI Bot)
 * =================================================
 * This server does exactly ONE job: help two phones find each other
 * and exchange WebRTC handshake data (SDP offer/answer + ICE
 * candidates) so they can open a direct peer-to-peer connection.
 *
 * It NEVER sees:
 *   - Gemini API keys
 *   - game state, chat messages, votes, roles, secret words
 *   - any personal data
 *
 * Once the two phones' WebRTC connection is established, this server
 * is no longer involved at all - gameplay traffic goes directly
 * phone-to-phone over the WebRTC DataChannel.
 *
 * Everything here is kept in memory only. Nothing is written to disk
 * or to any database. Restarting this server just means any
 * in-progress "waiting to connect" rooms are gone - normal game data
 * is never affected because this server never had any.
 */

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;

// Friend codes exclude visually ambiguous characters (0/O, 1/I/L) so
// they're easy to read aloud and type on a phone keyboard.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

// A room that nobody joins within this window is discarded, so a
// stale/forgotten "Create Friend Game" never lingers in memory.
const ROOM_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Safety cap - this relay is for small private friend sessions only,
// never meant to hold many concurrent rooms.
const MAX_ROOMS = 2000;

/** @type {Map<string, Room>} */
const rooms = new Map();

// --- Friend-invite / presence addition -------------------------------
// These are used ONLY for "invite a friend from my list without typing
// a code". They sit alongside the existing room-code protocol above and
// do not change how host-create / friend-join / signal / leave work.

// Map<myId, WebSocket> - who is currently reachable for a direct invite.
const registeredUsers = new Map();

// Map<fromId, { toId, toWs, hostChoice }> - invites waiting on a response.
const pendingInvites = new Map();
// -----------------------------------------------------------------------

function generateRoomCode() {
  let code;
  do {
    code = Array.from({ length: CODE_LENGTH }, () =>
      CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]
    ).join('');
  } while (rooms.has(code));
  return code;
}

function send(ws, message) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function closeRoom(code, reason) {
  const room = rooms.get(code);
  if (!room) return;
  rooms.delete(code);
  if (room.host && room.host !== null) {
    room.host.roomCode = null;
  }
  if (room.friend && room.friend !== null) {
    room.friend.roomCode = null;
  }
}

function otherPeer(room, ws) {
  if (room.host === ws) return room.friend;
  if (room.friend === ws) return room.host;
  return null;
}

// Periodic sweep: rooms nobody ever joined, past their TTL.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (!room.friend && now - room.createdAt > ROOM_TTL_MS) {
      send(room.host, { type: 'room-expired' });
      closeRoom(code, 'expired');
    }
  }
}, 30 * 1000);

const server = http.createServer((req, res) => {
  // Plain HTTP health-check endpoint. Hosting platforms (Render,
  // Fly.io, uptime pings, etc.) use this to confirm the service is
  // alive. It reveals nothing about active rooms.
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Friend Mode signaling relay is running.\n');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.role = null; // 'host' | 'friend'
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: 'error', reason: 'BAD_MESSAGE' });
      return;
    }

    switch (msg.type) {
      case 'host-create': {
        if (ws.roomCode) {
          send(ws, { type: 'error', reason: 'ALREADY_IN_ROOM' });
          return;
        }
        if (rooms.size >= MAX_ROOMS) {
          send(ws, { type: 'error', reason: 'SERVER_BUSY' });
          return;
        }
        // Normally we mint a brand new code. But if this host-create is
        // completing an accepted friend-invite, `msg.code` carries the
        // code that was already reserved for both sides in
        // 'invite-response' below, so we reuse it instead of generating
        // a second, different one.
        const code = msg.code && !rooms.has(msg.code) ? msg.code : generateRoomCode();
        rooms.set(code, { host: ws, friend: null, createdAt: Date.now() });
        ws.roomCode = code;
        ws.role = 'host';
        send(ws, { type: 'host-created', code });
        break;
      }

      case 'friend-join': {
        const code = String(msg.code || '').trim().toUpperCase();
        const room = rooms.get(code);
        if (ws.roomCode) {
          send(ws, { type: 'error', reason: 'ALREADY_IN_ROOM' });
          return;
        }
        if (!room) {
          send(ws, { type: 'error', reason: 'NOT_FOUND' });
          return;
        }
        if (room.friend) {
          // Exactly one Friend per room - this is what enforces the
          // "max 2 human players" rule at the transport level.
          send(ws, { type: 'error', reason: 'ROOM_FULL' });
          return;
        }
        room.friend = ws;
        ws.roomCode = code;
        ws.role = 'friend';
        send(ws, { type: 'friend-joined', code });
        send(room.host, { type: 'peer-joined' });
        break;
      }

      case 'signal': {
        const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
        if (!room) {
          send(ws, { type: 'error', reason: 'NOT_IN_ROOM' });
          return;
        }
        const target = otherPeer(room, ws);
        if (!target) {
          send(ws, { type: 'error', reason: 'PEER_NOT_CONNECTED' });
          return;
        }
        // Opaque relay: this server does not read or validate the
        // payload contents (SDP/ICE candidate JSON) beyond forwarding it.
        send(target, { type: 'signal', payload: msg.payload });
        break;
      }

      case 'leave': {
        if (ws.roomCode) {
          const room = rooms.get(ws.roomCode);
          if (room) {
            send(otherPeer(room, ws), { type: 'peer-left', reason: 'left' });
            closeRoom(ws.roomCode, 'left');
          }
        }
        break;
      }

      // --- Friend-invite / presence addition ---------------------------
      case 'register': {
        // msg: { type: 'register', myId, displayName }
        registeredUsers.set(msg.myId, ws);
        ws._presenceId = msg.myId; // so we can clean up on close
        ws._presenceName = msg.displayName;
        send(ws, { type: 'registered' });
        break;
      }

      case 'check-online': {
        // msg: { type: 'check-online', ids: string[] }
        const ids = Array.isArray(msg.ids) ? msg.ids : [];
        const onlineIds = ids.filter((id) => registeredUsers.has(id));
        send(ws, { type: 'online-status', onlineIds });
        break;
      }

      case 'invite-friend': {
        // msg: { type: 'invite-friend', toId, fromId, fromName, hostChoice: 'ME' | 'THEM' }
        const target = registeredUsers.get(msg.toId);
        if (!target || target.readyState !== target.OPEN) {
          send(ws, { type: 'friend-offline', toId: msg.toId });
          break;
        }
        // Remember this pending invite so the eventual 'invite-response'
        // knows who to reserve a room code for and who becomes host.
        pendingInvites.set(msg.fromId, {
          toId: msg.toId,
          toWs: target,
          hostChoice: msg.hostChoice,
        });
        send(target, { type: 'friend-invite', fromId: msg.fromId, fromName: msg.fromName });
        break;
      }

      case 'invite-response': {
        // msg: { type: 'invite-response', toId, accept }  (toId = original inviter's id)
        const pending = pendingInvites.get(msg.toId);
        pendingInvites.delete(msg.toId);
        if (!pending) break;
        const inviterWs = registeredUsers.get(msg.toId);
        if (!msg.accept) {
          send(inviterWs, { type: 'invite-declined' });
          break;
        }
        if (rooms.size >= MAX_ROOMS) {
          send(inviterWs, { type: 'error', reason: 'SERVER_BUSY' });
          send(pending.toWs, { type: 'error', reason: 'SERVER_BUSY' });
          break;
        }
        // Reserve a code using the same generator host-create uses, so
        // both sides land in an ordinary room exactly like the
        // type-a-code flow already produces.
        const code = generateRoomCode();
        const inviterIsHost = pending.hostChoice === 'ME';
        send(inviterWs, { type: 'invite-accepted', code, youAreHost: inviterIsHost });
        send(pending.toWs, { type: 'invite-accepted', code, youAreHost: !inviterIsHost });
        break;
      }
      // -------------------------------------------------------------------

      default:
        send(ws, { type: 'error', reason: 'UNKNOWN_TYPE' });
    }
  });

  ws.on('close', () => {
    if (ws.roomCode) {
      const room = rooms.get(ws.roomCode);
      if (room) {
        send(otherPeer(room, ws), { type: 'peer-left', reason: 'disconnected' });
        closeRoom(ws.roomCode, 'disconnected');
      }
    }
    // Friend-invite / presence cleanup - same addition as above.
    if (ws._presenceId) {
      registeredUsers.delete(ws._presenceId);
      pendingInvites.delete(ws._presenceId);
    }
  });
});

// Drop dead sockets (phones that lost connection without a clean
// close) so their room doesn't sit around forever.
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30 * 1000);

server.listen(PORT, () => {
  console.log(`Friend Mode signaling relay listening on port ${PORT}`);
});

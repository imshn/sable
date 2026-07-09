# Sable — private 1:1 chat with end-to-end encryption

WhatsApp-style direct messaging: contact list with presence, per-conversation threads,
unread badges, typing indicators, sent/delivered ticks, encrypted file/photo/audio
sharing, voice notes, location sharing, and peer-to-peer video calls.
Vite + React client, socket.io relay. The server never sees plaintext.

## Features

- **Messages, files, photos, videos, audio, voice notes** — all encrypted with the
  same per-conversation AES-256-GCM key before leaving the device (files up to 15 MB).
- **Voice notes** — tap the mic, record, send; rendered as an inline player.
- **Location sharing** — one tap, shows an OpenStreetMap embed plus a maps link.
- **Video calls** — WebRTC, media flows peer-to-peer with DTLS-SRTP encryption;
  the relay only carries call signaling (SDP/ICE). Mute, camera toggle, hang up,
  incoming-call accept/decline, busy handling. Call outcomes (duration, missed,
  declined, cancelled) are logged as chips in the chat, WhatsApp style.
- **Reactions, delete, forward** — right-click (or long-press) any message for
  quick emoji reactions, copy, forward to another contact, delete for me, and
  delete for everyone. Reactions and deletes travel as encrypted control messages.
- **Attach drawer** — the paperclip opens Photos & videos / Audio / Document pickers;
  the pin opens Send current location / Choose on map.
- **Lightbox** — click any photo or video for a full-screen viewer with
  prev/next arrows, keyboard navigation, and a thumbnail strip.
- **Groups** — create a group from online contacts, chat with per-member
  encryption (every message is sealed separately for each member's key),
  sender names on bubbles, group typing indicators, leave/delete (owner),
  and system notices ("mira left the group").
- **Group video calls** — full WebRTC mesh: everyone connects directly to
  everyone, tiles get name labels, people can join and leave mid-call.
  Mesh is comfortable up to ~6 people; an SFU is the upgrade path beyond that.
- **Ringtone** — synthesized WebAudio ring for incoming calls and a ring-back
  tone while calling. No audio files.
- **Screen sharing** — in any call, share a browser tab, a window, or the whole
  screen (the browser's native picker offers all three). The outgoing video
  track is swapped live via `replaceTrack`; peers who join mid-share see the
  screen too. Stop from the app or the browser's own stop button.
- **Meet-style presenting layout** — the shared screen takes the stage and is
  always shown whole (letterboxed, never cropped); every participant minimizes
  into a filmstrip. One presenter at a time: starting a share automatically
  stops whoever was sharing before.
- **In-call chat** — a side panel inside the call (1:1 and group) using the
  same encrypted conversation. Incoming messages show a toast and an unread
  badge on the chat button; nothing interrupts the call, and the messages stay
  in the thread afterwards.
- **Invites** — add online contacts to an existing group ("Add members" in the
  group menu; everyone gets a joined notice), and ring individual group members
  into an ongoing group call from the in-call invite button.
- **Link previews** — URLs render as anchors, and the first link in a message
  gets a WhatsApp-style OG card (image, title, description, domain). The relay's
  `/preview` endpoint does the fetch, so the relay sees previewed URLs — the
  same tradeoff WhatsApp makes; message content stays encrypted.

## Deployment

- Frontend: https://sable-chat.vercel.app (static, Vercel)
- Relay: Render free tier via [render.yaml](render.yaml) — one-click:
  https://render.com/deploy?repo=https://github.com/imshn/sable
- Vercel env `VITE_RELAY_URL` points the frontend at the relay
  (currently `https://sable-relay.onrender.com`).

Vercel alone can't host the relay: its functions cannot hold WebSocket
connections and don't share the in-memory presence/group registry.
Calls use free openrelay TURN servers so WebRTC connects across
carrier-grade NAT (Jio/Airtel mobile networks).

Free-tier caveat: the Render relay sleeps after ~15 idle minutes; the
first visitor after a quiet spell waits ~30–60s while it wakes.

### Testing on two devices

Camera, microphone, screen capture, and Web Crypto all require a secure
context. `http://localhost` counts; `http://192.168.x.x` does not. To test
across devices, serve over HTTPS (e.g. `vite --host` behind a tunnel like
`cloudflared`/`ngrok`, or local certs via `mkcert`).

### Calls note

Media is peer-to-peer with only a STUN server configured. On the same network
(or with easy NAT) it connects directly; across strict NATs you'd add a TURN
server to `RTC_CONFIG` in [src/useCall.js](src/useCall.js). If the remote video
ever fails browser autoplay rules, it starts muted and shows a "Tap to unmute" pill.

## Run

```sh
npm install
npm run dev
```

Open http://localhost:5173 in two browsers (or two tabs), enter different names,
and each will see the other in the contact list.

## How the encryption works

- Each tab generates a non-extractable ECDH P-256 key pair on entry ([src/crypto.js](src/crypto.js)).
- Public keys are shared through the relay's online directory; each pair of users derives a shared AES-256-GCM key.
- Every message is encrypted for its one recipient with a fresh random IV before it leaves the sender's device.
- The relay ([server/index.js](server/index.js)) only routes `{ iv, ct }` blobs and public keys. It stores nothing.
- The safety code in the sidebar is a SHA-256 fingerprint of your public key — compare it with your peer over another channel to rule out a man-in-the-middle relay.
- If a peer reloads, they get fresh keys; clients detect the new public key and re-derive automatically.

## Limits (by design, for now)

- No message history: messages exist only in open tabs; nothing is stored anywhere.
- Online-only delivery: you can only message people currently connected.
- Trust-on-first-use key exchange: verify safety codes out of band for strong MITM resistance.
- Presence/typing metadata (names, timestamps) is visible to the relay; message content is not.

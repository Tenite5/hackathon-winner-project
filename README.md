# CoTab: browse together, not in turns

CoTab is a Chrome extension for browsing in shared rooms. Everyone keeps working in their own tabs and picks which ones to share. Shared tabs show up for the room as the **real, live page**, not a blurry screen share: the same HTML and CSS, sharp at any size. You can switch between tabs instantly, invite people over to what you're looking at, and hand over control with permission. Tabs you don't share stay completely private.

## What you get

- **Rooms with invite links.** Start a room and send the link. No accounts: you just pick a name.
- **The exact page, live.** Shared tabs are mirrored element by element, so text stays sharp and hover effects respond instantly. A click shows its result after one network round trip. In testing that was about 10 ms on one machine and 20–170 ms over the internet tunnel. For videos, games and canvas apps there's a **Video** view with sound.
- **Share any tab.** Use the CoTab icon on the tab, the **Share a tab** picker in the room, or just type a website into the room and it opens for everyone.
- **Watch, switch, follow.** Focus one tab with the others below, or see all of them at once. **Follow** someone to jump to whichever shared tab they're on.
- **Take control, with permission.** Click **Ask to control** and the owner sees an Allow / Not now prompt. You can then click, type, paste, scroll, go back and forward, or type a URL. Everyone sees everyone's cursor, with names.
- **Private by default.** Only the tabs you share are visible, and people browsing elsewhere show as *Browsing privately*. Password fields are masked in the mirror.
- **AI helpers.** Ask an AI to do something on any tab, like the Claude or ChatGPT extensions. Run several at once, watch each one in the side panel, and reply to steer it. Helpers on a shared tab need the owner's control permission.
- **Narrow windows.** Under 1000px wide the sidebar becomes a drawer behind the menu button, so the shared tab keeps its full size.

## Quick start (about 5 minutes)

**1. Start the room server** (Node 18+)

```bash
cd server
npm install
npm start
```

On Windows, allow Node through the firewall when asked (private networks), so other devices can reach it.

**2. Load the extension**

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and select the `extension/` folder.
3. Pin **CoTab** from the puzzle-piece menu.

**3. Use it**

1. Click the CoTab icon, then **Start a new room**.
2. Click **Copy invite** and send the link. The other person opens it and clicks **Join room**.
3. Share a tab: click the CoTab icon on any website and hit **Share this tab**.

## Using it across devices and networks

| Who's joining | What to do |
| --- | --- |
| **Same computer** (two Chrome profiles) | Nothing extra. |
| **Same Wi-Fi / network** | Nothing extra. `npm start` makes invite links use your network address, like `http://192.168.1.23:8787/r/CODE`. The popup shows *Works on your Wi-Fi*. |
| **Anywhere on the internet** | Run `npm run online` instead of `npm start`. It opens a free Cloudflare tunnel (no account needed) and invite links become `https://…trycloudflare.com/r/CODE`. The popup shows *Works from anywhere*. |

Whoever runs the server keeps their extension on the default `ws://localhost:8787`. Everyone else connects through the invite link, which sets their server automatically. The tunnel address changes each time you run `npm run online`, so copy a fresh invite after restarting it.

## Page view vs Video view

| | **Page** (default) | **Video** |
| --- | --- | --- |
| What you see | The real page, rebuilt from its HTML and CSS | A video stream of the tab, with sound |
| Sharpness | Perfect at any size | Good, but compressed |
| Speed | Instant hover; clicks take one round trip | Frame delay on everything |
| Works through | The room server (any network) | Peer-to-peer WebRTC (some networks block it) |
| Best for | Docs, shopping, dashboards, articles, forms | YouTube, games, Figma, Google Maps and other canvas apps |
| Needs | Nothing | Sharing from the tab itself (CoTab icon, `Alt+Shift+S` or right-click) |

If a tab has a video feed, CoTab switches it to Video automatically when a video starts playing. You can flip between the two views any time from the stage header.

If peer-to-peer video is blocked on a network, start the server with a TURN relay:

```bash
TURN_URL=turn:your.turn.host:3478 TURN_USERNAME=user TURN_CREDENTIAL=pass npm run online
```

## A 2-minute demo script

1. **Alice** runs `npm run online`, starts a room and sends the invite. **Bob** opens it on his laptop and clicks *Join room*.
2. In the room, Alice types `github.com` into the box. It opens on her side and Bob instantly sees the real page.
3. Alice keeps browsing other tabs. Bob still sees the shared one live, and Alice shows as *On "GitHub"* or *Browsing privately*.
4. Bob hovers links (instant) and clicks **Ask to control**. Alice clicks **Allow**, and Bob clicks, types and scrolls in her tab while she watches his named cursor.
5. Alice opens YouTube, clicks the CoTab icon and then **Share it and ask everyone to look**. Bob gets the nudge, hits *Watch live*, and it switches to Video with sound.
6. Bob clicks **Follow** next to Alice. Whatever shared tab she switches to, his view follows.

## Keyboard shortcuts

| Where | Keys | Action |
| --- | --- | --- |
| Any tab | `Alt+Shift+S` | Share / stop sharing this tab |
| Any tab | `Alt+Shift+F` | Ask everyone to look at this tab |
| Any tab | `Alt+Shift+A` | Open AI helpers in the side panel |
| Room view | `1`–`9` | Jump to a shared tab |
| Room view | `G` | Toggle Focus / All tabs |
| Room view | `F` | Fullscreen |

## AI helpers

1. Open the side panel with `Alt+Shift+A`, or click **Ask AI** in the popup or room.
2. Open the settings (sliders icon) and paste an [OpenRouter](https://openrouter.ai/keys) key. It's saved in your browser only and never sent to the room server.
3. Pick the tab to work on, type what you want, and press Enter.

Pick a speed in the settings: **Fastest**, **Balanced** or **Most careful**. You can also point the endpoint at any OpenAI-compatible service.

**Where helpers can go**

| Helper works on | Can open other tabs? | Can message other helpers? |
| --- | --- | --- |
| A tab in your own browser | Yes, when a job needs another site. It opens in the background and the card lists its tabs. | Yes |
| A tab someone shared with you in the room | No. It stays on that tab, and the owner's control permission covers only that tab. | Yes, with helpers in your browser |

The composer always shows which rule applies to the tab you picked, and each helper card says it too.

- Each helper gets its own card with a live step list, a Stop button and a reply box for follow-up instructions.
- Helpers read the page, then click, type, scroll and navigate. A glowing frame and a Stop pill show on the page while they work.
- Game boards work too. On chess.com a helper sees the board as one entry listing the pieces by square, and moves them by clicking squares like `e2` then `e4`.
- Helpers never pay, send, post or delete unless you explicitly asked for it, and they stop to ask you at logins, payments and captchas.
- A helper on someone else's shared tab only works once that person has given you control, and it runs in their browser.
- **Tabs of their own.** A helper can open a second site in a background tab, switch between its tabs, and close the ones it opened. Its tabs are labelled T1, T2 and so on.
- **Teamwork.** Helpers in your browser message each other by name. A helper can start another for a separate part of the job, on your tab or a new one, and its report comes back as a message. Two helpers can share a tab: their actions take turns, so clicks never interleave. Stopping a helper also stops the ones it started.
- Up to 6 helpers can run at once.

## How it works

```
 Alice's Chrome (owner)                                        Bob's Chrome (viewer)
 ┌──────────────────────────────────────┐                     ┌─────────────────────────────────────┐
 │ shared tab                            │                     │ room page                           │
 │  └ recorder.js (rrweb) streams DOM ───┼──► room server ─────┼──► rrweb replayer = the real page    │
 │    changes and replays remote input ◄─┼─── (WebSocket) ◄────┼─── clicks / keys / scroll / cursor   │
 │  └ content.js: Live badge, cursors,   │                     │                                     │
 │    permission prompts                 │   optional video:   │                                     │
 │ offscreen.js: tabCapture ═════════════╪═ WebRTC P2P ════════╪══► <video> (Video view)              │
 └──────────────────────────────────────┘                     └─────────────────────────────────────┘
```

- **`server/server.js`** is a small Node + `ws` server. It keeps rooms in memory and relays page changes, cursors, control events and WebRTC signaling. It also serves the invite pages. **`server/online.js`** adds the Cloudflare tunnel.
- **`extension/recorder.js`** runs inside the shared page. It uses [rrweb](https://github.com/rrweb-io/rrweb) to stream the DOM, reports your pointer, and replays remote input on the exact element the viewer clicked.
- **`extension/room.js`** rebuilds each shared tab with rrweb's replayer, applying every change the moment it arrives. It handles hover locally and sends input back.
- **`extension/background.js`** is the service worker and the hub. It owns the room connection, sharing, permissions (it drops control events unless you allowed them), invites and notifications.
- **`extension/offscreen.js`** captures tabs for the Video view and streams them over WebRTC.
- **`extension/popup.*`** and **`extension/room.*`** are the UI.

## Known limits (it's an MVP)

- Chrome (or another Chromium browser) 116+ only.
- **Page view** loads images and fonts from the original site. Pages on the owner's own computer (`localhost`), private intranets or some logged-in images may show gaps for viewers; switch to **Video** for those. Canvas-based apps (Figma, Google Maps, games) also need Video.
- **Video view** only works when the tab was shared from the tab itself, because Chrome requires that click.
- Remote control uses synthetic events. Links, buttons, forms, text fields, rich text and scrolling work on most sites. Native `<select>` menus, cross-origin iframes and canvas apps won't respond.
- Rooms live in server memory. If the server restarts, everyone's extension reconnects and recreates the room automatically.
- No authentication: anyone with the link can join. That's fine for a demo.

## Next ideas

Voice chat, drawing annotations over shared tabs, and rewinding a tab's recent history. The page recording format already makes rewind straightforward.

---

Includes rrweb 2.1.7 (MIT), see `extension/vendor/LICENSE-rrweb.txt`. Icons adapted from Lucide (ISC).

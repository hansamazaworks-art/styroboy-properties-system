# Styroboy Properties Operations Console — Electron + LAN edition

This packages your operations console as a desktop app and turns it into a
small shared, multi-device tool: one computer on your network runs the app
and holds the data; every other computer, tablet, or phone on the same
network opens it in a web browser and sees (and edits) the same books.

## How it's wired

- The console's own HTML/JS/CSS (`app/index.html`) is unchanged in behavior
  — only its **save/load layer** was rewired. It used to read and write
  `localStorage` (data trapped on one browser, one machine). It now talks to
  a small local server over HTTP instead.
- `server.js` is that server — plain Node, no framework, no external
  dependencies. It serves the app and exposes a tiny JSON API
  (`/api/state`, `/api/version`) backed by one file on disk
  (`store.json`, inside Electron's per-user app-data folder).
- `main.js` is the Electron shell: it starts `server.js` in-process, opens a
  window pointed at `http://localhost:<port>`, and shows you this
  computer's LAN address, and it's shown again any time from
  **Settings → Show LAN address**.
- Other devices don't need Electron or any install at all — they just open
  that LAN address (e.g. `http://192.168.1.23:8843`) in Chrome, Safari,
  Edge, or a phone browser.
- A small dot in the top bar (next to the clock) shows sync status:
  green = synced, amber = saving, red = offline (changes are cached on that
  device and retried automatically once the network is back).

## Running it in development

```bash
npm install
npm start
```

This launches the Electron window. On first launch it also pops up a
dialog with the address to give other devices — you can reopen that any
time from **Styroboy Properties → Show LAN Address…**.

If you'd rather run *only* the server (e.g. on a small always-on machine,
with everyone — including that machine's own operator — just using a
browser, no Electron window at all):

```bash
npm run server
```

## Building an installer

```bash
npm run dist
```

This uses `electron-builder` to produce a Windows/macOS/Linux installer in
`dist/`, matching whatever platform you build on (cross-building to a
different OS needs that OS's build tools — see the electron-builder docs
if you need that). For a quick unpacked build to test without installing:

```bash
npm run dist:dir
```

## Where the data lives

- The shared data file lives in Electron's standard per-user app-data
  folder on the **host machine only** (the one running the Electron app,
  or the one running `npm run server`):
  - Windows: `%APPDATA%\Styroboy Properties Operations Console\data\store.json`
  - macOS: `~/Library/Application Support/Styroboy Properties Operations Console/data/store.json`
  - Linux: `~/.config/Styroboy Properties Operations Console/data/store.json`
  - Running via `npm run server` directly (no Electron): `./data/store.json`
    next to `server.js`.
- Every other device's browser keeps **no permanent copy** — it's just
  viewing the host's data over the network.
- The Electron window itself also keeps a local fallback cache
  (`localStorage`) so it can still open and show its last-known data if
  the network briefly drops. That cache is never the source of truth once
  the connection returns.
- **Back up `store.json`** the way you'd back up any single file that
  matters — or just use the in-app **Settings → Your data → Export
  backup** button, which downloads a full JSON snapshot regardless of
  which device you're on.

## Network requirements

- The host machine and every other device need to be on the **same LAN**
  (same Wi-Fi network / same office network). This is plain HTTP over your
  local network — it is not exposed to the internet, and nothing here adds
  encryption or a login. Don't port-forward this onto the public internet
  as-is.
- The host machine's firewall needs to allow inbound connections on the
  app's port (default **8843**). On first run, Windows/macOS will usually
  prompt you to allow this — say yes. If another program is already using
  that port, the app automatically tries the next one up and shows you
  the actual port it picked.
- The host computer needs to stay powered on and the app (or `npm run
  server`) needs to keep running for other devices to stay in sync.

## A limitation worth knowing

Conflicting saves are **merged automatically**, record by record and field by
field — not "last save wins" for the whole document. If two people edit
different tenants, or even different fields on the same tenant, at the same
time, both changes land; nobody has to redo anything or gets a disruptive
reload. The only time a pick has to be made is a true collision — the same
field, on the same record, changed to two different values before either
device had seen the other's edit. That's rare, and even then nothing is
silently lost: the app keeps whichever value was already saved to the
server first, logs it as a quiet toast ("merged — one field needed a
pick"), and both edits still exist in your export/backup history if you
ever need to check. Deletions are handled the same safe way: if one device
deletes a record while another device was mid-edit on it, the edit wins
over the deletion, so you never lose a change to something that got
deleted out from under you.

The screen itself doesn't yank itself out from under you either — while
you have a form open or are typing in a field, incoming changes merge into
memory quietly in the background and only repaint the screen once you're
not mid-edit (closing the form, or your own next save, catches it up).

## Files in this project

```
styroboy-properties-electron/
├── app/
│   └── index.html      # the console itself (network-synced save/load)
├── main.js              # Electron entry point — starts server, opens window
├── preload.js            # (minimal; no privileged APIs are needed)
├── server.js             # static file server + JSON API + file storage
├── package.json
└── README.md
```

/*
 * Styroboy Properties Operations Console — LAN server
 * ------------------------------------------------------------------
 * Serves the app (app/index.html) as a static page and exposes a tiny
 * JSON API that persists the shared data to a single file on disk
 * (data/store.json). Every device on the LAN — the host machine's own
 * Electron window included — talks to this same server, so everyone
 * sees the same books.
 *
 * Deliberately built on Node's built-in http/fs modules only, so
 * running the host app never depends on any third-party package.
 *
 * API:
 *   GET  /api/state    -> { version, state }        (state is null on first run)
 *   PUT  /api/state     body { version, state }
 *                        -> 200 { version }                on success
 *                        -> 409 { version, state }          if someone else
 *                           saved since your last read — your caller should
 *                           reload the returned state instead of overwriting it
 *   GET  /api/version  -> { version }                 (cheap poll target)
 *
 * Concurrency model: this app keeps one full JSON document as its data
 * (that's how the original browser-only version worked, via
 * localStorage). Optimistic locking on /api/state prevents two
 * simultaneous saves from silently clobbering each other — the loser
 * gets the winner's data back and the app tells the person to redo
 * their last change. This is a deliberate, honest limitation for a
 * small internal tool, not a full multi-writer database.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APP_DIR = path.join(__dirname, 'app');
const MAX_BODY_BYTES = 64 * 1024 * 1024; // 64 MB — generous headroom for meter photos

/* The data directory is configurable because a packaged Electron app
 * runs its own files from a read-only asar archive — the shared data
 * file can't live next to server.js there. Electron's main.js passes
 * app.getPath('userData') instead. Plain `node server.js` (no
 * Electron) falls back to ./data next to this file. */
let DATA_DIR = path.join(__dirname, 'data');
let STORE_FILE = path.join(DATA_DIR, 'store.json');

function setDataDir(dir){
  DATA_DIR = dir;
  STORE_FILE = path.join(DATA_DIR, 'store.json');
}

function ensureDataFile(){
  if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if(!fs.existsSync(STORE_FILE)){
    fs.writeFileSync(STORE_FILE, JSON.stringify({ version: 0, state: null }, null, 2));
  }
}

function readStore(){
  try{
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if(typeof parsed.version !== 'number') parsed.version = 0;
    return parsed;
  }catch(e){
    return { version: 0, state: null };
  }
}

/* Atomic write: write to a temp file in the same directory, then
   rename over the target. Rename is atomic on the same filesystem, so
   a crash mid-write can never leave store.json half-written. */
function writeStore(doc){
  const tmp = STORE_FILE + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(doc));
  fs.renameSync(tmp, STORE_FILE);
}

/* A single in-process write queue keeps concurrent PUTs from
   interleaving their read-modify-write of store.json. */
let writeChain = Promise.resolve();
function withWriteLock(fn){
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => {});
  return run;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function sendJSON(res, status, obj){
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendFile(res, filePath){
  fs.readFile(filePath, (err, data) => {
    if(err){ sendJSON(res, 404, { error: 'not found' }); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}

function readBody(req){
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', d => {
      size += d.length;
      if(size > MAX_BODY_BYTES){ reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function handleApi(req, res, urlPath){
  if(urlPath === '/api/version' && req.method === 'GET'){
    const doc = readStore();
    sendJSON(res, 200, { version: doc.version });
    return true;
  }
  if(urlPath === '/api/state' && req.method === 'GET'){
    const doc = readStore();
    sendJSON(res, 200, doc);
    return true;
  }
  if(urlPath === '/api/state' && req.method === 'PUT'){
    withWriteLock(async () => {
      let payload;
      try{
        const raw = await readBody(req);
        payload = JSON.parse(raw.toString('utf8'));
      }catch(e){
        sendJSON(res, 400, { error: 'invalid JSON body' });
        return;
      }
      const current = readStore();
      const clientVersion = Number(payload.version) || 0;
      if(clientVersion !== current.version){
        sendJSON(res, 409, current);
        return;
      }
      const next = { version: current.version + 1, state: payload.state };
      writeStore(next);
      sendJSON(res, 200, { version: next.version });
    }).catch(() => { try{ sendJSON(res, 500, { error: 'save failed' }); }catch(e){} });
    return true;
  }
  return false;
}

function resolveStaticPath(urlPath){
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = rel.split('?')[0];
  const full = path.normalize(path.join(APP_DIR, rel));
  if(!full.startsWith(APP_DIR)) return null; // block path traversal
  return full;
}

function createServer(){
  ensureDataFile();
  return http.createServer((req, res) => {
    const urlPath = decodeURI((req.url || '/').split('?')[0]);
    if(urlPath.startsWith('/api/')){
      if(handleApi(req, res, urlPath)) return;
      sendJSON(res, 404, { error: 'unknown API route' });
      return;
    }
    const full = resolveStaticPath(urlPath);
    if(!full){ sendJSON(res, 400, { error: 'bad path' }); return; }
    fs.stat(full, (err, st) => {
      if(err || !st.isFile()){ sendFile(res, path.join(APP_DIR, 'index.html')); return; }
      sendFile(res, full);
    });
  });
}

function start(port, dataDir){
  if(dataDir) setDataDir(dataDir);
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(port, '0.0.0.0', () => resolve(server));
  });
}

module.exports = { start, createServer, setDataDir };

/* Allow `node server.js` directly (no Electron) for headless/server-only
   use, e.g. running this on a small always-on machine on the network
   while everyone else, including the "host", just uses a browser. */
if(require.main === module){
  const PORT = Number(process.env.PORT) || 8843;
  start(PORT).then(() => {
    console.log('Styroboy Properties Operations Console running at http://localhost:' + PORT);
    console.log('On the same network, other devices can use this machine\'s LAN IP instead of localhost.');
  }).catch(err => {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  });
}

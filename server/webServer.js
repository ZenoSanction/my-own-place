/*  My Own Place — Web Server (Express)
    • Serves static files from the user's wwwRoot directory
    • Password-protects via a session cookie (PBKDF2, no native modules)
    • Logs every request to the CSV access log
    • Returns a clean login page matching the app's dark theme
*/

const express     = require('express');
const http        = require('http');
const path        = require('path');
const fs          = require('fs');
const crypto      = require('crypto');
const cookie      = require('cookie');
const mime        = require('mime-types');
const { appendLog } = require('./logger');

// In-memory session store  { token -> { created } }
const sessions = new Map();
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

function newToken () { return crypto.randomBytes(32).toString('hex'); }
function pruneOldSessions () {
  const now = Date.now();
  for (const [t, s] of sessions)
    if (now - s.created > SESSION_TTL_MS) sessions.delete(t);
}
setInterval(pruneOldSessions, 15 * 60 * 1000);

function verifyPBKDF2 (pw, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const a = crypto.pbkdf2Sync(pw, salt, 100000, 64, 'sha512');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ── Brute-force protection ────────────────────────────────────────────────────
const loginAttempts = new Map(); // ip → { count, resetAt }
const MAX_ATTEMPTS  = 10;
const LOCKOUT_MS    = 15 * 60 * 1000; // 15 minutes

function checkRateLimit (ip) {
  const now = Date.now();
  let rec   = loginAttempts.get(ip);
  if (!rec || now > rec.resetAt) { rec = { count: 0, resetAt: now + LOCKOUT_MS }; }
  return rec;
}
function recordFailedLogin (ip) {
  const rec = checkRateLimit(ip);
  rec.count++;
  loginAttempts.set(ip, rec);
}
function clearLoginAttempts (ip) { loginAttempts.delete(ip); }

// ── Login page HTML ───────────────────────────────────────────────────────────
function loginPage (serverName, error = '', showUsername = false) {
  const inputStyle = 'width:100%;padding:.75rem 1rem;background:#0d1117;border:1px solid #30363d;' +
                     'border-radius:8px;color:#c9d1d9;font-size:1rem;outline:none;transition:.2s';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(serverName)} — Login</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0d1117;color:#c9d1d9;font-family:'Segoe UI',system-ui,sans-serif;
       display:flex;align-items:center;justify-content:center;min-height:100vh}
  .card{background:#161b22;border:1px solid #30363d;border-radius:12px;
        padding:2.5rem 2rem;width:100%;max-width:380px;box-shadow:0 8px 32px #00000066}
  .logo{text-align:center;margin-bottom:1.8rem}
  .logo h1{font-size:1.6rem;background:linear-gradient(135deg,#58a6ff,#bf91f3);
            -webkit-background-clip:text;-webkit-text-fill-color:transparent}
  .logo p{color:#8b949e;font-size:.85rem;margin-top:.3rem}
  .fg{margin-bottom:1rem}
  label{display:block;font-size:.8rem;color:#8b949e;margin-bottom:.4rem;
        letter-spacing:.05em;text-transform:uppercase}
  input{${inputStyle}}
  input:focus{border-color:#58a6ff;box-shadow:0 0 0 3px #58a6ff22}
  button{width:100%;padding:.8rem;margin-top:.5rem;
         background:linear-gradient(135deg,#58a6ff,#4078c8);
         border:none;border-radius:8px;color:#fff;font-size:1rem;font-weight:600;
         cursor:pointer;transition:.2s;letter-spacing:.03em}
  button:hover{opacity:.9;transform:translateY(-1px)}
  .err{background:#f8514922;border:1px solid #f85149;border-radius:8px;
       padding:.6rem .9rem;color:#f85149;font-size:.85rem;margin-bottom:1rem;text-align:center}
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <h1>${escHtml(serverName)}</h1>
    <p>${showUsername ? 'Sign in to continue' : 'Enter the password to continue'}</p>
  </div>
  ${error ? `<div class="err">${escHtml(error)}</div>` : ''}
  <form method="POST" action="/__login">
    ${showUsername ? `
    <div class="fg">
      <label for="usr">Username</label>
      <input type="text" id="usr" name="username" autofocus autocomplete="username">
    </div>
    <div class="fg">
      <label for="pw">Password</label>
      <input type="password" id="pw" name="password" autocomplete="current-password">
    </div>` : `
    <div class="fg">
      <label for="pw">Password</label>
      <input type="password" id="pw" name="password" autofocus autocomplete="current-password">
    </div>`}
    <button type="submit">Sign In</button>
  </form>
</div>
</body>
</html>`;
}

function escHtml (s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                  .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── Serve a single file with Range support ────────────────────────────────────
function serveFile (res, filePath, stat, logEntry, logPath) {
  const mimeType = mime.lookup(filePath) || 'application/octet-stream';
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Last-Modified', stat.mtime.toUTCString());
  res.setHeader('Cache-Control', 'no-cache');

  const stream = fs.createReadStream(filePath);
  let bytes = 0;
  stream.on('data', c => bytes += c.length);
  stream.on('end', () => { logEntry.bytes = bytes; appendLog(logPath, logEntry); });
  stream.on('error', () => { res.destroy(); });
  stream.pipe(res);
}

// ── Main factory ──────────────────────────────────────────────────────────────
async function createWebServer (config, logPath) {
  const app = express();
  const { webPort, wwwRoot, serverName } = config;

  // Read auth config fresh on every login so users/password added after server
  // start are picked up immediately without a restart.
  const configFile = path.join(path.dirname(logPath), 'config.json');
  function getAuthConfig () {
    try   { return JSON.parse(fs.readFileSync(configFile, 'utf8')); }
    catch (_) { return config; }
  }

  app.disable('x-powered-by');
  app.use(express.urlencoded({ extended: false }));

  // ── Auth middleware ───────────────────────────────────────────────────────
  function isAuthenticated (req) {
    const ac = getAuthConfig();
    if (!ac.enablePasswordProtection) return true;
    const hasUsers = ac.users && ac.users.length > 0;
    if (!hasUsers && !ac.password) return true;   // no credentials configured
    const cookies = cookie.parse(req.headers.cookie || '');
    return sessions.has(cookies.__mop_session);
  }

  // ── Login GET (show form) ─────────────────────────────────────────────────
  app.get('/__login', (req, res) => {
    const ac       = getAuthConfig();
    const hasUsers = !!(ac.users && ac.users.length > 0);
    res.send(loginPage(serverName, '', hasUsers));
  });

  // ── Login POST ────────────────────────────────────────────────────────────
  app.post('/__login', (req, res) => {
    const ip  = req.socket.remoteAddress || '?';
    const ua  = req.headers['user-agent'] || '';
    const rec = checkRateLimit(ip);
    if (rec.count >= MAX_ATTEMPTS) {
      appendLog(logPath, { ip, type:'WEB', method:'POST', reqPath:'/__login',
                           status:429, userAgent: ua, bytes:0 });
      return res.status(429).send(loginPage(serverName,
        'Too many failed attempts — try again in 15 minutes.'));
    }

    const ac       = getAuthConfig();
    const hasUsers = !!(ac.users && ac.users.length > 0);
    let   authed   = false;

    if (hasUsers) {
      // Multi-user mode: check username + password against the users array
      const uname = (req.body.username || '').trim();
      const pw    = req.body.password  || '';
      const user  = ac.users.find(u => u.enabled && u.username === uname);
      if (user && verifyPBKDF2(pw, user.password)) authed = true;
    } else {
      // Legacy single-password mode
      if (verifyPBKDF2(req.body.password, ac.password)) authed = true;
    }

    if (authed) {
      clearLoginAttempts(ip);
      const token = newToken();
      sessions.set(token, { created: Date.now() });
      res.setHeader('Set-Cookie',
        `__mop_session=${token}; Path=/; HttpOnly; SameSite=Strict`);
      appendLog(logPath, { ip, type:'WEB', method:'POST', reqPath:'/__login',
                           status:302, userAgent: ua, bytes:0 });
      return res.redirect(302, req.query.next || '/');
    }

    recordFailedLogin(ip);
    appendLog(logPath, { ip, type:'WEB', method:'POST', reqPath:'/__login',
                         status:401, userAgent: ua, bytes:0 });
    res.status(401).send(loginPage(serverName,
      hasUsers ? 'Incorrect username or password.' : 'Incorrect password — please try again.',
      hasUsers));
  });

  // ── Logout ────────────────────────────────────────────────────────────────
  app.get('/__logout', (req, res) => {
    const cookies = cookie.parse(req.headers.cookie || '');
    sessions.delete(cookies.__mop_session);
    res.setHeader('Set-Cookie', '__mop_session=; Path=/; Max-Age=0; HttpOnly');
    res.redirect(302, '/');
  });

  // ── API: guestbook ────────────────────────────────────────────────────────
  const guestbookFile = path.join(path.dirname(logPath), 'guestbook.json');
  const gbPostCooldown = new Map();  // ip → last-post timestamp

  function loadGuestbook () {
    try {
      if (fs.existsSync(guestbookFile))
        return JSON.parse(fs.readFileSync(guestbookFile, 'utf8'));
    } catch (_) {}
    return [];
  }
  function saveGuestbook (msgs) {
    try { fs.writeFileSync(guestbookFile, JSON.stringify(msgs, null, 2)); } catch (_) {}
  }

  // GET — public: return messages without stored IPs
  app.get('/__api/guestbook', (req, res) => {
    const msgs = loadGuestbook().map(m => ({
      id: m.id, name: m.name, message: m.message, timestamp: m.timestamp,
    }));
    res.json({ messages: msgs });
  });

  // POST — public (rate-limited to 1 per minute per IP)
  app.post('/__api/guestbook', express.json(), (req, res) => {
    const ip  = req.socket.remoteAddress || '?';
    const now = Date.now();
    const last = gbPostCooldown.get(ip) || 0;
    if (now - last < 60000)
      return res.status(429).json({ error: 'Please wait a minute before posting again.' });

    const { name, message } = req.body || {};
    if (!name || !message)
      return res.status(400).json({ error: 'Name and message are required.' });
    if (String(name).length > 50 || String(message).length > 500)
      return res.status(400).json({ error: 'Name or message too long.' });

    const entry = {
      id:        crypto.randomBytes(8).toString('hex'),
      name:      String(name).trim().slice(0, 50),
      message:   String(message).trim().slice(0, 500),
      timestamp: new Date().toISOString(),
      ip,
    };
    const msgs = loadGuestbook();
    msgs.push(entry);
    saveGuestbook(msgs);
    gbPostCooldown.set(ip, now);
    appendLog(logPath, { ip, type: 'WEB', method: 'POST', reqPath: '/__api/guestbook',
                         status: 201, userAgent: req.headers['user-agent'] || '', bytes: 0 });
    res.status(201).json({ success: true });
  });

  // DELETE — requires session auth
  app.delete('/__api/guestbook/:id', (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
    const msgs = loadGuestbook().filter(m => m.id !== req.params.id);
    saveGuestbook(msgs);
    res.json({ success: true });
  });

  // ── API: photos listing (used by gallery page) ───────────────────────────
  app.get('/__api/photos', (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
    const photosDir = path.join(wwwRoot, 'photos');
    const imageExts = new Set(['.jpg','.jpeg','.png','.gif','.webp','.avif','.bmp','.svg']);
    try {
      if (!fs.existsSync(photosDir)) return res.json({ photos: [] });
      const photos = fs.readdirSync(photosDir)
        .filter(name => imageExts.has(path.extname(name).toLowerCase()))
        .map(name => {
          const fp = path.join(photosDir, name);
          const stat = fs.statSync(fp);
          return { name, url: `/photos/${name}`, size: stat.size };
        });
      res.json({ photos });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── API: file listing (used by fileshare template) ────────────────────────
  app.get('/__api/files', (req, res) => {
    if (!isAuthenticated(req))
      return res.status(401).json({ error: 'Unauthorized' });
    try {
      function walk (dir, base = '') {
        return fs.readdirSync(dir).flatMap(name => {
          const fp   = path.join(dir, name);
          const rel  = base ? `${base}/${name}` : name;
          const stat = fs.statSync(fp);
          if (stat.isDirectory()) return walk(fp, rel);
          return [{ name, path: rel, size: stat.size, modified: stat.mtime.toISOString() }];
        });
      }
      res.json({ files: walk(wwwRoot) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Public share-link downloads ──────────────────────────────────────────
  // Must be registered BEFORE the auth middleware so they work even when
  // password protection is enabled.
  const sharesFile = path.join(path.dirname(logPath), 'shares.json');

  function getValidShare (token) {
    try {
      if (!fs.existsSync(sharesFile)) return null;
      const list = JSON.parse(fs.readFileSync(sharesFile, 'utf8'));
      const s    = list.find(x => x.token === token);
      if (!s) return null;
      if (s.expires && Date.now() > s.expires) return null;
      return s;
    } catch (_) { return null; }
  }

  app.get('/__share/:token', (req, res) => {
    const { token } = req.params;
    const ip = req.socket.remoteAddress || '?';
    const ua = req.headers['user-agent'] || '';

    // Reject tokens that don't look like our 40-char hex strings
    if (!/^[a-f0-9]{40}$/.test(token)) {
      return res.status(404).send(page404(serverName));
    }

    const share = getValidShare(token);
    if (!share) {
      appendLog(logPath, { ip, type: 'WEB', method: 'GET',
                           reqPath: `/__share/${token}`, status: 404, userAgent: ua, bytes: 0 });
      return res.status(404).send(page404(serverName));
    }

    const filePath = path.resolve(wwwRoot, share.filePath);

    // Path traversal guard
    if (!filePath.startsWith(path.resolve(wwwRoot))) {
      return res.status(403).send('Forbidden');
    }

    if (!fs.existsSync(filePath)) {
      appendLog(logPath, { ip, type: 'WEB', method: 'GET',
                           reqPath: `/__share/${token}`, status: 404, userAgent: ua, bytes: 0 });
      return res.status(404).send(page404(serverName));
    }

    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      return res.status(400).send('Directories cannot be shared as a download link.');
    }

    // Force download with the original filename
    res.setHeader('Content-Disposition',
      `attachment; filename="${path.basename(share.filePath)}"`);

    const logEntry = { ip, type: 'WEB', method: 'GET',
                       reqPath: `/__share/${token}`, status: 200, userAgent: ua, bytes: 0 };
    serveFile(res, filePath, stat, logEntry, logPath);
  });

  // ── Auth gate for all other routes ────────────────────────────────────────
  app.use((req, res, next) => {
    if (!isAuthenticated(req)) {
      const ac       = getAuthConfig();
      const hasUsers = !!(ac.users && ac.users.length > 0);
      if (req.method === 'GET')
        return res.redirect(302, `/__login?next=${encodeURIComponent(req.path)}`);
      return res.status(401).send(loginPage(serverName,
        'Session expired — please log in again.', hasUsers));
    }
    next();
  });

  // ── Static file handler ───────────────────────────────────────────────────
  app.use((req, res) => {
    const ip        = req.socket.remoteAddress || '?';
    const ua        = req.headers['user-agent'] || '';
    const reqPath   = decodeURIComponent(req.path);
    const filePath  = path.resolve(wwwRoot, '.' + reqPath);

    // Path traversal guard
    if (!filePath.startsWith(path.resolve(wwwRoot))) {
      appendLog(logPath, { ip, type:'WEB', method: req.method, reqPath,
                           status:403, userAgent: ua, bytes:0 });
      return res.status(403).send('Forbidden');
    }

    let target = filePath;

    if (!fs.existsSync(target)) {
      appendLog(logPath, { ip, type:'WEB', method: req.method, reqPath,
                           status:404, userAgent: ua, bytes:0 });
      return res.status(404).send(page404(serverName));
    }

    const stat = fs.statSync(target);

    // Directory → try index.html
    if (stat.isDirectory()) {
      const idx = path.join(target, 'index.html');
      if (fs.existsSync(idx)) {
        target = idx;
      } else {
        // Auto directory listing
        return res.send(dirListing(reqPath, target, wwwRoot, serverName));
      }
    }

    const fileStat = fs.statSync(target);
    const logEntry = { ip, type:'WEB', method: req.method,
                       reqPath, status:200, userAgent: ua, bytes:0 };
    serveFile(res, target, fileStat, logEntry, logPath);
  });

  // ── Start listening ───────────────────────────────────────────────────────
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.listen(webPort, '0.0.0.0', resolve);
    server.once('error', reject);
  });

  return {
    stop: () => new Promise(r => server.close(r))
  };
}

// ── 404 page ──────────────────────────────────────────────────────────────────
function page404 (serverName) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>404 — ${escHtml(serverName)}</title>
<style>body{background:#0d1117;color:#c9d1d9;font-family:'Segoe UI',system-ui,sans-serif;
display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center}
h1{font-size:5rem;color:#30363d}p{color:#8b949e}a{color:#58a6ff}</style></head>
<body><div><h1>404</h1><p>This file doesn't exist on ${escHtml(serverName)}.</p>
<p><a href="/">← Go home</a></p></div></body></html>`;
}

// ── Directory listing ─────────────────────────────────────────────────────────
function dirListing (reqPath, dirAbs, wwwRoot, serverName) {
  const items = fs.readdirSync(dirAbs).map(name => {
    const fp   = path.join(dirAbs, name);
    const stat = fs.statSync(fp);
    const href = (reqPath.endsWith('/') ? reqPath : reqPath + '/') + name;
    const icon = stat.isDirectory() ? '📁' : '📄';
    const size = stat.isDirectory() ? '—' : fmtBytes(stat.size);
    return `<tr><td>${icon} <a href="${escHtml(href)}">${escHtml(name)}</a></td>
            <td>${size}</td><td>${stat.mtime.toLocaleDateString()}</td></tr>`;
  }).join('');

  const parent = reqPath !== '/' ? `<a href="${escHtml(path.dirname(reqPath))}">⬆ Parent directory</a>` : '';

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>${escHtml(reqPath)} — ${escHtml(serverName)}</title>
<style>body{background:#0d1117;color:#c9d1d9;font-family:'Segoe UI',system-ui,sans-serif;
padding:2rem;max-width:900px;margin:auto}
h1{color:#58a6ff;margin-bottom:.5rem}a{color:#58a6ff;text-decoration:none}a:hover{text-decoration:underline}
table{width:100%;border-collapse:collapse;margin-top:1rem}
th,td{padding:.6rem .8rem;text-align:left;border-bottom:1px solid #21262d}
th{color:#8b949e;font-size:.8rem;text-transform:uppercase;letter-spacing:.05em}
</style></head>
<body>
<h1>Index of ${escHtml(reqPath)}</h1>
${parent}
<table><thead><tr><th>Name</th><th>Size</th><th>Date</th></tr></thead>
<tbody>${items}</tbody></table>
</body></html>`;
}

function fmtBytes (b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
  return (b/1048576).toFixed(1) + ' MB';
}

module.exports = { createWebServer };

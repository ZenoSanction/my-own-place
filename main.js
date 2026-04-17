/*  My Own Place — Electron Main Process  v1.1
    ─────────────────────────────────────────────
    Changes from v1.0:
    • Lazy path helpers: app.getPath() is now only called inside functions,
      never at module load time.  Avoids a subtle race on some Windows builds
      where the userData path isn't settled before app.whenReady() fires.
    • Added 'ping' IPC handler so the renderer can verify the channel works
      before trying anything meaningful.
    • Debug log written to %TEMP%\myownplace-debug.log at every key stage.
      Open that file in Notepad if the app won't start — no DevTools needed.
    • BrowserWindow icon is now set only when icon.ico actually exists.
    • process.uncaughtException / unhandledRejection both logged.
    • All logPath / configPath refs go through getter functions.
*/

'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path   = require('path');
const fs     = require('fs');
const { autoUpdater } = require('electron-updater');
const crypto = require('crypto');
const os     = require('os');

// ── Debug log ─────────────────────────────────────────────────────────────────
// Written to the system temp folder (%TEMP%\myownplace-debug.log on Windows).
// Every startup stage is stamped here so you can diagnose issues without
// opening DevTools.  Safe to delete — it is recreated on next launch.
const DEBUG_LOG = path.join(os.tmpdir(), 'myownplace-debug.log');

function dbg (msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(DEBUG_LOG, line); } catch (_) {}
  // Also print to stdout when running in dev (visible in the terminal)
  if (!app.isPackaged) process.stdout.write(line);
}

dbg('=== MY OWN PLACE STARTING ===');
dbg(`Platform: ${process.platform}  Electron: ${process.versions.electron}  Node: ${process.versions.node}`);
dbg(`CWD: ${process.cwd()}`);
dbg(`__dirname: ${__dirname}`);

// ── Constants ─────────────────────────────────────────────────────────────────
const IS_DEV = !app.isPackaged;

// ── Lazy path helpers ─────────────────────────────────────────────────────────
// IMPORTANT: Do NOT call app.getPath() at module level — use these functions
// instead.  They are safe to call any time after the module loads, including
// before app.whenReady() on Electron 29, but keeping them lazy makes the
// call-site intention explicit and avoids any platform edge cases.

function getDataDir    () { return app.getPath('userData'); }
function getConfigPath () { return path.join(getDataDir(), 'config.json'); }
function getLogPath    () { return path.join(getDataDir(), 'access.csv'); }

function getTemplateBase () {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'templates')
    : path.join(__dirname, 'templates');
}

// ── Default config factory ────────────────────────────────────────────────────
// Returns a fresh object every call.  wwwRoot is derived lazily so it always
// points to the correct userData directory.
function getDefaults () {
  return {
    password:                 null,
    webPort:                  8080,
    ftpPort:                  2121,
    ftpUsername:              'myownplace',
    wwwRoot:                  path.join(getDataDir(), 'www'),
    serverName:               'My Own Place',
    enableFTP:                true,
    enablePasswordProtection: true,
    maxLogEntries:            10000,
    setupComplete:            false,
  };
}

// ── Config helpers ────────────────────────────────────────────────────────────
function loadConfig () {
  const defaults = getDefaults();
  try {
    const cfgPath = getConfigPath();
    if (fs.existsSync(cfgPath)) {
      const raw = fs.readFileSync(cfgPath, 'utf8');
      return { ...defaults, ...JSON.parse(raw) };
    }
  } catch (e) {
    dbg(`loadConfig error: ${e.message}`);
  }
  return defaults;
}

function saveConfig (updates) {
  const cfg = { ...loadConfig(), ...updates };
  const dir = getDataDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(getConfigPath(), JSON.stringify(cfg, null, 2));
    dbg(`Config saved.  Keys changed: ${Object.keys(updates).join(', ')}`);
  } catch (e) {
    dbg(`saveConfig error: ${e.message}`);
    throw e;
  }
  return cfg;
}

// ── Password hashing (PBKDF2 — no native addon required) ─────────────────────
function hashPassword (pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(pw, salt, 100000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword (pw, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const a = crypto.pbkdf2Sync(pw, salt, 100000, 64, 'sha512');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ── Network ───────────────────────────────────────────────────────────────────
function getLocalIP () {
  try {
    for (const ifaces of Object.values(os.networkInterfaces()))
      for (const iface of ifaces)
        if (iface.family === 'IPv4' && !iface.internal) return iface.address;
  } catch (_) {}
  return '127.0.0.1';
}

// ── www-root bootstrap ────────────────────────────────────────────────────────
function ensureWwwRoot (root) {
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'index.html'), DEFAULT_INDEX_HTML);
    dbg(`Created www root at: ${root}`);
  }
}

const DEFAULT_INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>My Own Place</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Segoe UI',system-ui,sans-serif;background:#0d1117;color:#c9d1d9;
         display:flex;flex-direction:column;align-items:center;justify-content:center;
         min-height:100vh;text-align:center;padding:2rem}
    h1{font-size:3rem;background:linear-gradient(135deg,#58a6ff,#bf91f3);
       -webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:1rem}
    p{color:#8b949e;font-size:1.1rem;max-width:500px;line-height:1.6}
    .badge{margin-top:2rem;display:inline-block;padding:.4rem 1.2rem;
           border:1px solid #30363d;border-radius:2rem;color:#58a6ff;font-size:.85rem}
  </style>
</head>
<body>
  <h1>My Own Place</h1>
  <p>Welcome! This is your personal website.<br>
     Open the app and use the <strong>Site Editor</strong> or
     <strong>Templates</strong> to customise this page.</p>
  <span class="badge">Powered by My Own Place</span>
</body>
</html>`;

// ── Server state ──────────────────────────────────────────────────────────────
let mainWindow    = null;
let webServerInst = null;
let ftpServerInst = null;
const serverState = { webRunning: false, ftpRunning: false };

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow () {
  dbg('createWindow() called');
  Menu.setApplicationMenu(null);   // no native menu bar — we use the custom title bar

  // Only set window icon when the .ico file actually exists.
  // icon.ico is optional (see assets/README-ICON.txt) and its absence must
  // not prevent the window from being created.
  const iconPath = path.join(__dirname, 'assets', 'icon.ico');
  const winOpts  = {
    width:           1280,
    height:          820,
    minWidth:        960,
    minHeight:       620,
    frame:           false,          // we draw our own title bar
    backgroundColor: '#0d1117',      // avoids white flash on load
    show:            false,          // show only after content is ready
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          true,        // safe with contextBridge since Electron 20+
    },
  };
  if (fs.existsSync(iconPath)) {
    winOpts.icon = iconPath;
    dbg('icon.ico found — using it');
  } else {
    dbg('icon.ico not found — using default Electron icon (harmless)');
  }

  mainWindow = new BrowserWindow(winOpts);
  dbg('BrowserWindow created OK');

  const indexPath = path.join(__dirname, 'renderer', 'index.html');
  dbg(`Loading renderer: ${indexPath}`);
  mainWindow.loadFile(indexPath);

  // Show the window as soon as Chromium has rendered the first frame
  mainWindow.once('ready-to-show', () => {
    dbg('ready-to-show — making window visible');
    mainWindow.show();
  });

  // Diagnostic events — all written to the debug log
  mainWindow.webContents.on('did-finish-load', () => {
    dbg('renderer: did-finish-load');
  });

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    dbg(`renderer: did-fail-load  code=${code}  desc="${desc}"  url="${url}"`);
  });

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    dbg(`renderer: render-process-gone  reason=${details.reason}  exitCode=${details.exitCode}`);
  });

  mainWindow.webContents.on('preload-error', (_e, preloadPath, error) => {
    dbg(`preload error in ${preloadPath}: ${error}`);
  });

  // F12 toggles DevTools (hidden by default)
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      mainWindow.webContents.isDevToolsOpened()
        ? mainWindow.webContents.closeDevTools()
        : mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  });

  mainWindow.on('closed', () => {
    dbg('mainWindow closed');
    mainWindow = null;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC Handlers
// Registered before app.whenReady() so they are available the instant the
// renderer calls invoke() — no race between window creation and handler setup.
// ─────────────────────────────────────────────────────────────────────────────
dbg('Registering IPC handlers…');

// ── Ping ──────────────────────────────────────────────────────────────────────
// Renderer calls this first to verify the IPC channel is alive before making
// any real requests.  Should respond in < 5 ms.
ipcMain.handle('ping', () => {
  dbg('ping received from renderer');
  return { ok: true, time: Date.now() };
});

// ── Config ────────────────────────────────────────────────────────────────────
ipcMain.handle('config:get', () => {
  const cfg = loadConfig();
  dbg(`config:get → setupComplete=${cfg.setupComplete}, hasPassword=${!!cfg.password}`);
  return cfg;
});

ipcMain.handle('config:verify', (_, pw) => {
  return verifyPassword(pw, loadConfig().password);
});

ipcMain.handle('config:set', (_, updates) => {
  // If updates.password is a raw string (no colon separator), hash it
  if (updates.password && !updates.password.includes(':'))
    updates.password = hashPassword(updates.password);
  // Empty string means "clear the password"
  if (updates.password === '') updates.password = null;
  saveConfig(updates);
  return { success: true };
});

// ── Network ───────────────────────────────────────────────────────────────────
ipcMain.handle('network:ip', () => {
  const ip = getLocalIP();
  dbg(`network:ip → ${ip}`);
  return ip;
});

// Returns the machine's public (internet-facing) IP by asking a free API.
// Tries two providers for reliability; resolves null if both fail or there
// is no internet connection.  Always resolves — never rejects.
ipcMain.handle('network:publicip', () => {
  return new Promise((resolve) => {
    const https = require('https');

    function tryUrl (url, cb) {
      const req = https.get(url, { timeout: 5000 }, res => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => cb(null, raw.trim()));
      });
      req.on('error',   () => cb(new Error('request error')));
      req.on('timeout', () => { req.destroy(); cb(new Error('timeout')); });
    }

    // Primary: ipify (returns plain text IP)
    tryUrl('https://api.ipify.org', (err, ip) => {
      if (!err && ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
        dbg(`network:publicip → ${ip} (ipify)`);
        return resolve(ip);
      }
      // Fallback: AWS checkip
      tryUrl('https://checkip.amazonaws.com', (err2, ip2) => {
        const clean = (ip2 || '').trim();
        if (!err2 && /^\d+\.\d+\.\d+\.\d+$/.test(clean)) {
          dbg(`network:publicip → ${clean} (aws)`);
          return resolve(clean);
        }
        dbg('network:publicip → null (both providers failed)');
        resolve(null);
      });
    });
  });
});

// ── Window controls ───────────────────────────────────────────────────────────
ipcMain.handle('win:minimize',  ()  => mainWindow?.minimize());
ipcMain.handle('win:maximize',  ()  => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.handle('win:close',     ()  => app.quit());
ipcMain.handle('win:maximized', ()  => mainWindow?.isMaximized() ?? false);

// ── Shell / dialogs ───────────────────────────────────────────────────────────
ipcMain.handle('shell:open',    (_, url) => {
  // Only allow http/https — block file://, ms-msdt:, and other dangerous schemes
  if (!/^https?:\/\//i.test(url)) return;
  return shell.openExternal(url);
});
ipcMain.handle('shell:folder',  (_, p)   => shell.openPath(p));
ipcMain.handle('dialog:folder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select website root folder',
  });
  return r;
});

// ── Server: Start ─────────────────────────────────────────────────────────────
ipcMain.handle('server:start', async () => {
  dbg('server:start called');
  const cfg    = loadConfig();
  const result = { web: false, ftp: false, errors: [] };

  ensureWwwRoot(cfg.wwwRoot);

  // Web server
  if (!serverState.webRunning) {
    try {
      const { createWebServer } = require('./server/webServer');
      webServerInst = await createWebServer(cfg, getLogPath());
      serverState.webRunning = true;
      result.web = true;
      dbg(`Web server started on port ${cfg.webPort}`);
    } catch (e) {
      dbg(`Web server start failed: ${e.message}`);
      result.errors.push(`Web: ${e.message}`);
    }
  } else {
    result.web = true;  // already running
  }

  // FTP server
  if (cfg.enableFTP && !serverState.ftpRunning) {
    try {
      const { createFtpServer } = require('./server/ftpServer');
      ftpServerInst = await createFtpServer(cfg, getLogPath());
      serverState.ftpRunning = true;
      result.ftp = true;
      dbg(`FTP server started on port ${cfg.ftpPort}`);
    } catch (e) {
      dbg(`FTP server start failed: ${e.message}`);
      result.errors.push(`FTP: ${e.message}`);
    }
  } else if (cfg.enableFTP) {
    result.ftp = true;  // already running
  }
  // else: FTP disabled — result.ftp stays false (not an error)

  return result;
});

// ── Server: Stop ──────────────────────────────────────────────────────────────
ipcMain.handle('server:stop', async () => {
  dbg('server:stop called');
  const result = { web: false, ftp: false };

  if (webServerInst) {
    try { await webServerInst.stop(); } catch (e) { dbg(`Web stop error: ${e.message}`); }
    webServerInst = null;
    serverState.webRunning = false;
    result.web = true;
  }
  if (ftpServerInst) {
    try { await ftpServerInst.stop(); } catch (e) { dbg(`FTP stop error: ${e.message}`); }
    ftpServerInst = null;
    serverState.ftpRunning = false;
    result.ftp = true;
  }
  return result;
});

// ── Server: Status ────────────────────────────────────────────────────────────
ipcMain.handle('server:status', () => ({
  ...serverState,
  ip:     getLocalIP(),
  config: loadConfig(),
}));

// ── File System ───────────────────────────────────────────────────────────────
// All paths are validated against wwwRoot to prevent directory traversal.
function safePath (wwwRoot, rel) {
  const clean = (rel || '').replace(/^\/+/, '').replace(/\\/g, '/');
  const abs   = path.resolve(wwwRoot, clean);
  if (!abs.startsWith(path.resolve(wwwRoot)))
    throw new Error('Access denied: path escapes the website root folder');
  return abs;
}

ipcMain.handle('fs:list', (_, rel = '') => {
  const { wwwRoot } = loadConfig();
  // Ensure the www directory exists even if the server has never been started.
  // This prevents an ENOENT crash when the user visits Files before pressing
  // "Start Server" for the first time.
  ensureWwwRoot(wwwRoot);
  try {
    const abs   = safePath(wwwRoot, rel);
    const items = fs.readdirSync(abs).map(name => {
      const fp   = path.join(abs, name);
      const stat = fs.statSync(fp);
      return {
        name,
        isDir:    stat.isDirectory(),
        size:     stat.size,
        modified: stat.mtime.toISOString(),
        path:     path.relative(wwwRoot, fp).replace(/\\/g, '/'),
      };
    });
    items.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return {
      items,
      current: path.relative(wwwRoot, abs).replace(/\\/g, '/') || '/',
    };
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle('fs:read', (_, rel) => {
  const { wwwRoot } = loadConfig();
  try {
    return { content: fs.readFileSync(safePath(wwwRoot, rel), 'utf8') };
  } catch (e) { return { error: e.message }; }
});

const MAX_WRITE_BYTES = 50 * 1024 * 1024; // 50 MB cap on writes and uploads

ipcMain.handle('fs:write', (_, rel, content) => {
  if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES)
    return { error: 'File too large (max 50 MB)' };
  const { wwwRoot } = loadConfig();
  try {
    const abs = safePath(wwwRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    return { success: true };
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle('fs:delete', (_, rel) => {
  const { wwwRoot } = loadConfig();
  try {
    const abs  = safePath(wwwRoot, rel);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) fs.rmSync(abs, { recursive: true, force: true });
    else fs.unlinkSync(abs);
    return { success: true };
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle('fs:mkdir', (_, rel) => {
  const { wwwRoot } = loadConfig();
  try {
    fs.mkdirSync(safePath(wwwRoot, rel), { recursive: true });
    return { success: true };
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle('fs:rename', (_, oldRel, newRel) => {
  const { wwwRoot } = loadConfig();
  try {
    fs.renameSync(safePath(wwwRoot, oldRel), safePath(wwwRoot, newRel));
    return { success: true };
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle('fs:upload', (_, fileName, b64, targetDir) => {
  if (b64.length > MAX_WRITE_BYTES * 1.4) // base64 is ~1.37× the raw size
    return { error: 'Upload too large (max 50 MB)' };
  const { wwwRoot } = loadConfig();
  try {
    const rel = path.join(targetDir || '', fileName).replace(/\\/g, '/');
    const abs = safePath(wwwRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from(b64, 'base64'));
    return { success: true };
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle('fs:wwwroot', () => loadConfig().wwwRoot);

// ── Access Log ────────────────────────────────────────────────────────────────
function parseCsvLine (line) {
  const out = []; let cur = ''; let q = false;
  for (const ch of line) {
    if (ch === '"') { q = !q; continue; }
    if (ch === ',' && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const LOG_HEADER = 'Timestamp,IP,Type,Method,Path,Status,UserAgent,Bytes\n';

ipcMain.handle('log:get', (_, limit = 1000) => {
  try {
    const lp = getLogPath();
    if (!fs.existsSync(lp)) return { entries: [] };
    const lines = fs.readFileSync(lp, 'utf8').trim().split('\n').slice(1).filter(Boolean);
    return {
      entries: lines.slice(-limit).reverse().map(l => {
        const p = parseCsvLine(l);
        return { timestamp: p[0], ip: p[1], type: p[2], method: p[3],
                 path: p[4], status: p[5], userAgent: p[6], bytes: p[7] };
      }),
    };
  } catch (e) { return { error: e.message, entries: [] }; }
});

ipcMain.handle('log:clear', () => {
  try {
    fs.writeFileSync(getLogPath(), LOG_HEADER);
    return { success: true };
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle('log:export', async () => {
  const r = await dialog.showSaveDialog(mainWindow, {
    defaultPath: `access-log-${new Date().toISOString().slice(0, 10)}.csv`,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  const lp = getLogPath();
  if (!r.canceled && fs.existsSync(lp)) {
    fs.copyFileSync(lp, r.filePath);
    return { success: true, path: r.filePath };
  }
  return { success: false };
});

ipcMain.handle('log:stats', () => {
  try {
    const lp = getLogPath();
    if (!fs.existsSync(lp)) return { total: 0, today: 0, ips: 0 };
    const lines = fs.readFileSync(lp, 'utf8').trim().split('\n').slice(1).filter(Boolean);
    const today = new Date().toISOString().slice(0, 10);
    const ips   = new Set();
    let todayCount = 0;
    for (const l of lines) {
      const p = parseCsvLine(l);
      if (p[0]?.startsWith(today)) todayCount++;
      if (p[1]) ips.add(p[1]);
    }
    return { total: lines.length, today: todayCount, ips: ips.size };
  } catch (_) { return { total: 0, today: 0, ips: 0 }; }
});

// ── Templates ─────────────────────────────────────────────────────────────────
ipcMain.handle('templates:list', () => {
  try {
    const base = getTemplateBase();
    if (!fs.existsSync(base)) return [];
    return fs.readdirSync(base)
      .filter(d => fs.statSync(path.join(base, d)).isDirectory())
      .map(id => {
        let meta = { name: id, description: '' };
        const mp = path.join(base, id, 'meta.json');
        if (fs.existsSync(mp)) {
          try { meta = JSON.parse(fs.readFileSync(mp, 'utf8')); } catch (_) {}
        }
        return { id, ...meta };
      });
  } catch (e) {
    dbg(`templates:list error: ${e.message}`);
    return [];
  }
});

ipcMain.handle('templates:preview', (_, id) => {
  const base = path.resolve(getTemplateBase());
  const abs  = path.resolve(base, id);
  if (!abs.startsWith(base)) return { error: 'Invalid template id' };
  try { return { content: fs.readFileSync(path.join(abs, 'index.html'), 'utf8') }; }
  catch (e) { return { error: e.message }; }
});

ipcMain.handle('templates:apply', (_, id) => {
  const base = path.resolve(getTemplateBase());
  const src  = path.resolve(base, id);
  if (!src.startsWith(base)) return { error: 'Invalid template id' };
  const { wwwRoot } = loadConfig();
  try {
    cpDirSync(src, wwwRoot, ['meta.json', 'preview.png']);
    return { success: true };
  } catch (e) { return { error: e.message }; }
});

function cpDirSync (src, dest, exclude = []) {
  fs.mkdirSync(dest, { recursive: true });
  for (const item of fs.readdirSync(src)) {
    if (exclude.includes(item)) continue;
    const s = path.join(src, item);
    const d = path.join(dest, item);
    if (fs.statSync(s).isDirectory()) cpDirSync(s, d, exclude);
    else fs.copyFileSync(s, d);
  }
}

dbg('All IPC handlers registered');

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  dbg('app.whenReady() resolved — calling createWindow()');
  createWindow();
  setupAutoUpdater();
});

// ── Auto-updater ──────────────────────────────────────────────────────────────
function setupAutoUpdater () {
  if (!app.isPackaged) return;   // only check for updates in production builds

  autoUpdater.autoDownload    = true;   // download silently in the background
  autoUpdater.autoInstallOnAppQuit = false;  // we prompt the user instead

  autoUpdater.on('update-available', info => {
    dbg(`Update available: v${info.version}`);
    if (mainWindow) mainWindow.webContents.send('update:available', info.version);
  });

  autoUpdater.on('update-downloaded', info => {
    dbg(`Update downloaded: v${info.version}`);
    if (mainWindow) mainWindow.webContents.send('update:downloaded', info.version);
  });

  autoUpdater.on('error', err => {
    dbg(`Auto-updater error: ${err.message}`);
  });

  // Check 5 seconds after startup (gives the window time to load first)
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(err => dbg(`checkForUpdates error: ${err.message}`));
  }, 5000);
}

// Renderer calls this when the user clicks "Restart & Update"
ipcMain.handle('update:install', () => {
  autoUpdater.quitAndInstall(false, true);
});

app.on('window-all-closed', async () => {
  dbg('window-all-closed — stopping servers');
  try { if (webServerInst) await webServerInst.stop(); } catch (_) {}
  try { if (ftpServerInst) await ftpServerInst.stop(); } catch (_) {}
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ── Global error traps — logged so nothing is silently swallowed ──────────────
process.on('uncaughtException', err => {
  dbg(`UNCAUGHT EXCEPTION: ${err.stack || err.message}`);
});
process.on('unhandledRejection', reason => {
  dbg(`UNHANDLED REJECTION: ${reason}`);
});

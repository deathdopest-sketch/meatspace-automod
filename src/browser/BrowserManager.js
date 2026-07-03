'use strict';

const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const http  = require('http');
const net   = require('net');
const { spawn } = require('child_process');

const puppeteerExtra  = require('puppeteer-extra');
const StealthPlugin   = require('puppeteer-extra-plugin-stealth');
puppeteerExtra.use(StealthPlugin());

/**
 * BrowserManager — Chrome lifecycle and Puppeteer page management.
 *
 * Two launch modes:
 *  - Docker   (DOCKER=true) — puppeteerExtra.launch() with Xvfb already running
 *  - Windows  (default)    — spawn system Chrome with CDP, connect via puppeteer.connect()
 *
 * Windows Defender note: system Chrome MUST be tried first — bundled puppeteer
 * Chrome gets killed by Defender. The CDP retry loop handles Chrome's self-respawn.
 */
class BrowserManager {
  /**
   * @param {Object} config   — CONFIG from config/zomb.js
   * @param {Object} logger   — Logger instance
   */
  constructor(config, logger) {
    this.config = config;
    this.log    = logger;

    this.browser         = null;
    this._browserProcess = null;
    this._debugPort      = config.CDP_DEBUG_PORT || 9222;
    // Sanitize CHROME_USER_DATA — only allow a single directory name, never a path
    const rawUdd  = config.CHROME_USER_DATA || 'zomb-bot-chrome';
    const safeUdd = path.basename(rawUdd).replace(/[^a-zA-Z0-9_\-]/g, '_') || 'zomb-bot-chrome';
    this._userDataDir = path.join(os.tmpdir(), safeUdd);
  }

  // ── TCP + HTTP readiness probes ───────────────────────────────────────────

  _waitForPort(port, host, timeoutMs) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const attempt = () => {
        const sock = new net.Socket();
        sock.setTimeout(500);
        sock.once('connect', () => { sock.destroy(); resolve(); });
        sock.once('error',   () => { sock.destroy(); if (Date.now() < deadline) setTimeout(attempt, 300); else reject(new Error(`Port ${port} not open after ${timeoutMs}ms`)); });
        sock.once('timeout', () => { sock.destroy(); if (Date.now() < deadline) setTimeout(attempt, 300); else reject(new Error(`Port ${port} timed out`)); });
        sock.connect(port, host);
      };
      attempt();
    });
  }

  /** Wait until Chrome's DevTools HTTP endpoint is responding (not just TCP open). */
  _waitForHttpReady(port, timeoutMs) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const attempt = () => {
        const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
          res.resume();
          if (res.statusCode === 200) resolve();
          else if (Date.now() < deadline) setTimeout(attempt, 500);
          else reject(new Error(`DevTools endpoint not ready after ${timeoutMs}ms`));
        });
        req.setTimeout(1500, () => { req.destroy(); if (Date.now() < deadline) setTimeout(attempt, 500); else reject(new Error('DevTools timed out')); });
        req.on('error', () => { if (Date.now() < deadline) setTimeout(attempt, 500); else reject(new Error('DevTools unreachable')); });
      };
      attempt();
    });
  }

  _checkDebugPort(port) {
    return new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.setTimeout(1000, () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
    });
  }

  // ── Chrome path resolution ────────────────────────────────────────────────

  _findChromePath() {
    let bundledChrome = null;
    try { bundledChrome = require('puppeteer').executablePath(); } catch (_) {}

    const localAppData = process.env.LOCALAPPDATA || '';
    const candidates = [
      // System Chrome first — Defender trusts it
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      path.join(localAppData, 'Google\\Chrome\\Application\\chrome.exe'),
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      path.join(localAppData, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
      this.config.BROWSER_PATH,
      bundledChrome,
    ].filter(p => { try { return p && fs.existsSync(p); } catch { return false; } });

    const seen  = new Set();
    const unique = candidates.filter(p => { if (seen.has(p)) return false; seen.add(p); return true; });
    if (unique.length === 0) throw new Error('No browser found. Install Chrome or Brave.');
    return unique;
  }

  // ── Launch ────────────────────────────────────────────────────────────────

  async launch() {
    this.log?.info('Launching browser...');

    // ── Docker mode ────────────────────────────────────────────────────────
    // Uses Xvfb virtual display (set up by docker-entrypoint.sh, DISPLAY=:99)
    // headless:false with Xvfb is more compatible with StumbleChat than headless:'new'
    if (process.env.DOCKER === 'true') {
      const args = [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled',
        '--disable-infobars', '--window-size=1366,768', '--no-first-run',
        '--no-default-browser-check', '--disable-extensions',
        '--autoplay-policy=no-user-gesture-required',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--remote-debugging-port=9222',
        '--disable-features=VizDisplayCompositor',
      ];
      this.browser = await puppeteerExtra.launch({
        executablePath : process.env.BROWSER_PATH || '/usr/bin/chromium',
        headless       : false,
        args,
        defaultViewport: { width: 1366, height: 768 },
        env            : { ...process.env, DISPLAY: process.env.DISPLAY || ':99' },
      });
      this.log?.info('Browser ready (Docker mode)');
      return;
    }

    // ── Windows CDP mode ───────────────────────────────────────────────────
    const debugPort = this._debugPort;
    const alreadyOpen = await this._checkDebugPort(debugPort);

    if (alreadyOpen) {
      this.log?.info(`Debug port ${debugPort} already open — reusing existing browser`);
    } else {
      // Clear stale lock files
      for (const lf of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']) {
        try {
          const p = path.join(this._userDataDir, lf);
          if (fs.existsSync(p)) { fs.unlinkSync(p); this.log?.debug(`Cleared lock: ${lf}`); }
        } catch (_) {}
      }

      const chromePaths = this._findChromePath();
      const browserArgs = [
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${this._userDataDir}`,
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu',
        '--no-first-run', '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars', '--window-size=1366,768',
        '--no-default-browser-check', '--disable-extensions',
        '--disable-web-security', '--autoplay-policy=no-user-gesture-required',
        'about:blank',
      ];
      if (this.config.HEADLESS) browserArgs.push('--headless=new');

      let spawned = false;
      for (const cp of chromePaths) {
        this.log?.info(`Spawning: ${cp}`);
        try {
          this._browserProcess = spawn(cp, browserArgs, {
            detached   : true,
            stdio      : 'ignore',
            windowsHide: false,
          });
          this._browserProcess.unref();
          this._browserProcess.on('error', e => this.log?.error('Browser spawn error: ' + e.message));
          await this._waitForHttpReady(debugPort, 45000);
          this.log?.info(`Browser ready on port ${debugPort}: ${cp}`);
          spawned = true;
          break;
        } catch (e) {
          this.log?.warn(`Spawn failed (${cp}): ${e.message.split('\n')[0]}`);
        }
      }
      if (!spawned) throw new Error('Could not spawn any browser. Tried: ' + chromePaths.join(', '));
    }

    // Give DevTools HTTP server a moment to fully stabilise
    await new Promise(r => setTimeout(r, 2000));

    // CDP connect — retry loop (Chrome may briefly die and respawn on Windows)
    let connectErr;
    for (let attempt = 1; attempt <= 8; attempt++) {
      try {
        await this._waitForHttpReady(debugPort, 15000);
        this.browser = await puppeteerExtra.connect({
          browserURL      : `http://127.0.0.1:${debugPort}`,
          defaultViewport : null,
          protocolTimeout : 120000,   // 2 min — prevents cascade from heavy-page protocol hangs
        });
        connectErr = null;
        break;
      } catch (e) {
        connectErr = e;
        this.log?.warn(`Connect attempt ${attempt}/8 failed: ${e.message.split('\n')[0]} — retrying in 3s...`);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
    if (connectErr) throw connectErr;

    this.log?.info('Browser connected via CDP');
  }

  // ── Page helpers ──────────────────────────────────────────────────────────

  /** Open a new page and apply stealth overrides + virtual camera intercept. */
  async newPage() {
    const page = await this.browser.newPage();
    await page.evaluateOnNewDocument(() => {
      // ── Stealth ────────────────────────────────────────────────────────────
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      if (!window.chrome) window.chrome = { runtime: {} };
      const origQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (p) =>
        p.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : origQuery(p);

      // ── Virtual camera (canvas-based MediaStream) ───────────────────────
      // Intercepts getUserMedia so StumbleChat gets our canvas stream instead
      // of a real camera. _zombSlideshow drives what's painted on the canvas.
      (function _installZombCam() {
        if (!navigator.mediaDevices) return;
        const _origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

        function _zombInitCanvas() {
          if (window._zombCanvas) return;
          const cv = document.createElement('canvas');
          cv.width = 640; cv.height = 480;
          const ctx = cv.getContext('2d');
          ctx.fillStyle = '#1a0a00';
          ctx.fillRect(0, 0, 640, 480);
          ctx.fillStyle = '#cc6600';
          ctx.font = 'bold 56px Arial';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('\uD83E\uDD69', 320, 200); // 🥩
          ctx.fillStyle = '#884422';
          ctx.font = 'bold 28px Arial';
          ctx.fillText('SirLoin_v1', 320, 300);
          window._zombCanvas = cv;
          window._zombCtx    = ctx;
          window._zombStream = cv.captureStream(25);

          window._zombSlideshow = {
            _vid: null,
            _raf: null,
            setImage: function(url) {
              if (this._vid) { this._vid.pause(); this._vid = null; }
              if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
              const img = new Image();
              img.crossOrigin = 'anonymous';
              img.onload = () => {
                window._zombCtx.drawImage(img, 0, 0, 640, 480);
              };
              img.onerror = () => {
                const c = window._zombCtx;
                c.fillStyle = '#0a0205'; c.fillRect(0, 0, 640, 480);
                c.fillStyle = '#884422'; c.font = 'bold 24px Arial';
                c.textAlign = 'center'; c.textBaseline = 'middle';
                c.fillText('ZomB', 320, 240);
              };
              img.src = url;
            },
            setVideo: function(url) {
              if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
              const vid = document.createElement('video');
              vid.src = url; vid.muted = true;
              vid.crossOrigin = 'anonymous'; vid.playsInline = true;
              this._vid = vid;
              const self = this;
              vid.addEventListener('ended', () => {
                if (window._zombOnVideoEnded) window._zombOnVideoEnded();
              });
              vid.play().then(() => {
                function draw() {
                  if (vid !== self._vid) return;
                  if (window._zombCtx && !vid.ended) {
                    window._zombCtx.drawImage(vid, 0, 0, 640, 480);
                    self._raf = requestAnimationFrame(draw);
                  }
                }
                draw();
              }).catch(() => {
                if (window._zombOnVideoEnded) window._zombOnVideoEnded();
              });
            },
          };
        }

        navigator.mediaDevices.getUserMedia = async function(constraints) {
          if (constraints && constraints.video) {
            _zombInitCanvas();
            const videoTrack = window._zombStream.getVideoTracks()[0];
            if (constraints.audio) {
              try {
                const actx = new AudioContext();
                const dest  = actx.createMediaStreamDestination();
                const osc   = actx.createOscillator();
                const gain  = actx.createGain();
                gain.gain.value = 0; // silent
                osc.connect(gain); gain.connect(dest); osc.start();
                return new MediaStream([videoTrack, dest.stream.getAudioTracks()[0]]);
              } catch (_) {}
            }
            return new MediaStream([videoTrack]);
          }
          return _origGUM(constraints);
        };
      })();
    });
    return page;
  }

  /** Gracefully close the browser (if we own the process). */
  async close() {
    try { if (this.browser) await this.browser.close(); } catch (_) {}
    this.browser = null;
  }

  /** True if browser is connected and not closed. */
  get isConnected() {
    return !!(this.browser && this.browser.isConnected());
  }
}

module.exports = BrowserManager;

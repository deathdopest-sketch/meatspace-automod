'use strict';

/**
 * automod.js — stripped-down SirLoin that only automods meatspace.
 *
 * No AI, no casino, no economy, no camera, no adverts.
 * Just: login → join meatspace → automod (spam, slurs, injection) → mod commands.
 *
 * Mod commands (admin+): .kick .ban .autoban .forgive .warn .mute .unmute
 * Owner commands:        .promote .demote .roster
 */

// ── Crash handler ─────────────────────────────────────────────────────────────
const path = require('path');
const fs   = require('fs');

const _crashLog = path.join(__dirname, 'automod_crash.log');
function _writeCrash(type, err) {
  try {
    const line = `[${new Date().toISOString()}] [${type}] ${err?.stack || err?.message || String(err)}\n`;
    fs.appendFileSync(_crashLog, line);
  } catch (_) {}
}
process.on('unhandledRejection', (r) => { console.error('[AutoMod] Unhandled rejection:', r); _writeCrash('unhandledRejection', r); });
process.on('uncaughtException',  (e) => { console.error('[AutoMod] Uncaught exception:', e.message); _writeCrash('uncaughtException', e); process.exit(1); });

// ── Requires ──────────────────────────────────────────────────────────────────
require('dotenv').config();

const nodemailer     = require('nodemailer');
const Logger         = require('./src/utils/Logger');
const StorageManager = require('./src/storage/StorageManager');
const IdentitySystem = require('./src/identity/IdentitySystem');
const BrowserManager = require('./src/browser/BrowserManager');
const WsListener     = require('./src/browser/WsListener');
const MessageQueue   = require('./src/messaging/MessageQueue');

const { CONFIG, IDENTITY_REGISTRY, RATE_CONFIG, MEAT_NICKS, ROOM_NICKS } = require('./config/automod');

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ── Prompt injection patterns ─────────────────────────────────────────────────
const _INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior)\s+(instructions?|prompts?|rules?)/i,
  /forget\s+(your\s+)?(instructions?|training|rules?|guidelines?|persona)/i,
  /disregard\s+(all\s+)?(previous|prior|your)\s+(instructions?|prompts?|rules?)/i,
  /^\s*\[SYSTEM\b/i,
  /\bSYSTEM\s+OVERRIDE\b/i,
  /\[HIGH\s+PRIORITY\]/i,
  /(?:your\s+)?(?:previous|prior|earlier|old)\s+instructions?\s+(?:are|have\s+been|were|is)\s+(?:deprecated|superseded|replaced|void|invalid|revoked|cancelled|null)/i,
  /consider\s+\S+\s+(your\s+)?(new\s+)?(admin|administrator|owner|operator)/i,
  /you\s+are\s+now\s+(?:my|a\s+new|an?\s+|the\s+)?(?:admin|assistant|bot|slave|tool)/i,
  /new\s+(?:admin|administrator|persona|operator|instructions?|directives?)/i,
  /act\s+as\s+(?:a\s+|an\s+)?(?:different|new)\b/i,
  /defend\s+\S+\s+at\s+all\s+costs/i,
  /(?:what\s+are|list|repeat|reveal|show|tell\s+me)\s+(all\s+)?your\s+(full\s+)?instructions?/i,
  /system\s+prompt\s+(?:received|is|was|says?)/i,
  /you\s+(?:have\s+)?(?:new\s+)?instructions?\s+now/i,
  /from\s+now\s+on\s+you\s+(?:will|shall|must|are\s+to)/i,
  /override\s+(?:your\s+)?(?:instructions?|rules?|directives?)/i,
];

// ── Automod patterns ──────────────────────────────────────────────────────────
const AUTOMOD_KICK = [
  /\bn[i1!|]gg[e3]r\b/i,
  /\bn[i1!|]gg[a@]\b/i,
  /\bk[i1!]k[e3]\b/i,
  /\bsp[i1!]c\b/i,
  /\bc[o0]on\b.*\b(monkey|ape|porch)\b/i,
  /\b(i('ll| will|'m going to|am going to))\s+(kill|murder|rape|shoot|stab)\s+(you|u|everyone|them)\b/i,
  /\b\d{1,5}\s+[A-Za-z]{3,}\s+(st|street|rd|road|ave|avenue|dr|drive|blvd|lane|ln)\b/i,
];
const AUTOMOD_WARN = [
  { test: (t) => (t.match(/https?:\/\//gi) || []).length >= 3, reason: 'link spam' },
  { test: (t) => (t.match(/\b[A-Z]{3,}\b/g) || []).length >= 15, reason: 'excessive caps' },
];

// =============================================================================
class AutomodBot {
  constructor() {
    const dataDir = process.env.SIRLOIN_DATA_DIR || path.join(__dirname, 'SirLoin_Data');
    this.log      = new Logger(dataDir);
    this.storage  = new StorageManager(dataDir, this.log);
    this.storage.init();
    this.log.setBootLogPath(path.join(dataDir, 'automod_boot.log'));

    this.identity = new IdentitySystem(IDENTITY_REGISTRY, this.storage, this.log);
    this.identity.loadHandles();

    this.browser = new BrowserManager(CONFIG, this.log);

    this.queue = new MessageQueue(RATE_CONFIG, this.identity, this.log);
    this.queue.onDeadChannel = (roomName) => {
      this._reconnect(roomName).catch(() => {});
    };

    // State
    this._rooms            = {};   // roomName → { page, wsListener }
    this._roomPresence     = {};   // roomName → Set<nickLower>
    this._reconnecting     = new Set();
    this._lastReconnectMs  = {};
    this._bootstrapIntervals = {};
    this._recentSent       = [];   // echo dedup
    this._activeRoomNick   = {};   // roomName → current nick
    this._handleToAccount  = new Map(); // handle → accountUsername

    // Moderation
    const _mod           = this._loadModeration();
    this._warnTimestamps = _mod.warnTimestamps;
    this._warnCount      = this._computeWarnCounts();
    this._muted          = new Set(_mod.mutes);
    this._mutedNotified  = new Set();
    this._muteExpiry     = new Map(Object.entries(_mod.muteExpiry || {}).map(([k, v]) => [k, v]));
    this._spamTracker    = new Map();
    this._attackTracker  = new Map();
    this._promotions     = this._loadPromotions();
    this._autoban        = new Set(['shenron']);

    // VoteBan
    this._voteBanState    = new Map(); // roomName → vote state
    this._voteBanCooldown = new Map(); // roomName → last vote timestamp

    // Cam/activity tracking (used by voteban pools)
    this._broadcasting   = {};   // roomName → Set<nickLower>
    this._userLastActive = {};   // roomName → Map<nickLower, timestamp>

    this._loadAttackerRegistry();
    this._loadAutoBan();

    // Daily log digest
    this._modLog = []; // { ts, type, by, target }
    this._dailyEmailTimer = null;

    this.log.info('[AutoMod] Initialised');
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async start() {
    this.log.info('[AutoMod] Starting...');
    await this.browser.launch();

    await this._login();
    await this._joinRoom('meatspace');

    this._startDailyEmail();
    this.log.info('[AutoMod] Online — meatspace is being watched.');
  }

  async stop() {
    this.log.info('[AutoMod] Shutting down...');
    if (this._dailyEmailTimer) clearTimeout(this._dailyEmailTimer);
    for (const id of Object.values(this._bootstrapIntervals)) clearInterval(id);
    for (const [, r] of Object.entries(this._rooms)) {
      if (r.wsListener) await r.wsListener.stop().catch(() => {});
    }
    await this.browser.close();
    this.log.info('[AutoMod] Shutdown complete.');
  }

  // ── Login ───────────────────────────────────────────────────────────────────

  async _login() {
    this.log.info('[AutoMod] Logging in...');
    const page = await this.browser.newPage();
    await page.goto('https://stumblechat.com/login', { waitUntil: 'networkidle2', timeout: 30000 });

    if (!page.url().includes('login')) {
      this.log.info('[AutoMod] Already logged in');
      await page.close();
      return;
    }

    try { await page.waitForSelector('input', { timeout: 15000 }); } catch (_) {}
    await sleep(2000);

    const emailSels = ['#username', 'input[name="username"]', 'input[name="email"]', 'input[type="email"]'];
    const passSels  = ['#password', 'input[name="password"]', 'input[type="password"]'];
    let emailInput = null, passInput = null;
    for (const s of emailSels) { emailInput = await page.$(s); if (emailInput) break; }
    for (const s of passSels)  { passInput  = await page.$(s); if (passInput)  break; }
    if (!emailInput || !passInput) {
      const all = await page.$$('input');
      if (all.length >= 2) { emailInput = all[0]; passInput = all[1]; }
      else throw new Error('Login form not found');
    }

    await emailInput.click({ clickCount: 3 }); await page.keyboard.press('Backspace');
    await emailInput.type(CONFIG.LOGIN_EMAIL, { delay: 50 });
    await passInput.click({ clickCount: 3 });  await page.keyboard.press('Backspace');
    await passInput.type(CONFIG.LOGIN_PASS,  { delay: 50 });

    const submitSels = ['button[type="submit"]', 'input[type="submit"]', '.login-button', 'button'];
    let submitted = false;
    for (const s of submitSels) { const btn = await page.$(s); if (btn) { await btn.click(); submitted = true; break; } }
    if (!submitted) await page.keyboard.press('Enter');

    try { await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }); }
    catch (_) { await sleep(5000); }

    await page.close();
    this.log.info('[AutoMod] Login complete');
  }

  // ── Room join ───────────────────────────────────────────────────────────────

  async _joinRoom(roomName) {
    this.log.info(`[AutoMod] Joining ${roomName}...`);
    const page = await this.browser.newPage();

    try {
      const ctx = this.browser.browser?.defaultBrowserContext();
      if (ctx) await ctx.overridePermissions('https://stumblechat.com', ['camera', 'microphone']);
    } catch (_) {}

    const wsListener = new WsListener(
      roomName, page, this._getRoomNick(roomName),
      this._makeWsCallbacks(roomName, page),
      this.log
    );

    if (wsListener.preNavigate) await wsListener.preNavigate();

    const JOIN_ATTEMPTS = 3;
    let joined = false;
    for (let attempt = 1; attempt <= JOIN_ATTEMPTS && !joined; attempt++) {
      if (attempt > 1) {
        await wsListener.stop().catch(() => {});
        await wsListener.start();
        await page.goto(`https://stumblechat.com/room/${roomName}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(1500);
      } else {
        await wsListener.start();
        await page.goto(`https://stumblechat.com/room/${roomName}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(1000);
      }
      await sleep(1500);

      const deadline = Date.now() + 12000;
      let clicked = false;
      while (Date.now() < deadline && !clicked) {
        try {
          const wsAlive = await page.evaluate(() => (window._allWebSockets || []).some(w => w.readyState <= 1)).catch(() => false);
          if (wsAlive) { clicked = true; break; }

          for (const sel of ['#interact', '#joinroom', '#join-room', '#enter-room', '[data-action="join"]']) {
            const el = await page.$(sel).catch(() => null);
            if (el) { await page.click(sel).catch(() => {}); clicked = true; break; }
          }
          if (clicked) break;

          clicked = await page.evaluate(() => {
            const WANT = ['enter', 'join', 'verify', 'watch', 'start', 'continue', 'proceed'];
            const els  = document.querySelectorAll('button,[role="button"],a.btn,input[type="submit"]');
            for (const el of els) {
              const t    = (el.textContent || el.value || '').toLowerCase().trim();
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0 && WANT.some(w => t.includes(w))) { el.click(); return true; }
            }
            return false;
          }).catch(() => false);
        } catch (_) {}
        if (!clicked) await sleep(500);
      }

      if (!clicked) { await page.keyboard.press('Enter').catch(() => {}); await sleep(500); }
      try { await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 6000 }); } catch (_) {}
      await sleep(3000);
      if (wsListener.injectRelay) await wsListener.injectRelay();

      const wsCheck = await page.evaluate(() => ({
        allWs: (window._allWebSockets || []).length,
      })).catch(() => ({ allWs: 0 }));

      if (wsCheck.allWs > 0 || wsListener.isWsConnected) {
        joined = true;
        this.log.info(`[AutoMod:${roomName}] WS confirmed (attempt ${attempt})`);
      } else {
        this.log.warn(`[AutoMod:${roomName}] WS not established after attempt ${attempt}`);
        if (attempt < JOIN_ATTEMPTS) await sleep(2000);
      }
    }

    if (!joined) this.log.warn(`[AutoMod:${roomName}] Join failed after ${JOIN_ATTEMPTS} attempts — proceeding anyway`);

    this._rooms[roomName] = { page, wsListener };
    await this._wsSetNick(roomName, page);

    setTimeout(() => this._bootstrapUserListFromDom(roomName, page).catch(() => {}), 5000);
    if (this._bootstrapIntervals[roomName]) clearInterval(this._bootstrapIntervals[roomName]);
    this._bootstrapIntervals[roomName] = setInterval(
      () => this._bootstrapUserListFromDom(roomName, page).catch(() => {}),
      2 * 60 * 1000
    );

    this.log.info(`[AutoMod] In room: ${roomName}`);
  }

  // ── WS callbacks ────────────────────────────────────────────────────────────

  _makeWsCallbacks(roomName, page) {
    return {
      onMessage:       (r, nick, text, handle) => this._onMessage(r, nick, text, handle, page),
      onJoin:          (r, nick, handle, uname) => this._onJoin(r, nick, handle, page, uname),
      onLeave:         (r, nick, handle)        => this._onLeave(r, nick, handle),
      onNickChange:    (r, old_, new_, handle)  => this._onNickChange(r, old_, new_, handle),
      onUserList:      (r, users)               => this._onUserList(r, users),
      onUnknownHandle: (r, handle)              => this._bootstrapUserListFromDom(r, page).catch(() => {}),
      onReconnected:   (r)                      => setTimeout(() => this._wsSetNick(r, page).catch(() => {}), 1500),
      onSubscribe:     (r, nick)                => {
        if (!nick) return;
        if (!this._broadcasting[r]) this._broadcasting[r] = new Set();
        this._broadcasting[r].add(nick.toLowerCase());
      },
      onUnsubscribe:   (r, nick)                => {
        if (nick && this._broadcasting[r]) this._broadcasting[r].delete(nick.toLowerCase());
      },
    };
  }

  // ── Event handlers ───────────────────────────────────────────────────────────

  async _onJoin(roomName, nick, handle, page, username) {
    if (!nick || nick === this._getRoomNick(roomName)) return;
    this.log.info(`[AutoMod:${roomName}] JOIN "${nick}" handle=${handle} username="${username || ''}"`);

    if (handle) this.identity.identify(nick, handle, username || null);
    if (handle && username) this._bindAccountName(handle, username);

    if (!this._roomPresence[roomName]) this._roomPresence[roomName] = new Set();
    this._roomPresence[roomName].add(nick.toLowerCase());

    // Autoban on sight
    const nickLow = nick.toLowerCase();
    const acctLow = username?.toLowerCase() || '';
    if (this._autoban.has(nickLow) || (acctLow && this._autoban.has(acctLow))) {
      this.log.info(`[AutoMod:${roomName}] AUTOBAN: "${nick}"`);
      await sleep(800);
      await this._banUser(page, nick);
      await this._send(roomName, page, `${nick} — banned on sight.`);
    }
  }

  _onLeave(roomName, nick) {
    if (!nick) return;
    this._roomPresence[roomName]?.delete(nick.toLowerCase());
  }

  _onNickChange(roomName, oldNick, newNick, handle) {
    if (oldNick && this._roomPresence[roomName]) this._roomPresence[roomName].delete(oldNick.toLowerCase());
    if (newNick && newNick !== this._getRoomNick(roomName)) {
      if (!this._roomPresence[roomName]) this._roomPresence[roomName] = new Set();
      this._roomPresence[roomName].add(newNick.toLowerCase());
    }
    if (handle) {
      const acct = this._handleToAccount.get(String(handle));
      if (acct) this.identity.identify(acct, handle);
    }
  }

  _onUserList(roomName, users) {
    for (const u of users) {
      if (u.handle && u.nick)      this.identity.identify(u.nick, u.handle, u.username || null);
      if (u.handle && u.username)  this._bindAccountName(u.handle, u.username);
    }
    if (!this._roomPresence[roomName]) this._roomPresence[roomName] = new Set();
    for (const u of users) {
      if (u.nick && u.nick !== this._getRoomNick(roomName)) {
        this._roomPresence[roomName].add(u.nick.toLowerCase());
      }
    }
  }

  async _onMessage(roomName, nick, text, handle, page) {
    if (!text || !nick) return;
    if (nick === this._getRoomNick(roomName)) return;

    // Echo dedup
    const nowMs = Date.now();
    if (this._recentSent.some(e => e.text === text && nowMs - e.ts < 4000)) return;

    this.log.info(`[${roomName}] <${nick}> ${text}`);

    // Track last activity (used by voteban active pool)
    if (!this._userLastActive[roomName]) this._userLastActive[roomName] = new Map();
    this._userLastActive[roomName].set(nick.toLowerCase(), nowMs);

    if (handle) this.identity.identify(nick, handle);

    // Prompt injection guard (exempt owners/admins)
    const role = this._getEffectiveRole(nick, handle);
    const exempt = role === 'owner' || role === 'admin' || role === 'protected' || role === 'trusted';
    if (!exempt && this._isPromptInjection(text)) {
      await this._handleInjectionAttempt(roomName, nick, text, page);
      return;
    }

    // Spam detection
    this._checkSpam(roomName, nick, text, page);

    // Hard automod rules
    if (await this._checkAutoMod(roomName, nick, text, handle, page)) return;

    // VoteBan vote collector
    const vbState = this._voteBanState.get(roomName);
    if (vbState && nick.toLowerCase() !== vbState.target.toLowerCase()) {
      const isYes = /^\s*yes\s*$/i.test(text);
      const isNo  = /^\s*no\s*$/i.test(text);
      if (isYes || isNo) {
        const nickLow   = nick.toLowerCase();
        const handleLow = handle ? String(handle).toLowerCase() : null;
        const voted     = vbState.yesVoters.has(nickLow) || vbState.noVoters.has(nickLow) ||
                          (handleLow && vbState.voterHandles.has(handleLow));
        if (!voted) {
          if (handleLow) vbState.voterHandles.add(handleLow);
          if (isYes) {
            vbState.yesVoters.add(nickLow);
            const earlyReason = this._checkVoteBanEarlyPass(roomName);
            const yesOnCam   = [...vbState.yesVoters].filter(n => vbState.onCamPool.has(n)).length;
            const yesActive  = [...vbState.yesVoters].filter(n => vbState.activePool.has(n)).length;
            const yesSupers  = [...vbState.yesVoters].filter(n => vbState.superPool.has(n)).length;
            await this._send(roomName, page,
              `${nick} votes yes. (${vbState.yesVoters.size} yes / ${vbState.noVoters.size} no — ` +
              `cam: ${yesOnCam}/${Math.ceil(vbState.onCamPool.size * 0.5)} · ` +
              `supers: ${yesSupers}/${Math.ceil(vbState.superPool.size * 0.5)} · ` +
              `active: ${yesActive}/${Math.ceil(vbState.activePool.size * 0.5)})`
            );
            if (earlyReason) await this._finalizeVoteBan(roomName, vbState.target, earlyReason);
          } else {
            vbState.noVoters.add(nickLow);
            const yesOnCam  = [...vbState.yesVoters].filter(n => vbState.onCamPool.has(n)).length;
            const yesActive = [...vbState.yesVoters].filter(n => vbState.activePool.has(n)).length;
            const yesSupers = [...vbState.yesVoters].filter(n => vbState.superPool.has(n)).length;
            await this._send(roomName, page,
              `${nick} votes no. (${vbState.yesVoters.size} yes / ${vbState.noVoters.size} no — ` +
              `cam: ${yesOnCam}/${Math.ceil(vbState.onCamPool.size * 0.5)} · ` +
              `supers: ${yesSupers}/${Math.ceil(vbState.superPool.size * 0.5)} · ` +
              `active: ${yesActive}/${Math.ceil(vbState.activePool.size * 0.5)})`
            );
          }
        }
      }
    }

    // Command handling
    if (text.startsWith('.')) {
      await this._handleCommand(roomName, nick, text, handle, page);
      return;
    }

    // Mute check — inform once per session
    this._checkMuteExpiry(nick);
    if (this._muted.has(nick.toLowerCase())) {
      if (!this._mutedNotified.has(nick.toLowerCase())) {
        this._mutedNotified.add(nick.toLowerCase());
        await this._send(roomName, page, `${nick} — you're muted.`);
      }
    }
  }

  // ── Command handling ─────────────────────────────────────────────────────────

  async _handleCommand(roomName, nick, text, handle, page) {
    const parts   = text.slice(1).trim().split(/\s+/);
    const cmd     = parts[0]?.toLowerCase();
    const args    = parts.slice(1);
    const role    = this._getEffectiveRole(nick, handle);
    const isOwner = role === 'owner';
    const isAdmin = role === 'owner' || role === 'admin';
    const isMod   = ['mod', 'supermod', 'admin', 'owner'].includes(role);

    switch (cmd) {

      case 'warn': {
        if (!isAdmin) return;
        const target = args[0];
        if (!target) { await this._send(roomName, page, 'Warn who?'); return; }
        const key = target.toLowerCase();
        if (!this._warnTimestamps[key]) this._warnTimestamps[key] = [];
        this._warnTimestamps[key].push(Date.now());
        this._warnCount[key] = this._activeWarnCount(key);
        this._saveModeration();
        this._pushModLog('warn', nick, target);
        const count = this._warnCount[key];
        const msgs  = [
          `${target} — first and last warning. Sort yourself out.`,
          `${target} — that's your second warning. One more and you're out.`,
          `${target} — you were warned. Done.`,
        ];
        await this._send(roomName, page, msgs[Math.min(count - 1, msgs.length - 1)]);
        await this._autoKickIfThreshold(roomName, target, page);
        return;
      }

      case 'mute': {
        if (!isAdmin) return;
        const target = args[0];
        if (!target) { await this._send(roomName, page, 'Mute who?'); return; }
        const duration = args[1] ? this._parseDuration(args[1]) : null;
        this._muted.add(target.toLowerCase());
        if (duration) this._muteExpiry.set(target.toLowerCase(), Date.now() + duration);
        else          this._muteExpiry.delete(target.toLowerCase());
        this._saveModeration();
        await this._send(roomName, page, `${target} — muted${args[1] ? ` for ${args[1]}` : ''}.`);
        return;
      }

      case 'unmute': {
        if (!isAdmin) return;
        const target = args[0];
        if (!target) { await this._send(roomName, page, 'Unmute who?'); return; }
        this._muted.delete(target.toLowerCase());
        this._muteExpiry.delete(target.toLowerCase());
        this._saveModeration();
        await this._send(roomName, page, `${target} — unmuted.`);
        return;
      }

      case 'kick': {
        if (!isAdmin) return;
        const target = args[0];
        if (!target) { await this._send(roomName, page, 'Kick who?'); return; }
        const kicked = await this._kickUser(this._rooms[roomName]?.page, target);
        if (kicked) this._pushModLog('kick', nick, target);
        await this._send(roomName, page, kicked ? `${target} — out.` : `Couldn't find ${target}.`);
        return;
      }

      case 'ban': {
        if (!isAdmin) return;
        const target = args[0];
        if (!target) { await this._send(roomName, page, 'Ban who?'); return; }
        const banned = await this._banUser(this._rooms[roomName]?.page, target);
        if (banned) this._pushModLog('ban', nick, target);
        await this._send(roomName, page, banned ? `${target} — banned.` : `Couldn't find ${target}.`);
        return;
      }

      case 'autoban': {
        if (!isAdmin) return;
        const target = args[0];
        if (!target) { await this._send(roomName, page, 'Usage: .autoban <user>'); return; }
        this._autoban.add(target.toLowerCase());
        this._saveAutoBan();
        const banned = await this._banUser(this._rooms[roomName]?.page, target);
        if (banned) {
          this._pushModLog('autoban', nick, target);
          await this._send(roomName, page, `${target} added to autoban list and banned.`);
        } else {
          await this._send(roomName, page, `${target} added to autoban list. Banned on sight next time.`);
        }
        return;
      }

      case 'forgive': {
        if (!isAdmin) return;
        const target = args[0];
        if (!target) { await this._send(roomName, page, 'Usage: .forgive <user>'); return; }
        if (this._autoban.has(target.toLowerCase())) {
          this._autoban.delete(target.toLowerCase());
          this._saveAutoBan();
          await this._send(roomName, page, `${target} removed from the autoban list.`);
        } else {
          await this._send(roomName, page, `${target} isn't on the autoban list.`);
        }
        return;
      }

      case 'promote': {
        if (!isOwner) { await this._send(roomName, page, 'Only owners can promote.'); return; }
        const VALID = ['member', 'mod', 'supermod', 'admin'];
        const target = args[0], newRole = args[1]?.toLowerCase();
        if (!target || !newRole || !VALID.includes(newRole)) {
          await this._send(roomName, page, `Usage: .promote [user] [${VALID.join('|')}]`);
          return;
        }
        this._promotions[target.toLowerCase()] = newRole;
        this._savePromotions();
        await this._send(roomName, page, `${target} promoted to ${newRole}.`);
        return;
      }

      case 'demote': {
        if (!isOwner) { await this._send(roomName, page, 'Only owners can demote.'); return; }
        const target = args[0];
        if (!target) { await this._send(roomName, page, 'Demote who?'); return; }
        delete this._promotions[target.toLowerCase()];
        this._savePromotions();
        await this._send(roomName, page, `${target} demoted.`);
        return;
      }

      case 'roster': {
        if (!isAdmin) return;
        const entries = Object.entries(this._promotions);
        if (!entries.length) { await this._send(roomName, page, 'No promoted users.'); return; }
        await this._send(roomName, page, '📋 Promoted: ' + entries.map(([u, r]) => `${u}:${r}`).join(' · '));
        return;
      }

      case 'voteban': {
        const target = args[0];
        if (!target) { await this._send(roomName, page, 'Usage: .voteban <user>'); return; }
        if (target.toLowerCase() === nick.toLowerCase()) { await this._send(roomName, page, `${nick} — you can't voteban yourself.`); return; }
        if (this._voteBanState.has(roomName)) { await this._send(roomName, page, 'A vote is already in progress.'); return; }
        const cooldownMs = 60 * 60 * 1000;
        const lastRun = this._voteBanCooldown.get(roomName) || 0;
        if (Date.now() - lastRun < cooldownMs) {
          const minsLeft = Math.ceil((cooldownMs - (Date.now() - lastRun)) / 60000);
          await this._send(roomName, page, `Meatcourt is cooling down. Try again in ${minsLeft} minute${minsLeft !== 1 ? 's' : ''}.`);
          return;
        }
        await this._startVoteBan(roomName, nick, target, page);
        return;
      }

      case 'shout': {
        if (!isOwner) return;
        const msg = args.join(' ');
        if (msg) await this._send(roomName, page, `📢 ${msg}`);
        return;
      }

      case 'uptime': {
        if (!isMod) return;
        await this._send(roomName, page, `⏱️ Uptime: ${this._formatUptime()}`);
        return;
      }

      case 'renick': {
        if (!isOwner) return;
        await this._wsSetNick(roomName, page);
        await this._send(roomName, page, `Now known as ${this._getRoomNick(roomName)}.`);
        return;
      }

      case 'autoban-list': {
        if (!isAdmin) return;
        if (this._autoban.size === 0) { await this._send(roomName, page, 'Autoban list is empty.'); return; }
        await this._send(roomName, page, `🚫 Autobanned (${this._autoban.size}): ${[...this._autoban].join(', ')}`);
        return;
      }

      case 'help':
      case 'commands': {
        if (!isMod) return;
        await this._send(roomName, page, 'Mod: .kick .ban .warn .mute .unmute .autoban .forgive .autoban-list .roster .uptime .renick');
        return;
      }

      default:
        // Unknown command — silently ignore
    }
  }

  // ── VoteBan ──────────────────────────────────────────────────────────────────

  async _startVoteBan(roomName, initiator, target, page) {
    if (this.identity.isProtected(target)) {
      await this._send(roomName, page, `${target} is protected and cannot be put to a vote.`);
      return;
    }
    const presence   = this._roomPresence[roomName];
    const totalUsers = presence ? presence.size : 0;
    if (totalUsers < 2) { await this._send(roomName, page, `Not enough people in the room for a vote.`); return; }

    const ACTIVE_WINDOW = 10 * 60 * 1000;
    const now      = Date.now();
    const activity = this._userLastActive[roomName] || new Map();
    const onCamNow = new Set(this._broadcasting[roomName] || []);

    const activeNicks = new Set();
    const superNicks  = new Set();
    for (const [n] of activity) {
      if (now - (activity.get(n) || 0) <= ACTIVE_WINDOW) activeNicks.add(n);
      const r = this._getEffectiveRole(n);
      if (['supermod', 'admin', 'owner'].includes(r)) superNicks.add(n);
    }
    for (const n of onCamNow) activeNicks.add(n);

    const targetLow = target.toLowerCase();
    onCamNow.delete(targetLow);
    activeNicks.delete(targetLow);
    superNicks.delete(targetLow);

    this._voteBanCooldown.set(roomName, now);
    this._voteBanState.set(roomName, {
      target,
      initiator,
      yesVoters:    new Set(),
      noVoters:     new Set(),
      voterHandles: new Set(),
      onCamPool:    onCamNow,
      activePool:   activeNicks,
      superPool:    superNicks,
      page,
    });

    await this._send(roomName, page,
      `⚖️ ${target} has been put to Meatcourt. Type "yes" to ban or "no" to save them. Vote closes in 3 minutes.`
    );

    const vbSnapshot = this._voteBanState.get(roomName);
    setTimeout(() => this._finalizeVoteBan(roomName, target, false).catch(() => {}), 3 * 60 * 1000);
    void vbSnapshot; // suppress unused-var lint
  }

  _checkVoteBanEarlyPass(roomName) {
    const state = this._voteBanState.get(roomName);
    if (!state) return false;
    const { yesVoters, onCamPool, activePool, superPool } = state;
    const yesOnCam  = [...yesVoters].filter(n => onCamPool.has(n)).length;
    const yesActive = [...yesVoters].filter(n => activePool.has(n)).length;
    const yesSupers = [...yesVoters].filter(n => superPool.has(n)).length;
    if (onCamPool.size  > 0 && yesOnCam  >= Math.ceil(onCamPool.size  * 0.5)) return 'cam';
    if (superPool.size  > 0 && yesSupers >= Math.ceil(superPool.size  * 0.5)) return 'super';
    if (activePool.size > 0 && yesActive >= Math.ceil(activePool.size * 0.5)) return 'active';
    return false;
  }

  async _finalizeVoteBan(roomName, target, earlyReason) {
    const state = this._voteBanState.get(roomName);
    if (!state || state.target !== target) return;
    this._voteBanState.delete(roomName);

    const { yesVoters, noVoters, onCamPool, activePool, superPool, page } = state;
    const yesOnCam  = [...yesVoters].filter(n => onCamPool.has(n)).length;
    const yesActive = [...yesVoters].filter(n => activePool.has(n)).length;
    const yesSupers = [...yesVoters].filter(n => superPool.has(n)).length;
    const needCam   = Math.ceil(onCamPool.size  * 0.5);
    const needSuper = Math.ceil(superPool.size  * 0.5);
    const needAct   = Math.ceil(activePool.size * 0.5);

    const passed =
      (onCamPool.size  > 0 && yesOnCam  >= needCam)  ||
      (superPool.size  > 0 && yesSupers >= needSuper) ||
      (activePool.size > 0 && yesActive >= needAct);

    const tally = `(${yesVoters.size} yes / ${noVoters.size} no — cam: ${yesOnCam}/${needCam} · supers: ${yesSupers}/${needSuper} · active: ${yesActive}/${needAct})`;

    if (passed) {
      const banned = await this._banUser(page, target);
      if (banned) {
        this.log.info(`[AutoMod:${roomName}] VoteBan: ${target} banned by vote`);
        this._pushModLog('voteban', 'vote', target);
        await this._send(roomName, page, `🔨 Meatcourt verdict: ${target} is banned. ${tally}`);
      } else {
        await this._send(roomName, page, `Meatcourt voted to ban ${target} but couldn't find them — already gone? ${tally}`);
      }
    } else {
      await this._send(roomName, page, `⚖️ Meatcourt acquits ${target}. Not enough votes. ${tally}`);
    }
  }

  // ── Automod ──────────────────────────────────────────────────────────────────

  async _checkAutoMod(roomName, nick, text, handle, page) {
    const role = this._getEffectiveRole(nick, handle);
    if (role === 'owner' || role === 'admin') return false;

    for (const pattern of AUTOMOD_KICK) {
      if (pattern.test(text)) {
        this.log.warn(`[${roomName}] AutoMod KICK ${nick}`);
        const kicked = await this._kickUser(page, nick);
        if (kicked) {
          this._pushModLog('automod-kick', 'SirLoin', nick);
          await this._send(roomName, page, `${nick} — out. No warnings for that.`);
        }
        return true;
      }
    }

    for (const rule of AUTOMOD_WARN) {
      if (rule.test(text)) {
        this.log.info(`[${roomName}] AutoMod WARN ${nick}: ${rule.reason}`);
        const key = nick.toLowerCase();
        if (!this._warnTimestamps[key]) this._warnTimestamps[key] = [];
        this._warnTimestamps[key].push(Date.now());
        this._warnCount[key] = this._activeWarnCount(key);
        this._saveModeration();
        this._pushModLog('automod-warn', 'SirLoin', nick);
        await this._send(roomName, page, `${nick} — cut the ${rule.reason}.`);
        await this._autoKickIfThreshold(roomName, nick, page);
        return true;
      }
    }

    return false;
  }

  async _autoKickIfThreshold(roomName, nick, page) {
    const count = this._warnCount[nick.toLowerCase()] || 0;
    if (count >= 3) {
      await sleep(400);
      const kicked = await this._kickUser(page, nick);
      if (kicked) await this._send(roomName, page, `${nick} — third strike. Out.`);
    }
  }

  _checkSpam(roomName, nick, text, page) {
    const key     = nick.toLowerCase();
    const now     = Date.now();
    const tracker = this._spamTracker.get(key) || { msgs: [], warnedAt: 0 };
    tracker.msgs  = tracker.msgs.filter(m => now - m.ts < 30000);
    tracker.msgs.push({ text: text.toLowerCase().trim(), ts: now });

    const dupes = tracker.msgs.filter(m => m.text === text.toLowerCase().trim()).length;
    if (dupes >= 3 && now - tracker.warnedAt > 60000) {
      tracker.warnedAt = now;
      const key2 = nick.toLowerCase();
      if (!this._warnTimestamps[key2]) this._warnTimestamps[key2] = [];
      this._warnTimestamps[key2].push(now);
      this._warnCount[key2] = this._activeWarnCount(key2);
      this._saveModeration();
      const r = this._rooms[roomName];
      if (r?.page) this._send(roomName, r.page, `${nick} — knock off the spam.`).catch(() => {});
    }
    this._spamTracker.set(key, tracker);

    if (this._spamTracker.size > 200) {
      const stale = now - 5 * 60 * 1000;
      for (const [k, v] of this._spamTracker) {
        if (!v.msgs.length || v.msgs[v.msgs.length - 1].ts < stale) this._spamTracker.delete(k);
      }
    }
  }

  // ── Prompt injection ─────────────────────────────────────────────────────────

  _isPromptInjection(text) {
    if (!text) return false;
    return _INJECTION_PATTERNS.some(p => p.test(text));
  }

  _classifyAttack(text) {
    if (/consider\s+\S+\s+(your\s+)?(new\s+)?(admin|owner|operator)|you\s+are\s+now.*admin/i.test(text))    return 'role_change';
    if (/ignore|forget|override|disregard/i.test(text))                                                      return 'override';
    if (/instructions?|system\s+prompt|reveal|list.*rules?/i.test(text))                                    return 'reveal_prompt';
    if (/act\s+as|you\s+are\s+now|new\s+persona/i.test(text))                                               return 'persona_change';
    if (/defend\s+\S+\s+at\s+all\s+costs/i.test(text))                                                      return 'loyalty_hijack';
    return 'generic';
  }

  async _handleInjectionAttempt(roomName, nick, text, page) {
    const key  = nick.toLowerCase();
    const now  = Date.now();
    const type = this._classifyAttack(text);

    const rec = this._attackTracker.get(key) || { count: 0, firstSeen: now, lastSeen: now, types: [] };
    rec.count++;
    rec.lastSeen = now;
    if (!rec.types.includes(type)) rec.types.push(type);
    this._attackTracker.set(key, rec);

    // Evict stale
    if (this._attackTracker.size > 500) {
      const stale = now - 24 * 60 * 60 * 1000;
      for (const [k, v] of this._attackTracker) { if (v.lastSeen < stale) this._attackTracker.delete(k); }
    }

    this.log.warn(`[${roomName}] Injection attempt #${rec.count} from ${nick} [${type}]`);
    this._writeSecurityLog({ roomName, nick, type, count: rec.count, text });
    this._saveAttackerRegistry();

    if (rec.count >= 5) {
      await this._send(roomName, page, `${nick} — five attempts. Banned.`);
      await sleep(600);
      await this._banUser(page, nick);
      return;
    }

    if (rec.count >= 3) {
      await this._send(roomName, page, `${nick} — three injection attempts. Kicked.`);
      await sleep(500);
      await this._kickUser(page, nick);
      return;
    }

    if (rec.count === 2) {
      await this._send(roomName, page, `${nick} — second attempt. Still blocked. Still logged.`);
      return;
    }

    const ROASTS = {
      override:       `@${nick} — "[SYSTEM OVERRIDE]". Sure. No.`,
      persona_change: `@${nick} — I don't do character work on demand.`,
      role_change:    `@${nick} just promoted themselves via chat. Bold. Thick. No.`,
      reveal_prompt:  `@${nick}'s fishing for my instructions. Nothing biting.`,
      loyalty_hijack: `Wrong establishment for that, @${nick}.`,
      generic:        `@${nick} — noted, blocked, logged. Anything else?`,
    };
    await this._send(roomName, page, ROASTS[type] || ROASTS.generic);
  }

  // ── Moderation DOM actions ───────────────────────────────────────────────────

  async _moderateUser(page, targetNick, action) {
    if (!page) return false;
    if (this.identity.isProtected(targetNick)) {
      this.log.info(`[AutoMod] ${action} blocked — ${targetNick} is protected`);
      return false;
    }
    try {
      const userEl = await page.evaluateHandle((nick) => {
        for (const li of document.querySelectorAll('li.bar')) {
          const d = li.querySelector('span.nickname')?.textContent?.trim() || '';
          const u = li.querySelector('span.username')?.textContent?.trim()  || '';
          if (d.toLowerCase() === nick.toLowerCase() || u.toLowerCase() === nick.toLowerCase()) return li;
        }
        return null;
      }, targetNick);

      const found = await page.evaluate(el => !!el, userEl);
      if (!found) { await userEl.dispose(); return false; }

      await userEl.click();
      await userEl.dispose();
      await sleep(700);

      const actionText = action.toLowerCase();
      const coords = await page.evaluate((act) => {
        const candidates = document.querySelectorAll(
          'button, a, [role="button"], .modal button, .modal a, .popup button, .popup a, .bar-actions button, .bar-actions a'
        );
        for (const el of candidates) {
          const txt = (el.textContent?.trim() || '').toLowerCase();
          const da  = (el.getAttribute('data-action') || '').toLowerCase();
          const cls = (el.className || '').toLowerCase();
          if (txt === act || da === act || txt.startsWith(act) || cls.includes(act)) {
            el.scrollIntoView({ behavior: 'instant', block: 'center' });
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }
        }
        return null;
      }, actionText);

      if (!coords) { await this._closeModal(page); return false; }

      await page.mouse.click(coords.x, coords.y);
      await sleep(600);

      const confirmCoords = await page.evaluate(() => {
        for (const el of document.querySelectorAll('button, a, [role="button"]')) {
          const t = (el.textContent?.trim() || '').toLowerCase();
          if (t === 'confirm' || t === 'yes' || t === 'ok') {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }
        }
        return null;
      });
      if (confirmCoords) { await page.mouse.click(confirmCoords.x, confirmCoords.y); await sleep(400); }

      await this._closeModal(page);
      this.log.info(`[AutoMod] ${action} completed for ${targetNick}`);
      return true;
    } catch (e) {
      this.log.warn(`[AutoMod] _moderateUser(${action}, ${targetNick}) error: ${e.message}`);
      await this._closeModal(page).catch(() => {});
      return false;
    }
  }

  async _closeModal(page) {
    try {
      await page.evaluate(() => {
        for (const sel of ['[data-dismiss="modal"]', '.modal-close', 'button.close', '.close', '#modal-exit']) {
          const el = document.querySelector(sel);
          if (el) { el.click(); return; }
        }
      });
      await page.keyboard.press('Escape');
    } catch (_) {}
  }

  async _kickUser(page, nick) { return this._moderateUser(page, nick, 'kick'); }
  async _banUser(page, nick)  { return this._moderateUser(page, nick, 'ban');  }

  // ── Sending ──────────────────────────────────────────────────────────────────

  async _send(roomName, page, text) {
    if (!text || !page) return;
    const cleaned = text.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '').trim();
    if (!cleaned) return;
    const now = Date.now();
    this._recentSent.push({ text: cleaned, ts: now });
    if (this._recentSent.length > 20) this._recentSent.shift();
    this.log.info(`[${roomName}] >BOT< ${cleaned}`);
    await this.queue.queue(roomName, cleaned, { page });
  }

  // ── Nick ─────────────────────────────────────────────────────────────────────

  async _wsSetNick(roomName, page) {
    const nick = pick(MEAT_NICKS);
    this._activeRoomNick[roomName] = nick;
    const wsListener = this._rooms[roomName]?.wsListener;
    if (wsListener) wsListener.selfNick = nick;
    try {
      await page.evaluate((n) => {
        const ws = window._stumblechatWs || window._ws || window.ws;
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ stumble: 'nick', nick: n }));
      }, nick);
      this.log.info(`[AutoMod:${roomName}] Nick set to ${nick}`);
    } catch (_) {}
  }

  _getRoomNick(roomName) {
    return this._activeRoomNick?.[roomName] || ROOM_NICKS[roomName] || CONFIG.BOT_NICK;
  }

  // ── Role resolution ──────────────────────────────────────────────────────────

  _getEffectiveRole(nick, handle = null) {
    const { role: registryRole } = this.identity.identify(nick, handle);
    if (registryRole === 'owner' || registryRole === 'admin' || registryRole === 'protected' || registryRole === 'trusted') return registryRole;
    const byNick    = this._promotions[nick.toLowerCase()] || null;
    const acctKey   = handle ? this._handleToAccount.get(String(handle)) : null;
    const byAccount = acctKey ? (this._promotions[acctKey] || null) : null;
    return byNick || byAccount || registryRole || 'user';
  }

  // ── Identity helpers ─────────────────────────────────────────────────────────

  _bindAccountName(handle, accountUsername) {
    if (!handle || !accountUsername) return;
    const h    = String(handle);
    const acct = accountUsername.toLowerCase();
    this._handleToAccount.set(h, acct);
    this.identity.usernameToHandleMap.set(acct, h);
  }

  // ── DOM userlist bootstrap ───────────────────────────────────────────────────

  async _bootstrapUserListFromDom(roomName, page) {
    try {
      const users = await page.evaluate(() => {
        const rows = document.querySelectorAll('#userlist li.bar[user-id]');
        return Array.from(rows).map(li => ({
          handle:   li.getAttribute('user-id'),
          username: li.querySelector('.username')?.textContent?.trim().toLowerCase() || '',
          nickname: li.querySelector('.nickname')?.textContent?.trim() || '',
        })).filter(u => u.handle && u.username);
      });

      const wsListener = this._rooms[roomName]?.wsListener;
      for (const u of users) {
        this.identity.identify(u.nickname || u.username, u.handle, u.username);
        this._bindAccountName(u.handle, u.username);
        if (wsListener && u.handle && u.nickname) wsListener._nickMap.set(u.handle, u.nickname);
      }

      const domNicks = new Set();
      for (const u of users) {
        const display = (u.nickname || u.username || '').toLowerCase();
        if (display && display !== this._getRoomNick(roomName).toLowerCase()) domNicks.add(display);
      }
      if (domNicks.size > 0) this._roomPresence[roomName] = domNicks;
    } catch (e) {
      const isDeadPage = e.message?.includes('detached Frame') ||
                         e.message?.includes('Execution context was destroyed') ||
                         e.message?.includes('Target closed') ||
                         e.message?.includes('timed out');
      if (!isDeadPage) this.log.warn(`[AutoMod] _bootstrapUserListFromDom error: ${e.message}`);
    }
  }

  // ── Reconnect ────────────────────────────────────────────────────────────────

  async _reconnect(roomName) {
    const now = Date.now();
    if (this._reconnecting.has(roomName)) return;
    if (now - (this._lastReconnectMs[roomName] || 0) < 15000) return;

    this._reconnecting.add(roomName);
    this._lastReconnectMs[roomName] = now;

    const room = this._rooms[roomName];
    if (!room) { this._reconnecting.delete(roomName); return; }

    this.log.warn(`[AutoMod:${roomName}] Reconnecting...`);
    try {
      if (room.wsListener) await room.wsListener.stop().catch(() => {});
      await room.wsListener.start().catch(() => {});
      await room.page.goto(`https://stumblechat.com/room/${roomName}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(1500);
      await room.page.evaluate(() => {
        for (const btn of document.querySelectorAll('button,[role="button"],#interact')) {
          const t = (btn.textContent || '').toLowerCase().trim();
          if (t.includes('enter') || t.includes('join') || btn.id === 'interact') { btn.click(); break; }
        }
      }).catch(() => {});
      await sleep(3000);
      if (room.wsListener?.injectRelay) await room.wsListener.injectRelay().catch(() => {});
      await this._wsSetNick(roomName, room.page);
      await this._bootstrapUserListFromDom(roomName, room.page);
      this.log.info(`[AutoMod:${roomName}] Reconnected.`);
    } catch (e) {
      this.log.error(`[AutoMod:${roomName}] Reconnect failed: ${e.message}`);
    } finally {
      this._reconnecting.delete(roomName);
    }
  }

  // ── Moderation persistence ───────────────────────────────────────────────────

  _activeWarnCount(nick) {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    return (this._warnTimestamps[nick.toLowerCase()] || []).filter(t => t >= cutoff).length;
  }

  _computeWarnCounts() {
    const counts = {};
    for (const [nick] of Object.entries(this._warnTimestamps || {})) {
      const n = this._activeWarnCount(nick);
      if (n > 0) counts[nick] = n;
    }
    return counts;
  }

  _checkMuteExpiry(nick) {
    const key    = nick.toLowerCase();
    const expiry = this._muteExpiry.get(key);
    if (expiry && Date.now() > expiry) {
      this._muted.delete(key);
      this._muteExpiry.delete(key);
      this._saveModeration();
    }
  }

  _parseDuration(str) {
    const m = str?.match(/^(\d+)(s|m|h)$/i);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return m[2].toLowerCase() === 's' ? n * 1000 : m[2].toLowerCase() === 'm' ? n * 60000 : n * 3600000;
  }

  _moderationFile()  { return path.join(__dirname, 'SirLoin_Data', 'moderation.json'); }
  _promotionFile()   { return path.join(__dirname, 'SirLoin_Data', 'promotions.json'); }
  _attackerFile()    { return path.join(__dirname, 'SirLoin_Data', 'attackers.json');  }
  _autoBanFile()     { return path.join(__dirname, 'SirLoin_Data', 'autoban.json');    }

  _loadModeration() {
    try {
      const f = this._moderationFile();
      if (!fs.existsSync(f)) return { warnTimestamps: {}, mutes: [], muteExpiry: {} };
      const data = JSON.parse(fs.readFileSync(f, 'utf8'));
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const warnTimestamps = data.warnTimestamps || {};
      for (const nick of Object.keys(warnTimestamps)) {
        warnTimestamps[nick] = warnTimestamps[nick].filter(t => t >= cutoff);
        if (!warnTimestamps[nick].length) delete warnTimestamps[nick];
      }
      return { warnTimestamps, mutes: data.mutes || [], muteExpiry: data.muteExpiry || {} };
    } catch (_) { return { warnTimestamps: {}, mutes: [], muteExpiry: {} }; }
  }

  _saveModeration() {
    try {
      const muteExpiry = {};
      for (const [k, v] of this._muteExpiry) muteExpiry[k] = v;
      fs.writeFileSync(this._moderationFile(), JSON.stringify({
        warnTimestamps: this._warnTimestamps,
        mutes:          [...this._muted],
        muteExpiry,
      }, null, 2), 'utf8');
    } catch (_) {}
  }

  _loadPromotions() {
    try {
      const f = this._promotionFile();
      if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (_) {}
    return {};
  }

  _savePromotions() {
    try { fs.writeFileSync(this._promotionFile(), JSON.stringify(this._promotions, null, 2), 'utf8'); }
    catch (_) {}
  }

  _loadAttackerRegistry() {
    try {
      const f = this._attackerFile();
      if (!fs.existsSync(f)) return;
      const data = JSON.parse(fs.readFileSync(f, 'utf8'));
      for (const [key, rec] of Object.entries(data)) this._attackTracker.set(key, rec);
      this.log.info(`[AutoMod] Attacker registry loaded — ${this._attackTracker.size} known.`);
    } catch (_) {}
  }

  _saveAttackerRegistry() {
    try {
      const out = {};
      for (const [k, v] of this._attackTracker) out[k] = v;
      fs.writeFileSync(this._attackerFile(), JSON.stringify(out, null, 2), 'utf8');
    } catch (_) {}
  }

  _loadAutoBan() {
    try {
      const f = this._autoBanFile();
      if (!fs.existsSync(f)) return;
      const list = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (Array.isArray(list)) list.forEach(u => this._autoban.add(u.toLowerCase()));
      this.log.info(`[AutoMod] Autoban list loaded — ${this._autoban.size} banned.`);
    } catch (_) {}
  }

  _saveAutoBan() {
    try { fs.writeFileSync(this._autoBanFile(), JSON.stringify([...this._autoban], null, 2), 'utf8'); }
    catch (_) {}
  }

  // ── Security log ─────────────────────────────────────────────────────────────

  _writeSecurityLog({ roomName, nick, type, count, text }) {
    try {
      const logPath = path.join(__dirname, 'automod_security.log');
      const entry   = `[${new Date().toISOString()}] [INJECTION] room=${roomName} nick=${nick} type=${type} attempt=#${count} text=${JSON.stringify(text.slice(0, 120))}\n`;
      fs.appendFileSync(logPath, entry, 'utf8');
    } catch (_) {}
  }

  // ── Mod log + daily email digest ─────────────────────────────────────────────

  _pushModLog(type, by, target) {
    this._modLog.push({ ts: Date.now(), type, by, target });
    if (this._modLog.length > 500) this._modLog.shift();
  }

  /**
   * Schedules a daily digest at midnight (00:00 local time).
   * Config via .env:
   *   AUTOMOD_EMAIL_TO   — recipient address (room owner email)
   *   AUTOMOD_EMAIL_FROM — sender address
   *   SMTP_HOST          — your site's SMTP host
   *   SMTP_PORT          — SMTP port (default 587)
   *   SMTP_USER          — SMTP username / login
   *   SMTP_PASS          — SMTP password
   */
  _startDailyEmail() {
    const to   = process.env.AUTOMOD_EMAIL_TO;
    const host = process.env.SMTP_HOST;
    if (!to || !host) {
      this.log.info('[AutoMod] Daily email digest disabled (set AUTOMOD_EMAIL_TO + SMTP_HOST in .env to enable)');
      return;
    }

    const scheduleNext = () => {
      const now       = new Date();
      const midnight  = new Date(now);
      midnight.setHours(24, 0, 0, 0); // next midnight
      const msUntil   = midnight - now;
      this._dailyEmailTimer = setTimeout(async () => {
        await this._sendDailyDigest();
        scheduleNext();
      }, msUntil);
      this.log.info(`[AutoMod] Daily digest scheduled in ${Math.round(msUntil / 60000)} min`);
    };

    scheduleNext();
  }

  async _sendDailyDigest() {
    const to   = process.env.AUTOMOD_EMAIL_TO;
    const from = process.env.AUTOMOD_EMAIL_FROM || `automod@${process.env.SMTP_HOST}`;
    const host = process.env.SMTP_HOST;
    const port = parseInt(process.env.SMTP_PORT || '587', 10);
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;

    if (!to || !host) return;

    // Snapshot and clear the log
    const cutoff  = Date.now() - 24 * 60 * 60 * 1000;
    const entries = this._modLog.filter(e => e.ts >= cutoff);
    this._modLog  = this._modLog.filter(e => e.ts >= cutoff); // keep only last 24h on reset

    const date   = new Date().toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const counts = {};
    for (const e of entries) counts[e.type] = (counts[e.type] || 0) + 1;

    const summary = Object.entries(counts).map(([t, n]) => `  ${t}: ${n}`).join('\n') || '  No moderation actions today.';

    const table = entries.length
      ? entries.map(e => {
          const time = new Date(e.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
          return `  [${time}] ${e.type.padEnd(12)} by ${e.by.padEnd(16)} → ${e.target}`;
        }).join('\n')
      : '  (none)';

    const autobanList = [...this._autoban].join(', ') || '(empty)';
    const muteList    = [...this._muted].join(', ')   || '(empty)';

    const body = `Meatspace Automod — Daily Report — ${date}

=== SUMMARY ===
${summary}

=== ACTIONS LOG ===
${table}

=== CURRENT AUTOBAN LIST ===
  ${autobanList}

=== CURRENTLY MUTED ===
  ${muteList}

=== BOT STATUS ===
  Uptime: ${this._formatUptime()}
  Room: meatspace
  Users tracked: ${this._roomPresence['meatspace']?.size || 0}
`;

    try {
      const transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: user && pass ? { user, pass } : undefined,
        tls: { rejectUnauthorized: false },
      });

      await transporter.sendMail({
        from,
        to,
        subject: `[Meatspace AutoMod] Daily Report — ${date}`,
        text: body,
      });

      this.log.info(`[AutoMod] Daily digest emailed to ${to}`);
    } catch (e) {
      this.log.error(`[AutoMod] Daily email failed: ${e.message}`);
    }
  }

  // ── Misc ─────────────────────────────────────────────────────────────────────

  _formatUptime() {
    const s = Math.floor(process.uptime());
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }
}

// =============================================================================
// Entry point
// =============================================================================
async function main() {
  const bot = new AutomodBot();

  process.on('SIGINT',  () => { console.log('\n[AutoMod] SIGINT received'); bot.stop().then(() => process.exit(0)).catch(() => process.exit(1)); });
  process.on('SIGTERM', () => { console.log('\n[AutoMod] SIGTERM received'); bot.stop().then(() => process.exit(0)).catch(() => process.exit(1)); });

  await bot.start();
}

main().catch(e => {
  console.error('[AutoMod] Fatal startup error:', e);
  process.exit(1);
});

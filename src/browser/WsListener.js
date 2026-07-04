'use strict';

/**
 * WsListener — attaches a CDP session to a Puppeteer page and fires typed
 * callbacks for every StumbleChat WebSocket event.
 *
 * Callbacks (all optional):
 *   onMessage(roomName, nick, text, handle)
 *   onPvtMessage(roomName, nick, handle, text)
 *   onJoin(roomName, nick, handle)
 *   onJoined(roomName, nick, handle)   ← bot's own entry event
 *   onLeave(roomName, nick, handle)
 *   onNickChange(roomName, oldNick, newNick, handle)
 *   onUserList(roomName, users[])
 *   onRaw(roomName, direction, msg)    ← all parsed frames
 *   onSubscribe(roomName, nick|null, handle)   ← user starts broadcasting
 *   onUnsubscribe(roomName, nick|null, handle) ← user stops broadcasting
 *   onMedia(roomName, {source, action, title, url, handle, nick}) ← youtube/soundcloud play|stop
 *
 * Usage:
 *   const listener = new WsListener(roomName, page, selfNick, callbacks, logger);
 *   await listener.start();
 *   ...
 *   await listener.stop();
 */
class WsListener {
  constructor(roomName, page, selfNick, callbacks = {}, logger) {
    this.roomName   = roomName;
    this.page       = page;
    this.selfNick   = selfNick; // Bot's own nick (to filter own messages)
    this.cb         = callbacks;
    this.log        = logger;

    this._cdpSession   = null;
    this._wsRequestId  = null;   // StumbleChat's WS request ID on CDP
    this._selfHandle   = null;   // Our own numeric handle (set on 'joined' event)
    this._active       = false;

    // Timestamp of last received WS message — used by DOM poll skip logic
    this.lastRecvMs = 0;

    // All WS connections tracked (for diagnostics)
    this._wsConns = [];

    // handle → nick map: StumbleChat msg events don't always include nick,
    // so we populate this from join/joined/userlist/nick events and use it
    // as a fallback when msg.nick is absent.
    this._nickMap    = new Map();
    this._nickMapMax = 5000; // evict oldest entry on overflow

    // Circular frame buffer — last 50 frames for pre-moderation context
    this._frameBuffer    = [];
    this._frameBufferMax = 50;

    // Unknown stumble types seen this session — log each once
    this._discoveredTypes = new Set();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start() {
    try {
      if (this._cdpSession) await this.stop();

      const cdp = await this.page.target().createCDPSession();
      this._cdpSession = cdp;

      await cdp.send('Network.enable');
      await cdp.send('Network.setBlockedURLs', { urls: ['*.map'] }).catch(() => {});

      this._bindEvents(cdp);
      this._active = true;
      this.log?.info(`[WS:${this.roomName}] Listener started`);
    } catch (e) {
      this.log?.error(`[WS:${this.roomName}] Failed to start: ${e.message}`);
      throw e;
    }
  }

  async stop() {
    this._active = false;
    try {
      if (this._cdpSession) {
        await this._cdpSession.detach();
      }
    } catch (_) {}
    this._cdpSession = null;
    this._wsRequestId = null;
    this.log?.info(`[WS:${this.roomName}] Listener stopped`);
  }

  get isActive()      { return this._active; }

  /** True only when the StumbleChat WebSocket itself is open (not just the CDP session). */
  get isWsConnected() { return this._wsRequestId !== null; }

  /** Returns the last n frames from the buffer (default 20) — pre-moderation context */
  getFrameContext(n = 20) {
    return this._frameBuffer.slice(-n);
  }

  /** Returns all new stumble types discovered this session */
  getDiscoveries() {
    return Array.from(this._discoveredTypes);
  }

  _recordFrame(direction, msg) {
    this._frameBuffer.push({ ts: Date.now(), direction, type: msg.stumble || '?', msg });
    if (this._frameBuffer.length > this._frameBufferMax) this._frameBuffer.shift();
  }

  _nickSet(handle, nick) {
    this._nickMap.set(handle, nick);
    if (this._nickMap.size > this._nickMapMax) {
      this._nickMap.delete(this._nickMap.keys().next().value);
    }
  }

  // ── Pre-navigation setup (call BEFORE page.goto) ──────────────────────────

  /**
   * Register exposeFunction + evaluateOnNewDocument BEFORE page.goto().
   * This ensures the WebSocket constructor hook is in place before StumbleChat's
   * scripts run, catching the WS even when it's closure-scoped (not on window).
   */
  async preNavigate() {
    try {
      // Track ALL WebSocket instances before the page scripts run.
      // Does NOT forward messages here — exposeFunction bindings race with evaluateOnNewDocument.
      // injectRelay() (called post-load) adds the actual message listeners.
      await this.page.evaluateOnNewDocument(() => {
        window._allWebSockets = [];
        const OrigWebSocket = window.WebSocket;
        window.WebSocket = new Proxy(OrigWebSocket, {
          construct(target, args) {
            const ws = new target(...args);
            window._allWebSockets.push(ws);
            const isStumble = args[0] && String(args[0]).includes('stumblechat');
            if (isStumble) window._stumblechatWs = ws;
            ws.addEventListener('open', () => {
              if (ws.url && ws.url.includes('stumblechat')) window._stumblechatWs = ws;
            });
            return ws;
          },
        });
      });

      this.log?.info(`[WS:${this.roomName}] Pre-navigate hooks registered`);
    } catch (e) {
      this.log?.warn(`[WS:${this.roomName}] Pre-navigate setup failed: ${e.message}`);
    }
  }

  // ── Script-injection relay (more reliable than CDP for existing WS) ────────

  /**
   * Add message listeners to WS instances captured by preNavigate().
   * Call AFTER page.goto() so exposeFunction binding is guaranteed available.
   * Also hooks the constructor for any future WS connections.
   */
  async injectRelay() {
    try {
      // Register Node.js callback — exposeFunction binding is safe post-navigation.
      // The relay ONLY updates lastRecvMs (heartbeat for watchdog) — CDP is the
      // authoritative dispatch path. Having both dispatch would double-process everything.
      await this.page.exposeFunction('__zombWsRecv', (dataStr) => {
        try {
          const msg = JSON.parse(dataStr);
          this.lastRecvMs = Date.now();
          // Only dispatch if CDP is NOT active (fallback mode)
          if (!this._wsRequestId) {
            this.cb.onRaw?.(this.roomName, 'recv', msg);
            this._dispatch(msg);
          }
        } catch (_) {}
      }).catch(() => {});

      // Patch all WS instances tracked by preNavigate() Proxy
      const diag = await this.page.evaluate(() => {
        const patch = (ws) => {
          if (!ws || ws.__zombPatched) return false;
          ws.__zombPatched = true;
          ws.addEventListener('message', (evt) => {
            try { window.__zombWsRecv(evt.data); } catch (_) {}
          });
          return true;
        };

        let patched = 0;
        for (const ws of (window._allWebSockets || [])) {
          if (patch(ws)) patched++;
        }
        // Also patch _stumblechatWs directly in case it was set via 'open' event
        if (patch(window._stumblechatWs)) patched++;

        const d = {
          allWs   : (window._allWebSockets || []).length,
          scState : window._stumblechatWs?.readyState ?? -1,
          patched,
          url     : location.href.slice(0, 60),
        };

        // Hook constructor for any future WS (reconnects, etc.)
        if (!window.__zombWsHooked) {
          window.__zombWsHooked = true;
          const Native = window.WebSocket;
          window.WebSocket = function (...args) {
            const ws = new Native(...args);
            // Track in _allWebSockets so _wsSend can find it after a late connect
            if (!window._allWebSockets) window._allWebSockets = [];
            window._allWebSockets.push(ws);
            // Set _stumblechatWs when the connection opens
            if (args[0] && String(args[0]).includes('stumblechat')) {
              ws.addEventListener('open', () => { window._stumblechatWs = ws; });
            }
            setTimeout(() => patch(ws), 200);
            return ws;
          };
          window.WebSocket.prototype   = Native.prototype;
          window.WebSocket.CONNECTING  = Native.CONNECTING;
          window.WebSocket.OPEN        = Native.OPEN;
          window.WebSocket.CLOSING     = Native.CLOSING;
          window.WebSocket.CLOSED      = Native.CLOSED;
        }

        return d;
      });

      this.log?.info(`[WS:${this.roomName}] Relay injected — ${JSON.stringify(diag)}`);
    } catch (e) {
      this.log?.warn(`[WS:${this.roomName}] Relay inject failed: ${e.message}`);
    }
  }

  // ── CDP event binding ─────────────────────────────────────────────────────

  _bindEvents(cdp) {
    cdp.on('Network.webSocketCreated', ({ requestId, url }) => {
      const info = {
        requestId, url,
        status    : 'created',
        createdAt : Date.now(),
        isStumbleChat: url.includes('stumblechat'),
      };
      this._wsConns.push(info);
      if (this._wsConns.length > 50) this._wsConns.shift();

      if (info.isStumbleChat) {
        const isReconnect = !!this._wsRequestId; // true when replacing an existing WS
        this._wsRequestId = requestId;
        this.lastRecvMs   = Date.now();
        // Reset self-handle so the new joined/nick event re-identifies us with the new handle
        this._selfHandle  = null;
        this.log?.info(`[WS:${this.roomName}] StumbleChat WS ${isReconnect ? 'reconnected' : 'detected'}: ${url}`);
        if (isReconnect) this.cb.onReconnected?.(this.roomName);
      }
    });

    cdp.on('Network.webSocketFrameSent', ({ requestId, response }) => {
      const data = response.payloadData;
      if (!data || data === '0') return;
      if (this._wsRequestId && requestId !== this._wsRequestId) return;
      try {
        const msg = JSON.parse(data);
        this._recordFrame('sent', msg);
        this.cb.onRaw?.(this.roomName, 'sent', msg);
      } catch (_) {}
    });

    cdp.on('Network.webSocketFrameReceived', ({ requestId, response }) => {
      const data = response.payloadData;
      if (!data || data === '0') return;
      if (this._wsRequestId && requestId !== this._wsRequestId) return;

      this.lastRecvMs = Date.now();

      try {
        const msg = JSON.parse(data);
        // Temporary diagnostic: log ALL stumble types with key fields
        if (msg.stumble) {
          const diag = { type: msg.stumble };
          if (msg.handle) diag.handle = msg.handle;
          if (msg.nick)   diag.nick   = msg.nick;
          if (msg.users)  diag.userCount = msg.users.length;
          this.log?.debug(`[WS:${this.roomName}] RECV ${JSON.stringify(diag)}`);
        }
        this._recordFrame('recv', msg);
        this.cb.onRaw?.(this.roomName, 'recv', msg);
        this._dispatch(msg);
      } catch (e) {
        this.log?.debug(`[WS:${this.roomName}] RECV non-JSON (${data.length} chars): ${data.slice(0, 60)}`);
      }
    });

    cdp.on('Network.webSocketClosed', ({ requestId }) => {
      if (requestId !== this._wsRequestId) return;
      this.log?.warn(`[WS:${this.roomName}] StumbleChat WS closed`);
      this._wsRequestId = null;
      this.cb.onClosed?.(this.roomName);
    });
  }

  // ── Message dispatch ──────────────────────────────────────────────────────

  _dispatch(msg) {
    const t = msg.stumble;
    if (!t) return;

    // Room closed by server (ban/kick/server-side disconnect)
    if (t === 'closed') {
      this.log?.warn(`[WS:${this.roomName}] Room closed by server`);
      this.cb.onClosed?.(this.roomName);
      return;
    }

    if (t === 'publish') return;

    switch (t) {

      case 'msg': {
        if (!msg.text || !msg.handle) break;
        const h = String(msg.handle);
        // Skip server echoes of our own messages
        if (this._selfHandle && h === this._selfHandle) break;
        // StumbleChat msg events often omit nick — fall back to our handle→nick map
        const nick = msg.nick || this._nickMap.get(h);
        if (!nick) {
          // Unknown handle — trigger an immediate DOM rescan to resolve it.
          // Do NOT dispatch the message: dispatching with a placeholder nick caused
          // the bot to process its own echoed .shop output as .buy commands when
          // _selfHandle wasn't set yet (race on reconnect). The rescan completes
          // within ~1 s; the user's next message will route correctly.
          this.cb.onUnknownHandle?.(this.roomName, h);
          break;
        }
        // Skip the bot itself
        if (nick.toLowerCase() === this.selfNick.toLowerCase()) break;
        // Update map with any fresh nick from the server
        if (msg.nick) this._nickSet(h, msg.nick);
        this.cb.onMessage?.(this.roomName, nick, msg.text, h);
        break;
      }

      case 'pvtmsg': {
        if (!msg.text || !msg.handle) break;
        const h = String(msg.handle);
        const nick = msg.nick || `user_${h}`;
        this.cb.onPvtMessage?.(this.roomName, nick, h, msg.text);
        break;
      }

      case 'join': {
        if (!msg.handle || !msg.nick) break;
        const h = String(msg.handle);
        this._nickSet(h, msg.nick);
        this.cb.onJoin?.(this.roomName, msg.nick, h, msg.username || null, msg.mod ?? 0, {
          guest  : msg.guest  ?? true,
          avatar : msg.avatar || null,
          colors : {
            background  : msg.backgroundcolor     || null,
            nameBg      : msg.namebackgroundcolor || null,
            messageText : msg.messagetextcolor    || null,
          },
        });
        break;
      }

      case 'joined': {
        const rawHandle = msg.handle || msg.self?.handle;
        const rawNick   = msg.nick   || msg.self?.nick || this.selfNick;
        const rawUser   = msg.username || msg.self?.username || null;
        if (!rawHandle) break;
        const h = String(rawHandle);
        this._nickSet(h, rawNick);
        if (!this._selfHandle) {
          this._selfHandle = h;
          this.log?.info(`[WS:${this.roomName}] Bot identified as "${rawNick}" (handle: ${h})`);
        }
        // Seed nickMap from full room snapshot (userlist embedded in joined frame)
        if (Array.isArray(msg.userlist) && msg.userlist.length > 0) {
          for (const u of msg.userlist) {
            if (u.handle && u.nick) this._nickSet(String(u.handle), u.nick);
          }
          const users = msg.userlist.map(u => ({ ...u, username: u.username || null }));
          this.cb.onUserList?.(this.roomName, users);
          this.log?.info(`[WS:${this.roomName}] Bootstrapped ${msg.userlist.length} users from joined frame`);
        }
        this.cb.onJoined?.(this.roomName, rawNick, h, rawUser);
        break;
      }

      case 'leave':
      case 'quit': {
        const h = msg.handle ? String(msg.handle) : null;
        const nick = msg.nick || (h ? this._nickMap.get(h) : null);
        if (h) this._nickMap.delete(h);
        this.cb.onLeave?.(this.roomName, nick || null, h);
        break;
      }

      case 'nick': {
        // Nick change event: { stumble:'nick', handle, nick (new), 'old-nick' }
        const h = msg.handle ? String(msg.handle) : null;
        if (h && msg.nick) this._nickSet(h, msg.nick);
        // If the new nick matches our own bot nick, this is our identity — capture our handle
        if (h && msg.nick && msg.nick.toLowerCase() === this.selfNick.toLowerCase() && !this._selfHandle) {
          this._selfHandle = h;
          this.log?.info(`[WS:${this.roomName}] Self-handle resolved from nick event: ${h} (${msg.nick})`);
        }
        this.cb.onNickChange?.(this.roomName, msg['old-nick'] || null, msg.nick, h);
        break;
      }

      case 'userlist': {
        if (Array.isArray(msg.users)) {
          // Populate nick map for all present users
          let mapped = 0;
          for (const u of msg.users) {
            if (u.handle && u.nick) { this._nickSet(String(u.handle), u.nick); mapped++; }
          }
          this.log?.info(`[WS:${this.roomName}] Userlist: ${msg.users.length} users, ${mapped} mapped`);
          this.cb.onUserList?.(this.roomName, msg.users);
          // Identify our own handle from the userlist if 'joined' hasn't fired yet
          if (!this._selfHandle) {
            for (const u of msg.users) {
              if (u.nick && u.nick.toLowerCase() === this.selfNick.toLowerCase() && u.handle) {
                this._selfHandle = String(u.handle);
                this.log?.info(`[WS:${this.roomName}] Self-handle resolved from userlist: ${this._selfHandle}`);
              }
            }
          }
        }
        break;
      }

      case 'subscribe': {
        // A user started broadcasting their camera/mic
        if (msg.handle) {
          const h    = String(msg.handle);
          const nick = this._nickMap.get(h) || null;
          if (!nick) this.cb.onUnknownHandle?.(this.roomName, h);
          this.cb.onSubscribe?.(this.roomName, nick, h);
        }
        break;
      }

      case 'unsubscribe': {
        // A user stopped broadcasting
        if (msg.handle) {
          const h    = String(msg.handle);
          const nick = this._nickMap.get(h) || null;
          this.cb.onUnsubscribe?.(this.roomName, nick, h);
        }
        break;
      }

      case 'producers': {
        this.cb.onProducers?.(this.roomName, msg.producers || []);
        break;
      }

      case 'youtube':
      case 'soundcloud': {
        // msg.stumble is just the source name ('youtube'/'soundcloud'); the
        // play-vs-stop distinction lives in msg.type, not in `t` — merged
        // here since these two used to be handled by dead-code cases that
        // never matched (`t` is never e.g. 'soundcloud:play').
        const h = msg.handle ? String(msg.handle) : null;
        this.cb.onMedia?.(this.roomName, {
          source: msg.stumble,
          action: msg.type || null,
          title : msg.title || null,
          url   : msg.url   || null,
          handle: h,
          nick  : h ? this._nickMap.get(h) || null : null,
        });
        break;
      }

      case 'role:moderator': {
        if (!msg.handle) break;
        this.cb.onModRole?.(this.roomName, String(msg.handle), msg.type || null);
        break;
      }

      case 'sysmsg': {
        if (msg.text) {
          this.log?.info(`[WS:${this.roomName}] SysMsg: ${msg.text}`);
          this.cb.onSysMsg?.(this.roomName, msg.text, msg.handle ? String(msg.handle) : null);
        }
        break;
      }

      case 'ban': {
        const h = msg.handle ? String(msg.handle) : null;
        const nick = msg.nick || (h ? this._nickMap.get(h) : null);
        this.log?.warn(`[WS:${this.roomName}] BAN: ${nick || h || '?'}`);
        this.cb.onBan?.(this.roomName, nick || null, h, this.getFrameContext(20));
        break;
      }

      case 'kick': {
        const h = msg.handle ? String(msg.handle) : null;
        const nick = msg.nick || (h ? this._nickMap.get(h) : null);
        this.log?.warn(`[WS:${this.roomName}] KICK: ${nick || h || '?'}`);
        this.cb.onKick?.(this.roomName, nick || null, h, this.getFrameContext(20));
        break;
      }

      case 'mute': {
        const h = msg.handle ? String(msg.handle) : null;
        const nick = msg.nick || (h ? this._nickMap.get(h) : null);
        this.log?.warn(`[WS:${this.roomName}] MUTE: ${nick || h || '?'}`);
        this.cb.onMute?.(this.roomName, nick || null, h);
        break;
      }

      default: {
        if (t && !this._discoveredTypes.has(t)) {
          this._discoveredTypes.add(t);
          this.log?.info(`[WS:${this.roomName}] NEW frame type discovered: "${t}" → ${JSON.stringify(msg)}`);
          this.cb.onNewFrameType?.(this.roomName, t, msg);
        }
        break;
      }
    }
  }
}

module.exports = WsListener;

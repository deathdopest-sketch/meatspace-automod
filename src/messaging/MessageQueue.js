'use strict';

/**
 * MessageQueue — serialized, rate-limited message delivery.
 *
 * Responsibilities:
 * - Split long messages at sentence boundaries
 * - Dedup identical messages within a time window
 * - Rate-limit sends (maxMessagesPerMinute, minGapMs)
 * - Owner bypass for rate limits
 * - Promise-chain serialization so messages arrive in order
 * - WS send via page.evaluate with up to 5 retries
 * - Track recent bot responses for echo detection
 */
class MessageQueue {
  /**
   * @param {Object} rateConfig    — RATE_CONFIG from config/zomb.js
   * @param {Object} identitySystem — IdentitySystem instance (for owner bypass)
   * @param {Object} logger        — Logger instance
   */
  constructor(rateConfig, identitySystem, logger) {
    this.rate     = rateConfig;
    this.identity = identitySystem;
    this.log      = logger;

    // State — per-room send chains so one room's burst doesn't block others
    this._sendChains      = new Map(); // roomName → Promise
    this._lastSendTime    = new Map(); // roomName → timestamp
    this._sendMinGapMs    = rateConfig.minGapMs || 1000;  // base gap (jitter added per-send)
    this._sendJitterMs    = rateConfig.jitterMs  || 700;  // ±random added to min gap
    this._minuteWindowStart  = Date.now();
    this._minuteMessageCount = 0;
    this._lastQueued      = new Map(); // roomName → { text, at }
    this._recentBotResponses  = [];   // [{ text, ts }]
    this._recentConversations = new Map();
    this._recentMessageContent = new Map();

    // Mute state — managed externally or toggled here
    this.globalMute = false;
    this.roomMuted  = new Set();

    // Counters (for stats)
    this.messageCounter = 0;
  }

  // ── Mute helpers ──────────────────────────────────────────────────────────

  mute(roomName)   { if (roomName) this.roomMuted.add(roomName); else this.globalMute = true; }
  unmute(roomName) { if (roomName) this.roomMuted.delete(roomName); else this.globalMute = false; }
  isMuted(roomName) { return this.globalMute || this.roomMuted.has(roomName); }

  // ── Message splitting ─────────────────────────────────────────────────────

  splitMessage(text, maxLen = 350) {
    if (!text || text.length <= maxLen) return [text];
    const parts = [];
    let remaining = text;
    while (remaining.length > maxLen) {
      const chunk = remaining.substring(0, maxLen);
      let splitAt = -1;
      for (let i = chunk.length - 1; i >= 50; i--) {
        if ('.!?'.includes(chunk[i]) && (i + 1 >= chunk.length || chunk[i + 1] === ' ' || chunk[i + 1] === '\n')) {
          splitAt = i + 1;
          break;
        }
      }
      if (splitAt === -1) {
        splitAt = chunk.lastIndexOf(' ');
        if (splitAt < 50) splitAt = maxLen;
      }
      parts.push(remaining.substring(0, splitAt).trim());
      remaining = remaining.substring(splitAt).trim();
    }
    if (remaining.length > 0) parts.push(remaining);
    return parts.filter(Boolean);
  }

  // ── Rate limiting ─────────────────────────────────────────────────────────

  _checkRateLimit(username) {
    const now = Date.now();
    if (now - this._minuteWindowStart > 60000) {
      this._minuteMessageCount = 0;
      this._minuteWindowStart  = now;
    }
    if (username && this.identity?.isOwner(username)) return true;
    return this._minuteMessageCount < (this.rate.maxMessagesPerMinute || 20);
  }

  // ── Response tracking ─────────────────────────────────────────────────────

  trackResponse(text) {
    const now = Date.now();
    this._recentBotResponses.push({ text: text.toLowerCase().trim(), ts: now });
    this._recentBotResponses = this._recentBotResponses.filter(r => now - r.ts < 300000);
  }

  isEcho(content) {
    const lower = content.toLowerCase().trim();
    if (lower.startsWith('.') || lower.startsWith('!') || lower.startsWith('/')) return false;
    if (lower.length < 40) return false;
    const now = Date.now();
    for (const r of this._recentBotResponses) {
      if (now - r.ts > 300000) continue;
      if (r.text === lower) return true;
      const shorter = Math.min(lower.length, r.text.length);
      if (shorter >= 40 && r.text.includes(lower) && lower.length / r.text.length > 0.6) return true;
      if (shorter >= 40 && lower.includes(r.text) && r.text.length / lower.length > 0.6) return true;
    }
    return false;
  }

  isDuplicateResponse(text) {
    const lower = text.toLowerCase().trim();
    const now   = Date.now();
    for (const r of this._recentBotResponses) {
      if (now - r.ts > 60000) continue;
      if (r.text === lower) return true;
    }
    return false;
  }

  // ── Main queue API ────────────────────────────────────────────────────────

  /**
   * Queue a message to a room — serialised, rate-limited, deduped.
   *
   * @param {string} roomName
   * @param {string} text
   * @param {Object} opts
   *   opts.force       — bypass mute + rate limit (command responses)
   *   opts.noSplit     — send as single chunk regardless of length
   *   opts.psychProfile — split at 350 with 4.5s inter-part delay
   *   opts.username    — for per-user rate limit checks
   *   opts.page        — Puppeteer page to send on (required)
   *   opts.rooms       — Map of roomName→{page} (alternative to opts.page)
   *   opts.onSent      — callback(roomName, text) after each successful send
   */
  async queue(roomName, text, opts = {}) {
    if (!text) return;

    if (this.isMuted(roomName) && !opts.force) {
      this.log?.debug(`[${roomName}] Muted, suppressing: ${text.substring(0, 50)}`);
      return;
    }

    let parts;
    if (opts.noSplit) {
      parts = [text];
    } else if (opts.psychProfile) {
      parts = this.splitMessage(text, 350);
    } else {
      parts = this.splitMessage(text);
    }
    const interPartDelay = opts.psychProfile
      ? 3800 + Math.floor(Math.random() * 1400)  // 3.8 – 5.2 s
      :  650 + Math.floor(Math.random() * 700);   // 0.65 – 1.35 s

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];

      // Dedup first part only
      if (i === 0) {
        const now = Date.now();
        const window = opts.force ? 4000 : 1500;
        const last = this._lastQueued.get(roomName);
        if (last && last.text === part && (now - last.at) < window) {
          this.log?.debug(`[${roomName}] Dedup suppressed: ${part.substring(0, 50)}`);
          return;
        }
        this._lastQueued.set(roomName, { text: part, at: now });
      }

      const prev = this._sendChains.get(roomName) || Promise.resolve();
      const next = prev.then(async () => {
        if (!opts.force && !this._checkRateLimit(opts.username)) {
          this.log?.warn(`[${roomName}] Rate limit hit, dropping message`);
          return;
        }

        const elapsed = Date.now() - (this._lastSendTime.get(roomName) || 0);
        const jitter  = Math.floor(Math.random() * this._sendJitterMs);
        const minGap  = this._sendMinGapMs + jitter;

        if (i === 0 && !opts.force) {
          // Simulate composing time before first send (proportional to message length)
          const typeMs = this._typingDelayFor(part);
          const waitMs = Math.max(minGap - elapsed, 0) + typeMs;
          if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
        } else if (elapsed < minGap) {
          await new Promise(r => setTimeout(r, minGap - elapsed));
        }
        if (i > 0) {
          await new Promise(r => setTimeout(r, interPartDelay));
        }

        // Resolve the page to send on
        const page = opts.page || opts.rooms?.get(roomName)?.page;
        if (!page) {
          this.log?.warn(`[${roomName}] No page to send on — dropping: ${part.substring(0, 40)}`);
          return;
        }

        await this._rawSend(roomName, part, page, opts);
        this._lastSendTime.set(roomName, Date.now());
      }).catch(err => {
        this.log?.error(`[${roomName}] Send chain error: ${err.message}`);
      });
      this._sendChains.set(roomName, next);
    }
  }

  // ── WebSocket send ────────────────────────────────────────────────────────

  async _rawSend(roomName, message, page, opts = {}) {
    try {
      const wsSent = await this._wsSend(page, message);

      if (wsSent) {
        this._onSent(roomName, message, opts);
      } else {
        // WS not ready — retry up to 5x with 2s delay
        let sent = false;
        for (let attempt = 1; attempt <= 5; attempt++) {
          await new Promise(r => setTimeout(r, 2000));
          if (await this._wsSend(page, message)) {
            this._onSent(roomName, message, opts);
            this.log?.debug(`[${roomName}] Sent (WS retry ${attempt}): ${message}`);
            sent = true;
            break;
          }
        }
        if (!sent) {
          this.log?.warn(`[${roomName}] WS send failed after retries — dropped: ${message.slice(0, 60)}`);
          this.onDeadChannel?.(roomName);
        }
      }
    } catch (error) {
      this.log?.error(`[${roomName}] Send error: ${error.message}`);
    }
  }

  _wsSend(page, message) {
    return page.evaluate((text) => {
      const ws = window._stumblechatWs || window._ws || window.ws;
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ stumble: 'msg', text }));
        return 'direct';
      }
      if (window._allWebSockets) {
        for (const s of window._allWebSockets) {
          if (s.readyState === 1 && s.url && s.url.includes('stumblechat')) {
            s.send(JSON.stringify({ stumble: 'msg', text }));
            return 'found';
          }
        }
      }
      return false;
    }, message).catch(() => false);
  }

  /**
   * Returns a human-like composing delay based on message length.
   * Simulates reading + typing time before sending.
   */
  _typingDelayFor(text) {
    if (!text) return 200;
    // 18ms per char, capped at 2200ms, min 200ms, plus ±300ms jitter
    const base = Math.max(200, Math.min(text.length * 18, 2200));
    return base + Math.floor(Math.random() * 300);
  }

  _onSent(roomName, message, opts) {
    this.messageCounter++;
    this._minuteMessageCount++;
    this.trackResponse(message);
    // Log via opts.onSent if provided, otherwise fall back to internal logger
    if (opts.onSent) opts.onSent(roomName, message);
    else this.log?.info(`[${roomName}] Sent: ${message}`);
  }
}

module.exports = MessageQueue;

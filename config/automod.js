'use strict';

// =============================================================================
// config/automod.js — meatspace-automod standalone config
// =============================================================================

const path = require('path');

function toInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

const INSTANCE_ID = String(process.env.AUTOMOD_INSTANCE_ID || 'default')
  .replace(/[^a-zA-Z0-9_-]/g, '_');

if (!process.env.AUTOMOD_LOGIN_EMAIL || !process.env.AUTOMOD_LOGIN_PASS) {
  console.error('[AutoMod] Missing credentials — set AUTOMOD_LOGIN_EMAIL and AUTOMOD_LOGIN_PASS in .env');
  process.exit(1);
}

const CONFIG = {
  LOGIN_EMAIL: process.env.AUTOMOD_LOGIN_EMAIL,
  LOGIN_PASS:  process.env.AUTOMOD_LOGIN_PASS,
  BOT_NICK:    process.env.AUTOMOD_BOT_NICK || 'SirLoin_v1',

  HEADLESS:         String(process.env.HEADLESS || '').toLowerCase() === 'true',
  BROWSER_PATH:     process.env.BROWSER_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',

  // IMPORTANT: each running bot needs its own CDP port and Chrome profile.
  // If two bots share these, Puppeteer connects them to the same Chrome session/cookies.
  CDP_DEBUG_PORT:   toInt(process.env.CDP_DEBUG_PORT, 9223),
  CHROME_USER_DATA: process.env.CHROME_USER_DATA || `automod-chrome-${INSTANCE_ID}`,
};

// ── Identity registry ─────────────────────────────────────────────────────────
// accountName = permanent StumbleChat username (never changes even if display nick does)
// role: 'owner' | 'admin' | 'mod' | 'supermod' | 'trusted' | 'protected'

const IDENTITY_REGISTRY = {
  Meatspace: {
    role: 'owner',
    accountName: 'meatspace',
    bootstrapNicks: ['mercurial', 'merc'],
    handles: new Set(),
  },
  Death: {
    role: 'owner',
    accountName: '666kk666',
    bootstrapNicks: ['death', 'killaken', 'killarooo', 'killaaroo', 'killaroo', 'kenneth', 'ra_ist'],
    handles: new Set(),
  },
  freddysparks: {
    role: 'owner',
    accountName: 'freddysparks',
    bootstrapNicks: ['freddysparks', 'freddy'],
    handles: new Set(),
  },
  Zombs: {
    role: 'protected',
    accountName: 'zombitious',
    bootstrapNicks: ['zombv666'],
    handles: new Set(),
  },
  Ivan: {
    role: 'protected',
    accountName: 'ride_operator',
    bootstrapNicks: [],
    handles: new Set(),
  },
  Lilly: {
    role: 'trusted',
    accountName: 'lilly',
    bootstrapNicks: ['lilly'],
    handles: new Set(),
  },
  Illililiiiliii: {
    role: 'mod',
    accountName: 'illililiiiliii',
    bootstrapNicks: ['illililiiiliii', 'lillyxo'],
    handles: new Set(),
  },
  Skitzvicious: {
    role: 'mod',
    accountName: 'skitzvicious',
    bootstrapNicks: ['skitzvicious', '_666_'],
    handles: new Set(),
  },
  Bubbles: {
    role: 'mod',
    accountName: 'bubbles',
    bootstrapNicks: ['bubbles', 'donbundy'],
    handles: new Set(),
  },
};

// ── Fixed authority nick ──────────────────────────────────────────────────────
// Single static nick — no rotation. Overridable via AUTOMOD_BOT_NICK in .env.
const BOT_NICK = process.env.AUTOMOD_BOT_NICK || 'Enforcer';

// MEAT_NICKS kept as single-element array so _wsSetNick (which calls pick()) still works
const MEAT_NICKS = [BOT_NICK];

const ROOM_NICKS = {
  meatspace: BOT_NICK,
};

const RATE_CONFIG = {
  maxMessagesPerMinute:       20,
  minGapMs:                   1200,
  jitterMs:                   700,
  conversationDedupeWindow:   30000,
  messageContentDedupeWindow: 300000,
};

module.exports = { CONFIG, IDENTITY_REGISTRY, MEAT_NICKS, ROOM_NICKS, RATE_CONFIG };

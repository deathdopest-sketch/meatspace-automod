# Meatspace AutoMod

A moderation bot for the StumbleChat "meatspace" room. It logs in with its own
account, joins the room, watches chat over the live WebSocket (not by reading
the screen), and can auto-kick/ban/mute/warn based on rules, plus respond to
mod commands typed in chat.

This guide assumes you've never used Node.js before. If you already know your
way around a terminal and npm, skip to [Quick start](#quick-start).

## What you need before starting

1. **Node.js** (this runs the bot itself — automod.js is a Node.js program).
2. **A copy of this repository** on your machine.
3. **Google Chrome** (or Chromium) installed, and — if you're on Linux — a
   graphical desktop session running (the bot drives a real, visible browser
   window, not a headless one, since StumbleChat is more reliable that way).
4. A StumbleChat account for the bot to log in as (not your own personal
   account — make it a separate one).

## Installing Node.js

**Windows / Mac**: go to [nodejs.org](https://nodejs.org), download the "LTS"
installer, and run it like any other installer. That's it.

**Linux (Debian/Ubuntu, including Chromebook Linux/Crostini)**:
```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs
```

Check it worked:
```bash
node --version   # should print something like v20.x.x
npm --version
```

## Getting the code

If you were given a `.zip`, extract it. Otherwise, with git installed:
```bash
git clone https://github.com/deathdopest-sketch/meatspace-automod.git
cd meatspace-automod
```

## Quick start

```bash
npm install          # downloads the bot's dependencies (Puppeteer, etc.)
cp .env.example .env # your local config — never committed to git
```

Now open `.env` in any text editor and fill in the bot's login:
```
AUTOMOD_LOGIN_EMAIL=your-bot-account-username-or-email
AUTOMOD_LOGIN_PASS=its-password
AUTOMOD_BOT_NICK=WhateverNickYouWant
```

**Important:** if the password contains a `#` character anywhere, wrap it in
quotes:
```
AUTOMOD_LOGIN_PASS="hunter#2"
```
Without quotes, everything from the `#` onward is silently treated as a
comment and gets cut off — the bot will look like it logs in fine but
actually be using a truncated, wrong password. This one is easy to miss since
nothing errors — it just quietly fails.

Then run it:
```bash
npm start
```

A real Chrome window should open, log in, and join the room. Leave the
terminal running — closing it stops the bot. Press `Ctrl+C` in the terminal
to shut it down cleanly.

## Linux: "Could not spawn any browser" / missing library errors

If Chrome fails to launch with errors like `libnspr4.so: cannot open shared
object file`, install Chrome's runtime dependencies:
```bash
sudo apt-get update
sudo apt-get install -y libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
  libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
  libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2 libatspi2.0-0 \
  fonts-liberation libu2f-udev
```

If it launches but immediately fails with DevTools/GPU errors, and you're in
a container/VM without a real GPU, that's usually a broken Wayland/DRM
detection — the bot already forces `--ozone-platform=x11` and
`--use-gl=swiftshader` to work around this, but if you're still stuck, make
sure a graphical session (X11) is actually running and `$DISPLAY` is set.

## Config reference (`.env`)

| Variable | Required? | What it does |
|---|---|---|
| `AUTOMOD_LOGIN_EMAIL` | yes | The bot account's login |
| `AUTOMOD_LOGIN_PASS` | yes | The bot account's password (quote it if it has `#`) |
| `AUTOMOD_BOT_NICK` | no | Nick the bot uses in-room (default: Enforcer) |
| `BROWSER_PATH` | no | Path to a specific Chrome/Chromium binary |
| `AUTOMOD_EMAIL_TO` / `AUTOMOD_EMAIL_FROM` / `SMTP_*` | no | Enables a daily moderation-log email digest |

## Mod commands (typed in chat, prefixed with `.`)

Most of these require the sender to be a promoted mod/admin/owner in the
bot's own permission system (`.promote`), separate from StumbleChat's own
room roles.

| Command | Who | What it does |
|---|---|---|
| `.kick <user>` | mod+ | Kicks a user |
| `.ban <user>` | mod+ | Bans a user |
| `.warn <user>` | mod+ | Issues a warning (auto-kicks after 3) |
| `.mute <user> [duration]` / `.unmute <user>` | mod+ | Mutes/unmutes |
| `.autoban <user>` / `.forgive <user>` / `.autoban-list` | mod+ | Ban-on-sight list |
| `.promote <user> <role>` / `.demote <user>` / `.roster` | owner | Manage bot-level roles |
| `.voteban <user>` | anyone | Starts a community vote to ban someone |
| `.slurfilter on\|off` | mod+ | Toggles the automatic slur-kick filter |
| `.badword add\|remove\|list <word>` | mod+ | Manage extra words that trigger an instant kick |
| `.webcam fake\|real` | mod+ | Switch the bot's own camera between a placeholder graphic and (if present) a real webcam |
| `.afk <user>` | anyone (rate-limited) | Gives a user 3 minutes to type or their broadcast gets closed |
| `.shout <message>` | owner | Sends an announcement |
| `.renick` | owner | Re-applies the bot's configured nickname |
| `.uptime` | mod+ | Shows how long the bot's been running |
| `.help` | mod+ | Lists commands in-chat |

## Stopping / restarting

`Ctrl+C` in the terminal stops it cleanly. If it crashes or Chrome dies
unexpectedly, the bot automatically retries with a short backoff — you
shouldn't need to restart it by hand unless it's been changed to run some
other way (e.g. as a background/daemon process).

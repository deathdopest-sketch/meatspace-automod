'use strict';

const fs   = require('fs');
const path = require('path');

/**
 * Handles all persistence for ZomB — JSON state files, backups, auto-save.
 */
class StorageManager {
  constructor(storageDir, logger) {
    this.storageDir = storageDir;
    this.log = logger;

    this.backupDir     = path.join(storageDir, 'Backups');
    this.activeDir     = path.join(storageDir, 'Active_Memory');
    this.advancedDir   = path.join(storageDir, 'AdvancedMemory');
    this.maxBackups    = 48;

    // Canonical file paths — modules reference these
    this.paths = {
      users:          path.join(this.activeDir, 'zomb_users.json'),
      interactions:   path.join(this.activeDir, 'zomb_interactions.json'),
      state:          path.join(this.activeDir, 'zomb_state.json'),
      commandLog:     path.join(this.activeDir, 'zomb_command_log.json'),
      ownerHandles:   path.join(this.activeDir, 'zomb_owner_handles.json'),
      behaviorRecord: path.join(this.activeDir, 'zomb_behavior_record.json'),
      aiState:        path.join(this.activeDir, 'zomb_ai_state.json'),
      handles:        path.join(this.activeDir, 'zomb_handles.json'),
      trainingData:   path.join(this.activeDir, 'zomb_training_data.jsonl'),
      gameData:       path.join(this.activeDir, 'zomb_game.json'),
      businessTutor:  path.join(this.activeDir, 'sirloin_business_tutor.json'),
      wsLog:          path.join(storageDir,     'zomb_ws.log'),
      botLog:         path.join(storageDir,     'zomb_boot.log'),
    };

    this._autoSaveTimer = null;
    this._backupTimer   = null;
  }

  // ── Directory init ───────────────────────────────────────────────────────────

  init() {
    const dirs = [
      this.storageDir,
      this.backupDir,
      this.activeDir,
      this.advancedDir,
      path.join(this.advancedDir, 'Backups'),
    ];
    for (const d of dirs) {
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    }
    this.log?.info('Storage directories initialised');
  }

  // ── Safe JSON I/O ────────────────────────────────────────────────────────────

  read(filePath, fallback = {}) {
    try {
      if (!fs.existsSync(filePath)) return fallback;
      const raw = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(raw);
    } catch (e) {
      this.log?.warn(`StorageManager.read failed for ${filePath}: ${e.message}`);
      return fallback;
    }
  }

  write(filePath, data) {
    try {
      const tmp = filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, filePath);
      return true;
    } catch (e) {
      this.log?.error(`StorageManager.write failed for ${filePath}: ${e.message}`);
      return false;
    }
  }

  appendJsonl(filePath, record) {
    try {
      fs.appendFileSync(filePath, JSON.stringify(record) + '\n');
    } catch (e) {
      this.log?.warn(`StorageManager.appendJsonl failed: ${e.message}`);
    }
  }

  // ── Auto-save ────────────────────────────────────────────────────────────────

  startAutoSave(saveCallback, intervalMs = 60_000) {
    if (this._autoSaveTimer) clearInterval(this._autoSaveTimer);
    this._autoSaveTimer = setInterval(() => {
      try { saveCallback(); } catch (e) { this.log?.error('Auto-save error: ' + e.message); }
    }, intervalMs);
    this.log?.info(`Auto-save started (every ${intervalMs / 1000}s)`);
  }

  // ── Backup system ────────────────────────────────────────────────────────────

  startBackupSystem(saveCallback, intervalMs = 30 * 60_000) {
    if (this._backupTimer) clearInterval(this._backupTimer);
    this._backupTimer = setInterval(async () => {
      try {
        saveCallback();
        await this.createBackup();
      } catch (e) {
        this.log?.error('Backup error: ' + e.message);
      }
    }, intervalMs);
    this.log?.info(`Backup system started (every ${intervalMs / 60000}m)`);
  }

  async createBackup() {
    const ts   = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(this.backupDir, `backup_${ts}`);
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

    for (const [key, src] of Object.entries(this.paths)) {
      if (!src.endsWith('.json') && !src.endsWith('.jsonl')) continue;
      if (!fs.existsSync(src)) continue;
      try {
        fs.copyFileSync(src, path.join(dest, path.basename(src)));
      } catch (_) {}
    }

    await this.cleanupOldBackups();
    this.log?.info(`Backup created: ${dest}`);
    return dest;
  }

  async cleanupOldBackups() {
    try {
      const entries = fs.readdirSync(this.backupDir)
        .filter(f => f.startsWith('backup_'))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(this.backupDir, f)).mtime }))
        .sort((a, b) => b.mtime - a.mtime);

      const toDelete = entries.slice(this.maxBackups);
      for (const { name } of toDelete) {
        const p = path.join(this.backupDir, name);
        fs.rmSync(p, { recursive: true, force: true });
      }
    } catch (e) {
      this.log?.warn('cleanupOldBackups error: ' + e.message);
    }
  }

  /**
   * Save a named checkpoint (manual snapshot, separate from rolling backups).
   * @param {string} label  short label, e.g. 'pre-update' or 'manual'
   * @returns {Promise<string>} destination directory path
   */
  async createNamedCheckpoint(label = 'manual') {
    const ts   = new Date().toISOString().replace(/[:.]/g, '-');
    const safe = label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 20);
    const dest = path.join(this.backupDir, `checkpoint_${safe}_${ts}`);
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

    for (const src of Object.values(this.paths)) {
      if (!src.endsWith('.json') && !src.endsWith('.jsonl')) continue;
      if (!fs.existsSync(src)) continue;
      try {
        fs.copyFileSync(src, path.join(dest, path.basename(src)));
      } catch (_) {}
    }

    this.log?.info(`Named checkpoint saved: ${dest}`);
    return dest;
  }

  /**
   * List saved named checkpoints (most recent first).
   * @returns {string[]} directory names
   */
  listNamedCheckpoints() {
    try {
      return fs.readdirSync(this.backupDir)
        .filter(f => f.startsWith('checkpoint_'))
        .sort()
        .reverse();
    } catch (_) {
      return [];
    }
  }

  stop() {
    if (this._autoSaveTimer) { clearInterval(this._autoSaveTimer); this._autoSaveTimer = null; }
    if (this._backupTimer)   { clearInterval(this._backupTimer);   this._backupTimer   = null; }
  }
}

module.exports = StorageManager;

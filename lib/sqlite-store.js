/**
 * sqlite-store — Thin SQLite wrapper for storing Claude config history
 *
 * Opens the database per operation to avoid persistent-connection issues.
 */
'use strict';

let Database;
try {
    Database = require('better-sqlite3');
} catch (_) {
    Database = null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS config_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    cache_size INTEGER DEFAULT 0,
    model TEXT DEFAULT '',
    system_prompt TEXT DEFAULT '',
    user_prompt TEXT DEFAULT '',
    response TEXT DEFAULT '',
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    duration_ms INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ch_node ON config_history(node_id);
CREATE INDEX IF NOT EXISTS idx_ch_ts ON config_history(timestamp);
`;

class SqliteStore {
    constructor(dbPath) {
        if (!Database) {
            throw new Error('better-sqlite3 is not installed. Run: npm install better-sqlite3');
        }
        this.dbPath = dbPath;
        this._ensureSchema();
    }

    _ensureSchema() {
        const db = new Database(this.dbPath);
        db.pragma('journal_mode = WAL');
        db.exec(SCHEMA);
        db.close();
    }

    insertRecord(record) {
        const db = new Database(this.dbPath);
        db.pragma('journal_mode = WAL');
        const stmt = db.prepare(`
            INSERT INTO config_history
                (node_id, timestamp, cache_size, model, system_prompt,
                 user_prompt, response, input_tokens, output_tokens, duration_ms)
            VALUES
                (@node_id, @timestamp, @cache_size, @model, @system_prompt,
                 @user_prompt, @response, @input_tokens, @output_tokens, @duration_ms)
        `);
        const result = stmt.run({
            node_id: record.node_id || '',
            timestamp: record.timestamp || Date.now(),
            cache_size: record.cache_size || 0,
            model: record.model || '',
            system_prompt: record.system_prompt || '',
            user_prompt: record.user_prompt || '',
            response: record.response || '',
            input_tokens: record.input_tokens || 0,
            output_tokens: record.output_tokens || 0,
            duration_ms: record.duration_ms || 0
        });
        db.close();
        return result;
    }

    getRecords(nodeId, limit) {
        const db = new Database(this.dbPath);
        db.pragma('journal_mode = WAL');
        const rows = db.prepare(`
            SELECT * FROM config_history
            WHERE node_id = ?
            ORDER BY timestamp DESC
            LIMIT ?
        `).all(nodeId, limit || 50);
        db.close();
        return rows;
    }

    close() {
        this.dbPath = null;
    }
}

module.exports = SqliteStore;

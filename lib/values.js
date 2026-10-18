/**
 * Shared value helpers for nodes that read cache dictionaries or messages.
 *
 * Cache dictionary entries (written by dataops-in) come in two shapes:
 *   wrapped — { payload, ts, metadata, previous }
 *   flat    — the stored msg.payload as-is (scalar, canonical record, device object, ...)
 *
 * extractValue() is THE payload-walking heuristic used package-wide:
 *   payload.value.value (OPC UA Variant) → payload.value (Kepware / canonical record)
 *   → payload.v (Sparkplug B / compact) → payload
 */
'use strict';

/** Walk a payload to its most plausible scalar. */
function extractValue(payload) {
    if (payload === null || payload === undefined) return null;
    if (typeof payload !== 'object' || Array.isArray(payload)) return payload;
    if (payload.value !== null && typeof payload.value === 'object' && 'value' in payload.value) {
        return payload.value.value;
    }
    if ('value' in payload) return payload.value;
    if ('v' in payload) return payload.v;
    return payload;
}

/** True if a dictionary entry has the wrapped { payload, ts, ... } envelope. */
function isWrapped(entry) {
    return entry !== null && typeof entry === 'object' && !Array.isArray(entry)
        && 'payload' in entry && 'ts' in entry;
}

/** Strip the wrapped envelope (if any) and return the stored payload. */
function unwrapEntry(entry) {
    return isWrapped(entry) ? entry.payload : entry;
}

/** Scalar value of a dictionary entry (either shape). Missing → null. */
function entryValue(entry) {
    if (entry === undefined || entry === null) return null;
    return extractValue(unwrapEntry(entry));
}

/** Loose truthiness for trigger tags: booleans, 0/1, "true"/"false", "on"/"off", ... */
function isTruthy(val) {
    if (val === null || val === undefined) return false;
    if (typeof val === 'boolean') return val;
    if (typeof val === 'number') return val !== 0 && !Number.isNaN(val);
    if (typeof val === 'string') {
        const s = val.trim().toLowerCase();
        return s === 'true' || s === '1' || s === 'yes' || s === 'on';
    }
    return !!val;
}

/**
 * Selected columns as [{topic, alias}]. Accepts the JSON `fields` config (string or
 * array); falls back to migrating a legacy comma `keys` string (alias = topic).
 */
function parseFields(fieldsRaw, legacyKeys) {
    let arr = fieldsRaw;
    if (typeof arr === 'string' && arr.trim()) {
        try { arr = JSON.parse(arr); } catch (_) { arr = null; }
    }
    if (Array.isArray(arr) && arr.length > 0) {
        return arr
            .filter(f => f && typeof f === 'object' && f.topic)
            .map(f => ({ topic: String(f.topic), alias: f.alias ? String(f.alias) : String(f.topic) }));
    }
    return parseList(legacyKeys).map(t => ({ topic: t, alias: t }));
}

/** Comma string or array → trimmed non-empty strings. */
function parseList(raw) {
    if (Array.isArray(raw)) return raw.filter(Boolean).map(String);
    if (typeof raw === 'string') return raw.split(',').map(s => s.trim()).filter(Boolean);
    return [];
}

/**
 * Time of a trigger message: msg._epoch (dataops-cron), else msg.timestamp
 * (ISO string or epoch number), else now.
 */
function triggerDate(msg) {
    if (msg && typeof msg._epoch === 'number') return new Date(msg._epoch);
    if (msg && msg.timestamp !== undefined && msg.timestamp !== null) {
        const d = new Date(msg.timestamp);
        if (!isNaN(d.getTime())) return d;
    }
    return new Date();
}

/** Format a Date per a node's tsFormat setting ('iso' | 'epoch'). */
function formatTs(date, tsFormat) {
    return tsFormat === 'epoch' ? date.getTime() : date.toISOString();
}

/**
 * Read the key property from a message. Accepts "topic" or "msg.topic".
 * Returns undefined if missing.
 */
function getMsgKey(RED, msg, keyField) {
    const prop = String(keyField || 'topic').replace(/^msg\./, '');
    return RED.util.getMessageProperty(msg, prop);
}

module.exports = {
    extractValue, isWrapped, unwrapEntry, entryValue,
    isTruthy, parseFields, triggerDate, formatTs, getMsgKey
};

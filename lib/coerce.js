/**
 * Type coercion shared between dataops-transform and dataops-split.
 *
 * `coerce(value, type)` returns the value reshaped to the declared type,
 * or null if it can't be coerced (rather than throwing — a single bad
 * sample shouldn't kill the flow).
 *
 * `inferType(value)` returns a sensible type tag from a runtime value,
 * used when no declared type is available.
 */
'use strict';

function coerce(value, type) {
    if (value === null || value === undefined) return null;
    const t = typeof type === 'string' ? type.toLowerCase() : '';
    switch (t) {
        case 'number':
        case 'double':
        case 'float':
        case 'real': {
            const n = typeof value === 'number' ? value : Number(value);
            return Number.isFinite(n) ? n : null;
        }
        case 'integer':
        case 'int':
        case 'long':
        case 'short': {
            const n = typeof value === 'number' ? value : Number(value);
            return Number.isFinite(n) ? Math.trunc(n) : null;
        }
        case 'boolean':
        case 'bool': {
            if (typeof value === 'boolean') return value;
            if (typeof value === 'number') return value !== 0;
            if (typeof value === 'string') {
                const s = value.trim().toLowerCase();
                if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
                if (s === 'false' || s === '0' || s === 'no' || s === 'off' || s === '') return false;
            }
            return null;
        }
        case 'string':
        case 'text':
        case 'char': {
            if (typeof value === 'string') return value;
            if (typeof value === 'object') {
                try { return JSON.stringify(value); } catch (_) { return null; }
            }
            return String(value);
        }
        case 'object':
        case 'json': {
            if (typeof value === 'object') return value;
            if (typeof value === 'string') {
                try { return JSON.parse(value); } catch (_) { return null; }
            }
            return null;
        }
        default:
            return value;
    }
}

function inferType(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
    if (typeof value === 'string') return 'string';
    if (typeof value === 'object') return 'object';
    return null;
}

module.exports = { coerce, inferType };

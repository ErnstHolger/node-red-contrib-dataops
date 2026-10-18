/**
 * JSONata helpers used by dataops-transform.
 *
 * prepare() compiles an expression via Node-RED and binds lenient overrides:
 *
 *   $eval / $fromJSON — parse JSON strings, pass anything else through.
 *     Claude sees object payloads as JSON strings in the TOON samples and often
 *     writes $eval(payload); the built-in $eval throws on a live object.
 *
 *   $toMillis — accepts "2026-05-30 20:54:56.056+0100" style timestamps (space
 *     separator, colon-less offset) that the built-in rejects with D3110.
 *     Numbers pass through as epoch; unparseable input → undefined so callers
 *     fall back to "now" instead of failing the message.
 */
'use strict';

function fromJSON(v) {
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch (_) { return v; }
}

function toMillis(v) {
    if (v === undefined || v === null) return undefined;
    if (typeof v === 'number') return v;
    const s = String(v).trim();
    const iso = s.replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
    let ms = Date.parse(iso);
    if (isNaN(ms)) ms = Date.parse(s);
    return isNaN(ms) ? undefined : ms;
}

/**
 * Compile an expression. Empty/null → null. Non-string expressions (e.g. a
 * literal `true` from a spec) are JSON-encoded first. Throws on syntax errors.
 */
function prepare(RED, node, expr) {
    if (expr === undefined || expr === null || expr === '') return null;
    const exprStr = typeof expr === 'string' ? expr : JSON.stringify(expr);
    const prepared = RED.util.prepareJSONataExpression(exprStr, node);
    if (typeof prepared.assign === 'function') {
        prepared.assign('fromJSON', fromJSON);
        prepared.assign('eval', fromJSON);
        prepared.assign('toMillis', toMillis);
    }
    return prepared;
}

/** Evaluate a prepared expression against msg; rejects on evaluation error. */
function evaluate(RED, prepared, msg) {
    return new Promise((resolve, reject) => {
        RED.util.evaluateJSONataExpression(prepared, msg, (err, result) => {
            if (err) reject(err); else resolve(result);
        });
    });
}

module.exports = { prepare, evaluate, fromJSON, toMillis };

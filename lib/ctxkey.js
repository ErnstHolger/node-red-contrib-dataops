/**
 * sanitizeKey — make a user-supplied context key safe for Node-RED's
 * context.get/set, which parse the key as a property expression (dot-notation).
 * Spaces, dots, brackets, slashes etc. would throw "Invalid property expression".
 *
 * Replaces every char that isn't [A-Za-z0-9_] with '_'. Applied to every
 * top-level Spec Key / Source Key so all nodes resolve the same dictionary.
 * Entry keys INSIDE a dictionary (topics) are never sanitized.
 *
 *   "my cache"  -> "my_cache"
 *   "plant.a"   -> "plant_a"
 */
'use strict';

function sanitizeKey(key) {
    if (key === undefined || key === null) return '';
    return String(key).trim().replace(/[^a-zA-Z0-9_]/g, '_');
}

module.exports = { sanitizeKey };

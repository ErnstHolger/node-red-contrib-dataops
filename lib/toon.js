/**
 * Token-Oriented Object Notation — minimal tabular encoder/decoder.
 *
 * Format:
 *   <name>[<count>]{<col1>,<col2>,...}:
 *     <row1>
 *     <row2>
 *     ...
 *
 * Each row is comma-separated values. Strings containing commas, quotes,
 * or whitespace are double-quoted with backslash escapes. Numbers,
 * booleans, and `null` are bare. Objects and arrays embedded as cell
 * values are JSON-stringified into a single quoted cell.
 *
 * This implementation is intentionally minimal — only the tabular form is
 * supported. Nested TOON (arrays of arrays, indented sub-tables) is not.
 */
'use strict';

function quoteString(s) {
    if (s === '') return '""';
    if (/[",\r\n\t ]/.test(s)) {
        return '"' + s
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/\n/g, '\\n')
            .replace(/\r/g, '\\r')
            .replace(/\t/g, '\\t') + '"';
    }
    return s;
}

function cellToString(v) {
    if (v === null) return 'null';
    if (v === undefined) return '';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
    if (typeof v === 'string') return quoteString(v);
    try {
        return quoteString(JSON.stringify(v));
    } catch (_) {
        return '""';
    }
}

/**
 * Encode an array of records as a TOON table.
 * @param {string} name - logical table name
 * @param {string[]} columns - ordered column names
 * @param {object[]} rows - records (extra keys ignored; missing keys → empty)
 * @returns {string}
 */
function encodeTable(name, columns, rows) {
    const header = `${name}[${rows.length}]{${columns.join(',')}}:`;
    const lines = [header];
    for (const row of rows) {
        const cells = columns.map(c => cellToString(row[c]));
        lines.push('  ' + cells.join(','));
    }
    return lines.join('\n');
}

/**
 * Parse a TOON table.
 *
 * Permissive:
 *  - strips markdown fences (```toon … ``` or ``` … ```)
 *  - ignores blank lines and surrounding text before the header
 *  - column name comparison is case-insensitive for lookup helpers
 *
 * @returns {{ name: string, count: number, columns: string[], rows: any[][] }}
 */
function decodeTable(input) {
    if (typeof input !== 'string') {
        throw new Error('TOON decode: input must be a string');
    }

    // Strip a single markdown fence if present
    const fenceMatch = input.match(/```(?:toon|TOON)?\s*([\s\S]*?)```/);
    if (fenceMatch) input = fenceMatch[1];

    const lines = input.split(/\r?\n/);
    let headerLine = null;
    let headerIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (/^[A-Za-z_]\w*\[\d+\]\{[^}]+\}:\s*$/.test(t)) {
            headerLine = t;
            headerIdx = i;
            break;
        }
    }
    if (!headerLine) throw new Error('TOON decode: no header line found');

    const m = headerLine.match(/^([A-Za-z_]\w*)\[(\d+)\]\{([^}]+)\}:\s*$/);
    const name = m[1];
    const count = parseInt(m[2], 10);
    const columns = m[3].split(',').map(s => s.trim()).filter(Boolean);

    const rows = [];
    for (let i = headerIdx + 1; i < lines.length && rows.length < count; i++) {
        const line = lines[i];
        if (!line || !line.trim()) continue;
        rows.push(parseRow(line.replace(/^\s+/, ''), columns.length));
    }
    return { name, count, columns, rows };
}

function parseRow(line, expectedLen) {
    const cells = [];
    let i = 0;
    while (i <= line.length) {
        // Skip leading whitespace within a cell
        while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;

        if (i < line.length && line[i] === '"') {
            // Quoted cell
            i++;
            let s = '';
            while (i < line.length) {
                const c = line[i];
                if (c === '\\' && i + 1 < line.length) {
                    const n = line[i + 1];
                    if (n === 'n') s += '\n';
                    else if (n === 'r') s += '\r';
                    else if (n === 't') s += '\t';
                    else s += n;
                    i += 2;
                } else if (c === '"') {
                    i++;
                    break;
                } else {
                    s += c;
                    i++;
                }
            }
            cells.push(s);
            // Skip whitespace after closing quote, before comma
            while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
        } else {
            // Bare token
            let s = '';
            while (i < line.length && line[i] !== ',') {
                s += line[i];
                i++;
            }
            s = s.trim();
            if (s === 'true') cells.push(true);
            else if (s === 'false') cells.push(false);
            else if (s === 'null') cells.push(null);
            else if (s === '') cells.push(null);
            else if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(s)) cells.push(Number(s));
            else cells.push(s);
        }

        if (i >= line.length) break;
        if (line[i] === ',') {
            i++;
            // Trailing comma → empty cell at end
            if (i === line.length) cells.push(null);
        } else {
            break;
        }
    }
    while (cells.length < expectedLen) cells.push(null);
    return cells;
}

/**
 * Helper: convert decoded rows into an array of objects keyed by column name.
 */
function rowsToObjects(decoded) {
    return decoded.rows.map(r => {
        const obj = {};
        for (let i = 0; i < decoded.columns.length; i++) {
            obj[decoded.columns[i]] = r[i];
        }
        return obj;
    });
}

module.exports = { encodeTable, decodeTable, rowsToObjects };

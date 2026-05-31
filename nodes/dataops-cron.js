/**
 * dataops-cron — Cron-style timer trigger.
 *
 * Fires a message on a schedule defined by a 6-field cron expression:
 *
 *     ┌──────────── second        (0 - 59)
 *     │ ┌────────── minute        (0 - 59)
 *     │ │ ┌──────── hour          (0 - 23)
 *     │ │ │ ┌────── day-of-month   (1 - 31)
 *     │ │ │ │ ┌──── month          (1 - 12)
 *     │ │ │ │ │ ┌── day-of-week     (0 - 6, Sun=0; 7 also = Sun)
 *     * * * * * *
 *
 * Each field supports:  *  |  a  |  a-b  |  a-b/n  |  *​/n  |  a,b,c (lists/ranges combined)
 *
 * Output (output 1): { topic, payload, _cron, _tick }  where payload type is configurable
 *   (timestamp / str / num / bool / json / date — like the core inject node).
 *
 * Evaluation: a 1-second tick checks the current local time against the parsed
 * expression. When all six fields match the current second, the node emits.
 */
'use strict';

module.exports = function(RED) {

    const FIELD_RANGES = [
        { name: 'second',     min: 0, max: 59 },
        { name: 'minute',     min: 0, max: 59 },
        { name: 'hour',       min: 0, max: 23 },
        { name: 'dayOfMonth', min: 1, max: 31 },
        { name: 'month',      min: 1, max: 12 },
        { name: 'dayOfWeek',  min: 0, max: 6 }
    ];

    /**
     * Parse one cron field into a Set of allowed integers.
     * Supports: *  a  a-b  a-b/n  *​/n  and comma-separated lists of these.
     */
    function parseField(raw, min, max) {
        const allowed = new Set();
        const parts = String(raw).trim().split(',');

        for (let part of parts) {
            part = part.trim();
            if (part === '') throw new Error('empty field');

            let step = 1;
            const slash = part.indexOf('/');
            if (slash !== -1) {
                step = parseInt(part.slice(slash + 1), 10);
                if (!Number.isInteger(step) || step < 1) throw new Error(`bad step "${part}"`);
                part = part.slice(0, slash);
            }

            let lo, hi;
            if (part === '*') {
                lo = min; hi = max;
            } else if (part.indexOf('-') !== -1) {
                const [a, b] = part.split('-');
                lo = parseInt(a, 10);
                hi = parseInt(b, 10);
            } else {
                lo = hi = parseInt(part, 10);
            }

            if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
                throw new Error(`bad value "${part}"`);
            }
            if (lo < min || hi > max || lo > hi) {
                throw new Error(`value out of range "${part}" (expected ${min}-${max})`);
            }

            for (let v = lo; v <= hi; v += step) allowed.add(v);
        }
        return allowed;
    }

    /**
     * Parse a full 6-field cron expression into an array of Sets.
     * Day-of-week 7 is normalised to 0 (Sunday).
     */
    function parseCron(expr) {
        const fields = String(expr).trim().split(/\s+/);
        if (fields.length !== 6) {
            throw new Error(`expected 6 fields (sec min hour dom mon dow), got ${fields.length}`);
        }
        return FIELD_RANGES.map((r, i) => {
            const set = parseField(fields[i], r.min, r.max);
            if (r.name === 'dayOfWeek' && set.has(7)) set.add(0); // 7 => Sunday
            return set;
        });
    }

    /**
     * Does the given Date match the parsed cron sets?
     * Standard cron semantics: if BOTH dom and dow are restricted (not "*"),
     * a match on EITHER one is sufficient.
     */
    function matches(sets, date, domRestricted, dowRestricted) {
        const [sec, min, hour, dom, mon, dow] = sets;
        if (!sec.has(date.getSeconds()))  return false;
        if (!min.has(date.getMinutes())) return false;
        if (!hour.has(date.getHours()))  return false;
        if (!mon.has(date.getMonth() + 1)) return false;

        const domOk = dom.has(date.getDate());
        const dowOk = dow.has(date.getDay());

        if (domRestricted && dowRestricted) return domOk || dowOk;
        return domOk && dowOk;
    }

    function buildPayload(type, custom, now) {
        switch (type) {
            case 'date':   return now;
            case 'str':    return custom !== undefined ? String(custom) : '';
            case 'num':    return Number(custom) || 0;
            case 'bool':   return custom === 'true' || custom === true;
            case 'json':
                try { return JSON.parse(custom); }
                catch (e) { throw new Error(`invalid JSON payload: ${e.message}`); }
            case 'timestamp':
            default:       return now.getTime();
        }
    }

    function DataOpsCronNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.cronExpr     = (config.cronExpr || '0 * * * * *').trim();
        node.outputTopic  = config.outputTopic || '';
        node.payloadType  = config.payloadType || 'timestamp';
        node.payloadValue = config.payloadValue;

        let sets, domRestricted, dowRestricted;
        try {
            const fields = node.cronExpr.split(/\s+/);
            sets = parseCron(node.cronExpr);
            domRestricted = fields[3] !== '*';
            dowRestricted = fields[5] !== '*';
        } catch (err) {
            node.status({ fill: 'red', shape: 'ring', text: `bad cron: ${err.message}` });
            node.error(`[dataops-cron] invalid expression "${node.cronExpr}": ${err.message}`);
            return;
        }

        let tickCount = 0;
        let lastFiredSecond = -1; // guard against double-fire within the same wall-clock second

        function fire(now) {
            tickCount++;
            let payload;
            try {
                payload = buildPayload(node.payloadType, node.payloadValue, now);
            } catch (err) {
                node.status({ fill: 'red', shape: 'ring', text: 'payload error' });
                node.error(`[dataops-cron] ${err.message}`);
                return;
            }

            const msg = {
                payload: payload,
                timestamp: now.toISOString(),  // string timestamp (ISO 8601)
                _epoch: now.getTime(),         // numeric epoch ms
                _cron: node.cronExpr,
                _tick: tickCount
            };
            if (node.outputTopic) msg.topic = node.outputTopic;

            try {
                node.send([msg, null]);
            } catch (err) {
                node.send([null, { payload: { error: err.message }, _error: true }]);
            }

            const t = now.toTimeString().slice(0, 8);
            node.status({ fill: 'green', shape: 'dot', text: `fired ${t} (#${tickCount})` });
        }

        // Sub-second detection tick. We evaluate the cron against the current
        // second, but the REPORTED time is anchored to the exact second boundary
        // (sec * 1000) — so payload/timestamp are clean epoch ms with .000 ms,
        // not the arbitrary phase at which this tick happened to run.
        const timer = setInterval(() => {
            const now = new Date();
            const sec = Math.floor(now.getTime() / 1000);
            if (sec === lastFiredSecond) return; // already fired this second
            if (matches(sets, now, domRestricted, dowRestricted)) {
                lastFiredSecond = sec;
                fire(new Date(sec * 1000)); // anchored to the second boundary
            }
        }, 250);

        node.status({ fill: 'green', shape: 'ring', text: `scheduled: ${node.cronExpr}` });

        node.on('close', function(done) {
            clearInterval(timer);
            done();
        });
    }

    RED.nodes.registerType('dataops-cron', DataOpsCronNode);
};

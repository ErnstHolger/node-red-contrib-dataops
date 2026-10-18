/**
 * Shared editor UI for node-red-contrib-dataops.
 * Served by Node-RED at resources/node-red-contrib-dataops/dataops-ui.js.
 *
 * DataOpsUI.fieldPicker(node) wires the topic/alias picker used by
 * dataops-runtime. The edit dialog must contain:
 *   #node-input-specScope, #node-input-specKey, #node-input-fields (hidden),
 *   #node-input-keys (hidden, legacy), #dataops-key-refresh, #dataops-key-status,
 *   #dataops-key-filter, #dataops-key-list
 * Selections are stored in #node-input-fields as JSON [{topic, alias}].
 */
(function() {
    'use strict';
    if (window.DataOpsUI) return;

    function fieldPicker(node) {
        // --- selection model: { order: [topic], map: {topic: alias} } ---
        function load() {
            var arr = [];
            try { arr = JSON.parse($('#node-input-fields').val() || '[]'); } catch (e) { arr = []; }
            if (!Array.isArray(arr)) arr = [];
            if (arr.length === 0) { // migrate legacy comma 'keys'
                arr = ($('#node-input-keys').val() || '').split(',')
                    .map(function(s) { return s.trim(); }).filter(Boolean)
                    .map(function(t) { return { topic: t, alias: t }; });
            }
            var map = {};
            arr.forEach(function(f) { if (f && f.topic) map[f.topic] = f.alias || f.topic; });
            return { order: arr.map(function(f) { return f && f.topic; }).filter(Boolean), map: map };
        }
        var sel = load();

        function save() {
            $('#node-input-fields').val(JSON.stringify(sel.order.map(function(t) {
                return { topic: t, alias: sel.map[t] || t };
            })));
            $('#node-input-keys').val('');
        }
        save(); // normalize on open (persists any legacy migration)

        var allKeys = [];
        var lastNote = '';

        function render(keys) {
            var list = $('#dataops-key-list').empty();
            if (!allKeys.length) {
                list.append($('<div>', { style: 'color:#a00;font-size:0.85em;' }).text(lastNote || 'No topics found.'));
                return;
            }
            if (!keys.length) {
                list.append($('<div>', { style: 'color:#999;font-size:0.85em;' }).text('No topics match the filter.'));
                return;
            }
            var hdr = $('<div>', { style: 'display:flex;align-items:center;font-size:0.8em;color:#999;border-bottom:1px solid #eee;padding-bottom:3px;margin-bottom:3px;' });
            $('<span>', { style: 'flex:0 0 22px;' }).appendTo(hdr);
            $('<span>', { style: 'flex:1 1 auto;' }).text('topic').appendTo(hdr);
            $('<span>', { style: 'flex:0 0 130px;' }).text('alias').appendTo(hdr);
            list.append(hdr);

            keys.forEach(function(k) {
                var id = 'dataops-key-' + k.replace(/[^a-zA-Z0-9_]/g, '_');
                var checked = Object.prototype.hasOwnProperty.call(sel.map, k);
                var row = $('<div>', { style: 'display:flex;align-items:center;margin:0 0 2px;' });
                var cb = $('<input>', { type: 'checkbox', id: id, style: 'width:auto;flex:0 0 22px;margin:0;' }).prop('checked', checked);
                var label = $('<label>', { 'for': id, style: 'flex:1 1 auto;font-weight:normal;margin:0;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' })
                    .attr('title', k).text(k);
                var alias = $('<input>', { type: 'text', placeholder: '(alias)', style: 'flex:0 0 130px;width:130px;box-sizing:border-box;' })
                    .val(checked ? sel.map[k] : '').prop('disabled', !checked);

                cb.on('change', function() {
                    if (this.checked) {
                        if (sel.order.indexOf(k) === -1) sel.order.push(k);
                        if (!alias.val()) alias.val(k);
                        sel.map[k] = alias.val().trim() || k;
                        alias.prop('disabled', false);
                    } else {
                        sel.order = sel.order.filter(function(t) { return t !== k; });
                        delete sel.map[k];
                        alias.prop('disabled', true);
                    }
                    save();
                });
                alias.on('input', function() {
                    if (Object.prototype.hasOwnProperty.call(sel.map, k)) { sel.map[k] = alias.val().trim() || k; save(); }
                });

                list.append(row.append(cb).append(label).append(alias));
            });
        }

        function applyFilter() {
            var q = ($('#dataops-key-filter').val() || '').toLowerCase().trim();
            render(q ? allKeys.filter(function(k) { return k.toLowerCase().indexOf(q) !== -1; }) : allKeys);
        }

        function refresh() {
            var key = ($('#node-input-specKey').val() || '').trim();
            var status = $('#dataops-key-status');
            if (!key) { status.css('color', '#a00').text('Enter a Spec Key first.'); return; }
            status.css('color', '#777').text('Loading…');
            $.getJSON('dataops/context/keys', { scope: $('#node-input-specScope').val(), key: key, z: node.z })
                .done(function(data) {
                    // Keep already-selected topics visible even if not (yet) in the dict.
                    var keys = (data.keys || []).slice();
                    sel.order.forEach(function(t) { if (keys.indexOf(t) === -1) keys.push(t); });
                    allKeys = keys;
                    lastNote = data.note || '';
                    applyFilter();
                    status.css('color', '#393').text((data.keys || []).length + ' topics' + (data.note ? ' — ' + data.note : ''));
                })
                .fail(function(xhr) {
                    var m = (xhr.responseJSON && xhr.responseJSON.error) || 'request failed';
                    status.css('color', '#a00').text('Error: ' + m);
                });
        }

        $('#dataops-key-refresh').on('click', refresh);
        $('#dataops-key-filter').on('input', applyFilter);

        // Show the current selection immediately, before any refresh.
        allKeys = sel.order.slice();
        lastNote = 'Set Scope + Spec Key, then click Refresh to list live topics.';
        if (allKeys.length) render(allKeys);
    }

    window.DataOpsUI = { fieldPicker: fieldPicker };
})();

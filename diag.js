/**
 * 伊蕾娜の魔法手账 - 稳定性诊断 (diag.js)
 *
 * 目标：在不接电脑、不装扩展的前提下，能回答“它刚才为什么卡/黑/丢毛玻璃”。
 * 只做低频记录：启动、画质切换、背景加载/失败、可见性、watchdog、错误、长任务。
 * 环形日志存 sessionStorage，刷新后还能看到上一次运行的最后一段。
 */
(function () {
    'use strict';

    const KEY = 'elaina_diag';
    const MAX_EVENTS = 200;
    const MAX_LONG_TASKS = 40;
    const OVERLAY_MS = 2000;

    const state = {
        events: [],
        previous: [],
        longTasks: [],
        startedAt: Date.now(),
        lastPersist: 0,
        persistTimer: 0,
        overlayTimer: 0,
        diagOn: false,
        errCount: 0
    };

    function nowIso() {
        const d = new Date();
        const p = (n) => String(n).padStart(2, '0');
        return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }

    function cloneData(data) {
        if (data == null) return null;
        try {
            return JSON.parse(JSON.stringify(data));
        } catch (e) {
            try { return String(data); } catch (e2) { return null; }
        }
    }

    function record(type, data) {
        const ev = {
            t: Date.now(),
            clock: nowIso(),
            type: String(type || 'event'),
            data: cloneData(data)
        };
        state.events.push(ev);
        if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
        if (ev.type === 'error') state.errCount++;
        // 错误可能刷屏；持久化做 1s 节流
        const t = Date.now();
        if (t - state.lastPersist > 1000) {
            state.lastPersist = t;
            persist();
        } else if (!state.persistTimer) {
            state.persistTimer = setTimeout(function () {
                state.persistTimer = 0;
                state.lastPersist = Date.now();
                persist();
            }, 1100);
        }
        return ev;
    }

    function persist() {
        try {
            sessionStorage.setItem(KEY, JSON.stringify(state.events.slice(-MAX_EVENTS)));
        } catch (e) { /* 隐私模式/配额不足：忽略 */ }
    }

    function loadPrevious() {
        try {
            const raw = sessionStorage.getItem(KEY);
            if (!raw) return;
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) state.previous = arr.slice(-60);
        } catch (e) { /* 忽略 */ }
    }

    function deviceInfo() {
        const nav = navigator;
        let memory = null;
        try {
            if (performance && performance.memory) {
                memory = {
                    usedMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1),
                    totalMB: +(performance.memory.totalJSHeapSize / 1048576).toFixed(1),
                    limitMB: +(performance.memory.jsHeapSizeLimit / 1048576).toFixed(1)
                };
            }
        } catch (e) { /* 忽略 */ }
        return {
            ua: nav.userAgent || '',
            platform: nav.platform || '',
            cores: nav.hardwareConcurrency || null,
            deviceMemory: (typeof nav.deviceMemory === 'number') ? nav.deviceMemory : null,
            dpr: window.devicePixelRatio || 1,
            inner: [window.innerWidth, window.innerHeight],
            outer: [window.outerWidth, window.outerHeight],
            screen: [screen.width, screen.height],
            memory: memory,
            domNodes: document.getElementsByTagName('*').length
        };
    }

    function fxStats() {
        try {
            if (window.ElainaFX && typeof window.ElainaFX.stats === 'function') {
                return window.ElainaFX.stats();
            }
        } catch (e) { /* 忽略 */ }
        return null;
    }

    function layerInfo(id) {
        const el = document.getElementById(id);
        if (!el) return null;
        let src = '';
        try {
            src = el.currentSrc || el.getAttribute('src') || '';
            if (src.length > 120) src = '...' + src.slice(-117);
        } catch (e) { src = ''; }
        return {
            src: src,
            natural: [el.naturalWidth || 0, el.naturalHeight || 0],
            opacity: +(parseFloat(getComputedStyle(el).opacity) || 0).toFixed(2)
        };
    }

    function maskInfo() {
        const el = document.getElementById('bemfa-mask');
        if (!el) return null;
        return { opacity: +(parseFloat(getComputedStyle(el).opacity) || 0).toFixed(3) };
    }

    function snapshot() {
        const stats = fxStats();
        const bodyClass = document.body ? document.body.className : '';
        const lastEvents = state.events.slice(-40);
        return {
            now: new Date().toISOString(),
            startedAt: new Date(state.startedAt).toISOString(),
            visibility: document.visibilityState,
            bodyClass: bodyClass,
            device: deviceInfo(),
            fx: stats,
            rafLive: stats && typeof stats.rafLive === 'number' ? stats.rafLive : null,
            tickAge: stats && typeof stats.tickAge === 'number' ? stats.tickAge : null,
            glassMode: (document.body && document.body.classList.contains('glass-static')) ? 'static' : 'live',
            bg1: layerInfo('bg1'),
            bg2: layerInfo('bg2'),
            mask: maskInfo(),
            longTasks: state.longTasks.slice(-12),
            errCount: state.errCount,
            events: lastEvents,
            previousTail: state.previous.slice(-12)
        };
    }

    function dump() {
        try {
            return JSON.stringify(snapshot(), null, 2);
        } catch (e) {
            return '{"error":"dump failed"}';
        }
    }

    function clear() {
        state.events.length = 0;
        state.previous.length = 0;
        state.longTasks.length = 0;
        state.errCount = 0;
        try { sessionStorage.removeItem(KEY); } catch (e) { /* 忽略 */ }
        renderOverlay();
    }

    function shortNum(v, digits) {
        if (v == null || v === '') return '-';
        const n = Number(v);
        if (!isFinite(n)) return '-';
        return digits ? n.toFixed(digits) : String(n);
    }

    function bgLabel() {
        const b1 = layerInfo('bg1');
        const b2 = layerInfo('bg2');
        const active = (b1 && b1.opacity >= 0.5 && b1.natural[0]) ? b1 : (b2 && b2.opacity >= 0.5 && b2.natural[0] ? b2 : null);
        if (!active) return 'none';
        const kind = /imgs\/thumb\//.test(active.src) ? 'thumb' : 'orig';
        return kind + ' ' + active.natural[0] + 'x' + active.natural[1];
    }

    function renderOverlay() {
        if (!state.diagOn) return;
        const el = document.getElementById('diag-overlay');
        if (!el) return;
        const s = fxStats();
        const parts = [];
        parts.push('raf=' + (s ? (s.rafLive || 0) : '-'));
        parts.push('tick=' + (s && s.tickAge >= 0 ? s.tickAge + 'ms' : '-'));
        parts.push('gap=' + (s ? shortNum(s.gapMs, 1) : '-'));
        parts.push('draw=' + (s ? shortNum(s.drawMs, 2) : '-'));
        parts.push('lvl=' + (s ? s.level : '-'));
        parts.push('dg=' + (s ? s.downgrade : '-'));
        parts.push('paused=' + (s && s.paused ? '1' : '0'));
        parts.push('glass=' + (document.body && document.body.classList.contains('glass-static') ? 'static' : 'live'));
        parts.push('bg=' + bgLabel());
        try {
            const m = performance && performance.memory ? (performance.memory.usedJSHeapSize / 1048576).toFixed(0) + 'MB' : '-';
            parts.push('mem=' + m);
        } catch (e) { parts.push('mem=-'); }
        parts.push('err=' + state.errCount);
        parts.push('vis=' + document.visibilityState);
        el.textContent = parts.join(' ');
    }

    function setDiag(on) {
        state.diagOn = !!on;
        try {
            document.body.classList.toggle('diag', state.diagOn);
        } catch (e) { /* 忽略 */ }
        const btn = document.getElementById('diag-toggle');
        if (btn) {
            btn.textContent = state.diagOn ? '🩺 隐藏诊断信息' : '🩺 诊断信息';
            btn.setAttribute('aria-pressed', state.diagOn ? 'true' : 'false');
        }
        if (state.diagOn) {
            renderOverlay();
            if (!state.overlayTimer) {
                state.overlayTimer = setInterval(renderOverlay, OVERLAY_MS);
            }
        } else if (state.overlayTimer) {
            clearInterval(state.overlayTimer);
            state.overlayTimer = 0;
        }
        record('diag-toggle', { on: state.diagOn });
    }

    function exportDump() {
        const ta = document.getElementById('diag-dump');
        if (!ta) return;
        ta.value = dump();
        ta.style.display = 'block';
        try {
            ta.focus();
            ta.select();
        } catch (e) { /* 忽略 */ }
        record('diag-export', { bytes: ta.value.length });
    }

    function bindUI() {
        const toggle = document.getElementById('diag-toggle');
        if (toggle) toggle.addEventListener('click', function () { setDiag(!state.diagOn); });
        const exportBtn = document.getElementById('diag-export');
        if (exportBtn) exportBtn.addEventListener('click', exportDump);
        // URL ?diag=1 直接打开
        try {
            const q = {};
            location.search.replace(/[?&]([^=&]+)=([^&]*)/g, function (_, k, v) {
                q[decodeURIComponent(k)] = decodeURIComponent(v);
            });
            if (q.diag === '1') setDiag(true);
        } catch (e) { /* 忽略 */ }
    }

    function installErrorHooks() {
        window.addEventListener('error', function (ev) {
            record('error', {
                message: ev.message || '',
                source: ev.filename || '',
                line: ev.lineno || 0,
                col: ev.colno || 0,
                stack: (ev.error && ev.error.stack) ? String(ev.error.stack).slice(0, 800) : ''
            });
        });
        window.addEventListener('unhandledrejection', function (ev) {
            const r = ev.reason;
            record('error', {
                kind: 'unhandledrejection',
                message: (r && r.message) ? r.message : String(r),
                stack: (r && r.stack) ? String(r.stack).slice(0, 800) : ''
            });
        });
    }

    function installLongTaskObserver() {
        if (!window.PerformanceObserver) return;
        try {
            const po = new PerformanceObserver(function (list) {
                const entries = list.getEntries();
                for (let i = 0; i < entries.length; i++) {
                    const e = entries[i];
                    state.longTasks.push({
                        t: Date.now(),
                        duration: Math.round(e.duration),
                        start: Math.round(e.startTime)
                    });
                    if (state.longTasks.length > MAX_LONG_TASKS) state.longTasks.shift();
                }
                // 长任务也记一条汇总，方便对齐画质切换
                if (entries.length) {
                    record('longtask', {
                        count: entries.length,
                        max: Math.round(Math.max.apply(null, entries.map(function (x) { return x.duration; })))
                    });
                }
            });
            po.observe({ entryTypes: ['longtask'] });
        } catch (e) { /* 旧 Chrome 不支持：忽略 */ }
    }

    function boot() {
        loadPrevious();
        installErrorHooks();
        installLongTaskObserver();
        bindUI();
        record('boot', {
            ua: navigator.userAgent || '',
            cores: navigator.hardwareConcurrency || null,
            deviceMemory: (typeof navigator.deviceMemory === 'number') ? navigator.deviceMemory : null,
            dpr: window.devicePixelRatio || 1,
            inner: [window.innerWidth, window.innerHeight],
            hidden: !!document.hidden,
            prevCount: state.previous.length
        });
        renderOverlay();
    }

    window.ElainaDiag = {
        record: record,
        snapshot: snapshot,
        dump: dump,
        clear: clear,
        setDiag: setDiag,
        export: exportDump,
        get events() { return state.events.slice(); },
        get previous() { return state.previous.slice(); }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();

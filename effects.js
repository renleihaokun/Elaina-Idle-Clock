/**
 * 伊蕾娜の魔法手账 - 环境粒子引擎 (effects.js)
 *
 * 使用场景：老手机横屏长期挂机。设计目标是「用尽可能低的每帧成本，换取尽可能丰富的氛围」。
 *
 * 关键手段：
 *   1. 单张 Canvas 层 + 启动时一次性烘焙的 sprite，运行期只做 drawImage / fillRect；
 *   2. 热循环内不使用 shadowBlur、不新建渐变、不逐粒子 setTransform（旋转用烘焙好的旋转变体替代）；
 *   3. 自带帧率上限与自适应降级阶梯，持续超预算时自动减量，直到关掉最贵的特性；
 *   4. 页面不可见时完全停止 rAF，不空转省电。
 *
 * 对外接口（window.ElainaFX）：
 *   start() / stop()
 *   setLevel(level) / getLevel() / levelLabel(lv) / getLevels()
 *   setWeather(type, opts)                  type: 'sakura' | 'star' | 'rain' | 'snow' | 'fog'
 *   setBackgroundTone(lum)                  0~255，壁纸平均亮度，用于微调花瓣描边强弱
 *   burst(x, y) / sparkleAt(x, y) / puffAt(el) / wind() / hourPulse()
 *   stats()                                 调试与自检用
 */
(function () {
    'use strict';

    // ================= 常量 =================
    const CFG = {
        DPR_CAP: 1.5,              // 老手机 DPR 常见 2~3，封顶以省填充率
        FPS_CAP: { off: 0, light: 20, normal: 30, rich: 30 },
        SCALE: { off: 0, light: 0.6, normal: 1, rich: 1.3 },
        MAX_DRAWABLES: 96,         // 常驻绘制对象硬上限
        MAX_ONESHOTS: 56,          // 一次性特效（爆发/星芒/风痕）上限
        LEVEL_KEY: 'elaina_fx_level',
        DEFAULT_LEVEL: 'normal',
        JANK_MS: 34,               // 帧间隔超过此值 = 已掉到 30fps 以下
        DRAW_BUDGET_MS: 8,         // 单帧自身绘制耗时上限（约半个 60Hz 帧）
        ROOMY_MS: 24,              // 「余量充足」的帧间隔
        DRAW_ROOMY_MS: 4,          // 「余量充足」的自身耗时
        STALL_MS: 250,             // 超过此间隔说明合成器没在出帧（息屏/窗口被遮挡），不计入采样
        DOWNGRADE_MS: 2000,        // 吃紧持续多久降级
        UPGRADE_MS: 15000          // 余量充足持续多久升级
    };

    const LEVELS = ['off', 'light', 'normal', 'rich'];
    const LEVEL_LABEL = { off: '关闭', light: '轻盈', normal: '标准', rich: '华丽' };

    // 粒子种类
    const K_PETAL = 0, K_SNOW = 1, K_MOTE = 2, K_GLINT = 3,
          K_RAIN = 4, K_STAR = 5, K_FOG = 6, K_STREAK = 7;

    // 天气预设：每组是一类粒子的数量与运动参数
    const PRESETS = {
        sakura: [
            { kind: K_PETAL, size: 0, count: 16, vy: [18, 26], a: [0.34, 0.5], sway: [6, 14], spin: [0.15, 0.4] },
            { kind: K_PETAL, size: 1, count: 12, vy: [30, 46], a: [0.52, 0.74], sway: [10, 22], spin: [0.35, 0.8] },
            { kind: K_PETAL, size: 2, count: 4, vy: [52, 76], a: [0.76, 0.95], sway: [14, 30], spin: [0.5, 1.1] },
            { kind: K_MOTE, count: 8, vy: [-9, -3], dx: [-6, 6], a: [0.22, 0.45], scale: [0.5, 1.1] },
            { kind: K_GLINT, count: 5, dur: [1.1, 2.2], gap: [0.6, 3.2] }
        ],
        star: [
            { kind: K_STAR, count: 40, area: [0, 0.62], a: [0.22, 0.8] },
            { kind: K_MOTE, count: 8, vy: [-7, -2], dx: [-9, 9], a: [0.3, 0.6], scale: [0.6, 1.3], cool: true },
            { kind: K_PETAL, size: 1, count: 8, vy: [20, 34], a: [0.34, 0.58], sway: [8, 18], spin: [0.2, 0.6] },
            { kind: K_GLINT, count: 4, dur: [1.0, 1.9], gap: [1.4, 3.6] }
        ],
        rain: [
            { kind: K_RAIN, count: 70, vy: [420, 620], a: [0.26, 0.55] },
            { kind: K_GLINT, count: 3, dur: [0.9, 1.6], gap: [2.0, 4.5] }
        ],
        snow: [
            { kind: K_SNOW, size: 0, count: 20, vy: [24, 40], a: [0.35, 0.55], sway: [8, 18] },
            { kind: K_SNOW, size: 1, count: 18, vy: [42, 64], a: [0.5, 0.75], sway: [10, 24] },
            { kind: K_SNOW, size: 2, count: 7, vy: [66, 96], a: [0.7, 0.95], sway: [12, 28] },
            { kind: K_GLINT, count: 3, dur: [0.9, 1.7], gap: [1.6, 3.8] }
        ],
        fog: [
            { kind: K_FOG, count: 6, size: [180, 260], dx: [-16, -5], y: [0.35, 1.0], a: [0.05, 0.12] },
            { kind: K_PETAL, size: 1, count: 8, vy: [16, 26], a: [0.3, 0.5], sway: [8, 16], spin: [0.15, 0.4] },
            { kind: K_GLINT, count: 3, dur: [1.0, 1.8], gap: [1.8, 4.0] }
        ]
    };

    // ================= 内部状态 =================
    const state = {
        started: false,
        running: false,
        level: CFG.DEFAULT_LEVEL,
        preset: 'sakura',
        thunder: false,
        tone: 'dark',            // 壁纸明暗：'dark' | 'bright'
        w: 1, h: 1, dpr: 1,
        fpsCap: 30,
        noGlint: false,          // 降级 1 级：去掉星芒
        noHeavy: false,          // 降级 2 级：去掉大面积柔光（浮尘 / 雾团）并关闭卡片毛玻璃
        downgrade: 0,            // 自适应降级层级 0~3
        rafId: 0,
        last: 0,
        lastDraw: 0,
        acc: 0,
        gapEma: 0,
        drawEma: 0,
        overMs: 0,
        okMs: 0,
        lastPulse: 0,
        reduced: false
    };

    let cv = null, ctx = null;
    const parts = [];            // 常驻粒子
    const oneshots = [];         // 一次性粒子（爆发 / 风痕 / 雨溅）
    const oneFree = [];          // 一次性粒子对象池

    const rnd = (a, b) => a + Math.random() * (b - a);
    const rndInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1));

    // ================= sprite 烘焙 =================
    // 所有形状在这里一次性画好，运行期只贴图，避免热循环里创建渐变 / 阴影 / 矩阵。
    const SPR = {
        petal: [],               // [size].variants[]，暗色壁纸用（描边淡）
        petalSoft: [],           // 亮色壁纸用（描边重，保证可辨）
        snow: [],
        glowWarm: null,
        glowCool: null,
        glint: null,
        fog: null
    };

    function makeCanvas(w, h) {
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.ceil(w));
        c.height = Math.max(1, Math.ceil(h));
        return c;
    }

    function bakePetal(size, rimAlpha, steps, deep) {
        const base = makeCanvas(size * 3, size * 3);
        const half = base.width / 2;
        const c = base.getContext('2d');
        c.translate(half, half);
        const r = size * 0.5;
        const g = c.createLinearGradient(-r, -r, r, r);
        if (deep) {
            // 亮色 / 花哨壁纸：加深花瓣本色并加重描边，否则会糊进背景
            g.addColorStop(0, 'rgba(255,226,238,1)');
            g.addColorStop(0.55, 'rgba(246,148,180,0.98)');
            g.addColorStop(1, 'rgba(206,90,136,0.95)');
        } else {
            g.addColorStop(0, 'rgba(255,238,244,0.98)');
            g.addColorStop(0.55, 'rgba(255,183,197,0.95)');
            g.addColorStop(1, 'rgba(236,136,172,0.9)');
        }
        c.fillStyle = g;
        c.beginPath();
        c.moveTo(0, -r);
        c.bezierCurveTo(r * 1.05, -r * 0.85, r * 0.85, r * 0.7, 0, r);
        c.bezierCurveTo(-r * 0.85, r * 0.7, -r * 1.05, -r * 0.85, 0, -r);
        c.fill();
        if (rimAlpha > 0) {
            c.strokeStyle = (deep ? 'rgba(104,32,62,' : 'rgba(146,70,102,') + rimAlpha + ')';
            c.lineWidth = Math.max(0.6, r * (deep ? 0.18 : 0.12));
            c.stroke();
        }
        // 预旋转成固定份数的变体，运行期按角度取图，省掉每帧矩阵运算
        const variants = [];
        for (let i = 0; i < steps; i++) {
            const s = makeCanvas(base.width, base.height);
            const sc = s.getContext('2d');
            sc.translate(base.width / 2, base.height / 2);
            sc.rotate(i / steps * Math.PI * 2);
            sc.drawImage(base, -base.width / 2, -base.height / 2);
            variants.push(s);
        }
        return { variants: variants, half: half, steps: steps };
    }

    function bakeSnow(size) {
        const s = makeCanvas(size * 3.2, size * 3.2);
        const c = s.getContext('2d');
        const cx = s.width / 2, r = size * 0.5;
        const g = c.createRadialGradient(cx, cx, 0, cx, cx, r * 1.6);
        g.addColorStop(0, 'rgba(255,255,255,0.98)');
        g.addColorStop(0.5, 'rgba(236,246,255,0.7)');
        g.addColorStop(1, 'rgba(210,232,255,0)');
        c.fillStyle = g;
        c.beginPath();
        c.arc(cx, cx, r * 1.6, 0, Math.PI * 2);
        c.fill();
        return { img: s, half: cx };
    }

    function bakeGlow(radius, rgb) {
        const s = makeCanvas(radius * 6, radius * 6);
        const c = s.getContext('2d');
        const cx = s.width / 2;
        const g = c.createRadialGradient(cx, cx, 0, cx, cx, radius * 2.6);
        g.addColorStop(0, 'rgba(' + rgb + ',0.95)');
        g.addColorStop(0.35, 'rgba(' + rgb + ',0.34)');
        g.addColorStop(1, 'rgba(' + rgb + ',0)');
        c.fillStyle = g;
        c.beginPath();
        c.arc(cx, cx, radius * 2.6, 0, Math.PI * 2);
        c.fill();
        return { img: s, half: cx };
    }

    function bakeGlint(radius) {
        const s = makeCanvas(radius * 6, radius * 6);
        const c = s.getContext('2d');
        const cx = s.width / 2;
        c.translate(cx, cx);
        c.strokeStyle = 'rgba(255,247,216,0.95)';
        c.lineWidth = 1.5;
        c.beginPath();
        c.moveTo(-radius * 2.4, 0); c.lineTo(radius * 2.4, 0);
        c.moveTo(0, -radius * 2.4); c.lineTo(0, radius * 2.4);
        c.stroke();
        const g = c.createRadialGradient(0, 0, 0, 0, 0, radius * 1.1);
        g.addColorStop(0, 'rgba(255,255,240,0.95)');
        g.addColorStop(1, 'rgba(255,240,200,0)');
        c.fillStyle = g;
        c.beginPath();
        c.arc(0, 0, radius * 1.1, 0, Math.PI * 2);
        c.fill();
        return { img: s, half: cx };
    }

    function bakeFog(radius) {
        const s = makeCanvas(radius * 2.4, radius * 1.4);
        const c = s.getContext('2d');
        const cx = s.width / 2, cy = s.height / 2;
        const g = c.createRadialGradient(cx, cy, 0, cx, cy, radius);
        g.addColorStop(0, 'rgba(226,236,248,0.5)');
        g.addColorStop(0.5, 'rgba(214,228,244,0.22)');
        g.addColorStop(1, 'rgba(206,222,240,0)');
        c.save();
        c.translate(cx, cy);
        c.scale(1, s.height / s.width);
        c.fillStyle = g;
        c.beginPath();
        c.arc(0, 0, radius, 0, Math.PI * 2);
        c.fill();
        c.restore();
        return { img: s, half: cx };
    }

    let baked = false;
    function bakeSprites() {
        if (baked) return;
        const sizes = [5, 10, 17];      // 远 / 中 / 近三档花瓣
        const steps = [8, 8, 16];       // 近景用更细的旋转变体，避免一顿一顿
        SPR.petal = sizes.map((s, i) => bakePetal(s, 0.18, steps[i], false));
        SPR.petalSoft = sizes.map((s, i) => bakePetal(s, 0.55, steps[i], true));
        SPR.snow = [4, 7, 11].map(bakeSnow);
        SPR.glowWarm = bakeGlow(11, '255,214,140');
        SPR.glowCool = bakeGlow(11, '196,224,255');
        SPR.glint = bakeGlint(7);
        SPR.fog = bakeFog(120);
        baked = true;
    }

    function petalSet() { return state.tone === 'bright' ? SPR.petalSoft : SPR.petal; }

    // ================= 粒子构造 =================
    function makeParticle(kind) {
        return { k: kind, x: 0, y: 0, vx: 0, vy: 0, dx: 0, sub: 0, size: 0,
                 a: 0.6, amp: 0, f: 0, ph: 0, rot: 0, vr: 0, g: 0,
                 life: 0, max: 1, scale: 1, len: 1 };
    }

    function spawnGroup(g, scale) {
        const n = Math.max(1, Math.round(g.count * scale));
        for (let i = 0; i < n; i++) {
            if (parts.length >= CFG.MAX_DRAWABLES) return;
            const p = makeParticle(g.kind);

            if (g.kind === K_PETAL) {
                p.size = g.size;
                p.x = rnd(0, state.w);
                p.y = rnd(-state.h, state.h);
                p.vy = rnd(g.vy[0], g.vy[1]);
                p.a = rnd(g.a[0], g.a[1]);
                p.amp = rnd(g.sway[0], g.sway[1]);
                p.f = rnd(0.35, 0.95);
                p.ph = rnd(0, 6.28);
                p.vr = rnd(g.spin[0], g.spin[1]) * (Math.random() < 0.5 ? -1 : 1);
                p.rot = rndInt(0, SPR.petal[p.size].steps - 1);

            } else if (g.kind === K_SNOW) {
                p.size = g.size;
                p.x = rnd(0, state.w);
                p.y = rnd(-state.h, state.h);
                p.vy = rnd(g.vy[0], g.vy[1]);
                p.a = rnd(g.a[0], g.a[1]);
                p.amp = rnd(g.sway[0], g.sway[1]);
                p.f = rnd(0.3, 0.9);
                p.ph = rnd(0, 6.28);

            } else if (g.kind === K_MOTE) {
                p.x = rnd(0, state.w);
                p.y = rnd(0, state.h);
                p.vy = rnd(g.vy[0], g.vy[1]);
                p.dx = rnd(g.dx[0], g.dx[1]);
                p.a = rnd(g.a[0], g.a[1]);
                p.size = g.cool ? 1 : 0;
                p.scale = rnd(g.scale[0], g.scale[1]);
                p.f = rnd(0.5, 1.4);
                p.ph = rnd(0, 6.28);

            } else if (g.kind === K_RAIN) {
                p.x = rnd(-40, state.w + 40);
                p.y = rnd(-state.h, state.h);
                p.vy = rnd(g.vy[0], g.vy[1]);
                p.dx = rnd(-40, -14);
                p.a = rnd(g.a[0], g.a[1]);
                p.size = Math.random() < 0.5 ? 1 : 2;   // 雨丝宽度
                p.len = rnd(12, 26);                    // 雨丝长度

            } else if (g.kind === K_STAR) {
                p.x = rnd(0, state.w);
                p.y = rnd(state.h * g.area[0], state.h * g.area[1]);
                p.a = rnd(g.a[0], g.a[1]);
                p.size = Math.random() < 0.75 ? 1 : 2;
                p.f = rnd(0.4, 1.6);
                p.ph = rnd(0, 6.28);

            } else if (g.kind === K_FOG) {
                p.x = rnd(-state.w * 0.2, state.w);
                p.y = rnd(state.h * g.y[0], state.h * g.y[1]);
                p.dx = rnd(g.dx[0], g.dx[1]);
                p.a = rnd(g.a[0], g.a[1]);
                p.scale = rnd(g.size[0], g.size[1]) / 120;

            } else if (g.kind === K_GLINT) {
                // 常驻星芒：周期 = 闪烁时长 + 随机间隔，life 走到 max 就换个地方再来一次
                p.ph = rnd(0.45, 0.85);                 // 单次闪烁占周期的比例
                p.a = rnd(0.65, 1);
                p.scale = rnd(0.55, 1.15);
                p.max = rnd(g.dur[0], g.dur[1]) / Math.max(0.3, p.ph) + rnd(g.gap[0], g.gap[1]);
                p.life = rnd(0, p.max);
                p.x = rnd(0, state.w);
                p.y = rnd(0, state.h * 0.92);
                p.f = 0;
            }
            parts.push(p);
        }
    }

    function acquireOne(kind) {
        const p = oneFree.pop() || makeParticle(kind);
        p.k = kind;
        p.vx = 0; p.vy = 0; p.dx = 0; p.g = 0; p.amp = 0; p.vr = 0; p.rot = 0; p.f = 0; p.sub = 0;
        p.life = 0; p.max = 1; p.scale = 1; p.len = 1;
        return p;
    }

    function releaseOne(i) {
        const p = oneshots[i];
        oneshots[i] = oneshots[oneshots.length - 1];
        oneshots.pop();
        if (oneFree.length < 64) oneFree.push(p);
    }

    // ================= 画布 =================
    function ensureCanvas() {
        cv = document.getElementById('fx-canvas');
        if (!cv) {
            cv = document.createElement('canvas');
            cv.id = 'fx-canvas';
            cv.setAttribute('aria-hidden', 'true');
            document.body.insertBefore(cv, document.body.firstChild);
        }
        try { ctx = cv.getContext('2d'); } catch (e) { ctx = null; }
    }

    function fitCanvas() {
        if (!cv || !ctx) return;
        const w = Math.max(1, Math.round(window.innerWidth || document.documentElement.clientWidth || 1));
        const h = Math.max(1, Math.round(window.innerHeight || document.documentElement.clientHeight || 1));
        state.w = w; state.h = h;
        state.dpr = Math.min(window.devicePixelRatio || 1, CFG.DPR_CAP);
        cv.width = Math.round(w * state.dpr);
        cv.height = Math.round(h * state.dpr);
        ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    }

    function effectiveScale() {
        let scale = CFG.SCALE[state.level] || 1;
        if (state.downgrade >= 1) scale *= 0.6;
        if (state.downgrade >= 3) scale *= 0.75;
        if (state.reduced) scale *= 0.7;
        return scale;
    }

    function buildPreset(type, scale) {
        parts.length = 0;
        oneshots.length = 0;
        const groups = PRESETS[type] || PRESETS.sakura;
        for (let i = 0; i < groups.length; i++) {
            const g = groups[i];
            if (state.noGlint && g.kind === K_GLINT) continue;
            if (state.noHeavy && (g.kind === K_MOTE || g.kind === K_FOG)) continue;
            spawnGroup(g, scale);
        }
    }

    // ================= 主循环 =================
    function tick(ts) {
        if (!state.running) return;
        if (!state.last) state.last = ts;
        let gap = ts - state.last;
        if (gap < 0) gap = 0;
        state.last = ts;
        state.acc += gap;

        const cap = 1000 / Math.max(1, state.fpsCap);
        if (state.acc < cap) { state.rafId = requestAnimationFrame(tick); return; }
        const dt = Math.min(state.acc, 100) / 1000;   // 卡顿时钳制，避免粒子瞬移
        state.acc = 0;

        // 距离上一次真正绘制的墙钟时间：跳帧时它比 rAF 间隔大，用它累计才准
        const sinceLastDraw = state.lastDraw ? Math.min(ts - state.lastDraw, 1000) : cap;
        state.lastDraw = ts;

        const t0 = performance.now();
        render(dt);
        sampleQuality(gap, performance.now() - t0, sinceLastDraw);

        state.rafId = requestAnimationFrame(tick);
    }

    let curAlpha = -1;
    function setAlpha(a) {
        if (a < 0) a = 0; else if (a > 1) a = 1;
        if (Math.abs(a - curAlpha) < 0.012) return;
        ctx.globalAlpha = a;
        curAlpha = a;
    }

    function drawPetal(size, rot, x, y, alpha) {
        const set = petalSet()[size];
        const steps = set.steps;
        const idx = (((rot % steps) + steps) % steps) | 0;
        const spr = set.variants[idx];
        setAlpha(alpha);
        ctx.drawImage(spr, (x - set.half) | 0, (y - set.half) | 0);
    }

    function render(dt) {
        const W = state.w, H = state.h;
        ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);
        curAlpha = -1;

        // ---- 常驻粒子 ----
        for (let i = parts.length - 1; i >= 0; i--) {
            const p = parts[i];
            if (p.dx || p.vx) p.x += (p.dx + (p.vx || 0)) * dt;
            if (p.vx) p.vx *= Math.pow(0.3, dt);       // 阵风冲量指数衰减
            p.y += p.vy * dt;
            if (p.f) p.ph += p.f * dt;

            switch (p.k) {
                case K_PETAL: {
                    if (p.vr) p.rot += p.vr * dt;
                    if (p.y > H + 30) { p.y = -30; p.x = rnd(0, W); }
                    const x = p.x + Math.sin(p.ph) * p.amp;
                    if (x < -60) p.x = W + 40; else if (x > W + 60) p.x = -40;
                    drawPetal(p.size, p.rot, x, p.y, p.a);
                    break;
                }
                case K_SNOW: {
                    if (p.y > H + 20) { p.y = -20; p.x = rnd(0, W); }
                    const spr = SPR.snow[p.size];
                    const x = p.x + Math.sin(p.ph) * p.amp;
                    setAlpha(p.a);
                    ctx.drawImage(spr.img, (x - spr.half) | 0, (p.y - spr.half) | 0);
                    break;
                }
                case K_MOTE: {
                    if (p.y < -30) { p.y = H + 30; p.x = rnd(0, W); }
                    if (p.x < -40) p.x = W + 30; else if (p.x > W + 40) p.x = -30;
                    const spr = p.size ? SPR.glowCool : SPR.glowWarm;
                    const sz = spr.img.width * p.scale;
                    setAlpha(p.a * (0.55 + 0.45 * Math.sin(p.ph)));
                    ctx.drawImage(spr.img, (p.x - sz / 2) | 0, (p.y - sz / 2) | 0, sz, sz);
                    break;
                }
                case K_GLINT: {
                    p.life += dt;
                    if (p.life >= p.max) {
                        p.life -= p.max;
                        p.x = rnd(0, W);
                        p.y = rnd(0, H * 0.92);
                        p.scale = rnd(0.55, 1.15);
                    }
                    const t = p.life / (p.max * p.ph);
                    if (t > 1) break;
                    const k = Math.sin(Math.PI * t);
                    if (k < 0.02) break;
                    const spr = SPR.glint;
                    const sz = spr.img.width * p.scale * (0.7 + 0.5 * k);
                    setAlpha(p.a * k);
                    ctx.drawImage(spr.img, (p.x - sz / 2) | 0, (p.y - sz / 2) | 0, sz, sz);
                    break;
                }
                case K_RAIN: {
                    if (p.y > H + p.len) {
                        // 触底：按概率溅起水花
                        if (Math.random() < 0.22 && oneshots.length < CFG.MAX_ONESHOTS) {
                            const s = acquireOne(K_STREAK);
                            s.x = p.x; s.y = H - rnd(0, 3);
                            s.max = rnd(0.2, 0.36);
                            s.a = p.a * 0.85;
                            s.len = 1;
                            s.sub = 1;                    // sub = 1 表示「雨溅」形态而不是「风痕」
                            oneshots.push(s);
                        }
                        p.y = -p.len - rnd(0, 60);
                        p.x = rnd(-40, W + 40);
                    }
                    if (p.x < -60) p.x = W + 40;
                    ctx.fillStyle = 'rgb(202,226,255)';
                    setAlpha(p.a);
                    ctx.fillRect(p.x | 0, p.y | 0, p.size, p.len);
                    break;
                }
                case K_STAR: {
                    setAlpha(p.a * (0.55 + 0.45 * Math.sin(p.ph)));
                    ctx.fillStyle = '#ffffff';
                    ctx.fillRect(p.x | 0, p.y | 0, p.size, p.size);
                    break;
                }
                case K_FOG: {
                    const spr = SPR.fog;
                    if (p.x < -spr.half * p.scale) { p.x = W + spr.half * p.scale * 0.6; p.y = rnd(H * 0.3, H); }
                    setAlpha(p.a);
                    ctx.drawImage(spr.img, (p.x - spr.half * p.scale) | 0,
                                  (p.y - spr.img.height * p.scale / 2) | 0,
                                  spr.img.width * p.scale, spr.img.height * p.scale);
                    break;
                }
            }
        }

        // ---- 一次性粒子（爆发 / 星芒 / 风痕 / 雨溅） ----
        for (let i = oneshots.length - 1; i >= 0; i--) {
            const p = oneshots[i];
            p.life += dt;
            if (p.life >= p.max) { releaseOne(i); continue; }
            const t = p.life / p.max;
            p.vy += p.g * dt;
            if (p.vx) p.vx *= Math.pow(0.35, dt);
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            if (p.vr) p.rot += p.vr * dt;

            switch (p.k) {
                case K_PETAL:
                    drawPetal(p.size, p.rot, p.x, p.y, p.a * (1 - t));
                    break;
                case K_GLINT: {
                    const k = Math.sin(Math.PI * t);
                    const spr = SPR.glint;
                    const sz = spr.img.width * p.scale * (0.7 + 0.5 * k);
                    setAlpha(p.a * k);
                    ctx.drawImage(spr.img, (p.x - sz / 2) | 0, (p.y - sz / 2) | 0, sz, sz);
                    break;
                }
                case K_MOTE: {
                    const spr = p.size ? SPR.glowCool : SPR.glowWarm;
                    const sz = spr.img.width * p.scale;
                    setAlpha(p.a * (1 - t) * (0.6 + 0.4 * Math.sin(p.ph * 3 + p.life * 6)));
                    ctx.drawImage(spr.img, (p.x - sz / 2) | 0, (p.y - sz / 2) | 0, sz, sz);
                    break;
                }
                case K_STREAK: {
                    ctx.fillStyle = 'rgb(214,232,255)';
                    if (p.sub === 1) {                 // 雨溅：竖直小水柱
                        setAlpha(p.a * (1 - t));
                        ctx.fillRect(p.x | 0, (p.y - t * 8) | 0, 1, 3 + t * 3);
                    } else {                          // 风痕：横向细线
                        setAlpha(p.a * (1 - t));
                        ctx.fillRect(p.x | 0, (p.y + Math.sin(t * 6) * 6) | 0, p.len, 1.4);
                    }
                    break;
                }
            }
        }
    }

    // ================= 自适应质量 =================
    function sampleQuality(gap, drawMs, elapsed) {
        // 合成器长时间不出帧（息屏 / 窗口被遮挡 / 切到后台）时不计入采样，恢复后重新学习
        if (gap > CFG.STALL_MS) {
            state.gapEma = 0; state.drawEma = 0;
            state.overMs = 0; state.okMs = 0;
            return;
        }

        state.gapEma = state.gapEma ? state.gapEma * 0.88 + gap * 0.12 : gap;
        state.drawEma = state.drawEma ? state.drawEma * 0.88 + drawMs * 0.12 : drawMs;

        const jank = state.gapEma > CFG.JANK_MS || state.drawEma > CFG.DRAW_BUDGET_MS;
        const roomy = state.gapEma < CFG.ROOMY_MS && state.drawEma < CFG.DRAW_ROOMY_MS;

        if (jank) { state.overMs += elapsed; state.okMs = 0; }
        else if (roomy) { state.okMs += elapsed; state.overMs = 0; }
        else { state.overMs = 0; state.okMs = 0; }

        if (state.overMs > CFG.DOWNGRADE_MS && state.downgrade < 3) {
            state.downgrade++;
            state.overMs = 0; state.okMs = 0;
            applyQuality();
        } else if (state.okMs > CFG.UPGRADE_MS && state.downgrade > 0) {
            state.downgrade--;
            state.overMs = 0; state.okMs = 0;
            applyQuality();
        }
    }

    // 把内部档位映射到 body 上的降级类（css 负责关毛玻璃 / 收暗角）
    function syncBodyClasses() {
        document.body.classList.toggle('fx-low', state.downgrade >= 2 && state.level !== 'off');
        document.body.classList.toggle('fx-off', state.level === 'off');
    }

    function applyQuality() {
        if (state.level === 'off') { stop(); syncBodyClasses(); return; }

        let cap = CFG.FPS_CAP[state.level] || 30;
        state.noGlint = state.downgrade >= 1;
        state.noHeavy = state.downgrade >= 2;
        if (state.downgrade >= 3) cap = Math.min(cap, 18);
        if (state.reduced) cap = Math.min(cap, 20);
        state.fpsCap = cap;

        if (state.running) { cancelAnimationFrame(state.rafId); state.running = false; }
        syncBodyClasses();
        buildPreset(state.preset, effectiveScale());
        state.running = true;
        state.last = 0;
        state.lastDraw = 0;
        state.acc = 0;
        state.rafId = requestAnimationFrame(tick);
    }

    // ================= 一次性特效 =================
    function addRadial(x, y, kind, count, speed, opts) {
        for (let i = 0; i < count; i++) {
            if (oneshots.length >= CFG.MAX_ONESHOTS) return;
            const p = acquireOne(kind);
            const ang = (i / count) * Math.PI * 2 + rnd(-0.35, 0.35);
            const sp = rnd(speed[0], speed[1]);
            p.x = x; p.y = y;
            p.vx = Math.cos(ang) * sp;
            p.vy = Math.sin(ang) * sp;
            p.max = rnd(opts.dur[0], opts.dur[1]);
            p.a = rnd(opts.a[0], opts.a[1]);
            p.ph = rnd(0, 6.28);
            if (kind === K_PETAL) {
                p.size = opts.size != null ? opts.size : rndInt(0, 2);
                p.vr = rnd(-2.2, 2.2);
                p.g = 60;
            } else if (kind === K_GLINT) {
                p.scale = rnd(0.5, 1.1);
            } else if (kind === K_MOTE) {
                p.scale = rnd(0.5, 1.2);
                p.size = Math.random() < 0.5 ? 1 : 0;
            }
            oneshots.push(p);
        }
    }

    function burst(x, y) {
        if (!state.running) return;
        addRadial(x, y, K_PETAL, 12, [90, 260], { dur: [1.1, 2.0], a: [0.75, 0.95] });
        addRadial(x, y, K_GLINT, 10, [140, 340], { dur: [0.7, 1.5], a: [0.8, 1] });
        addRadial(x, y, K_MOTE, 8, [50, 160], { dur: [1.2, 2.2], a: [0.4, 0.7] });
    }

    function sparkleAt(x, y) {
        if (!state.running) return;
        addRadial(x, y, K_GLINT, 6, [40, 130], { dur: [0.55, 1.1], a: [0.65, 0.95] });
        addRadial(x, y, K_PETAL, 3, [60, 150], { dur: [0.9, 1.6], a: [0.6, 0.85], size: 1 });
    }

    function puffAt(el) {
        if (!state.running) return;
        let x = state.w * 0.5, y = state.h * 0.5;
        if (el && el.getBoundingClientRect) {
            const r = el.getBoundingClientRect();
            if (r.width || r.height) { x = r.left + r.width / 2; y = r.top + r.height / 2; }
        }
        addRadial(x, y, K_PETAL, 6, [40, 120], { dur: [1.0, 1.8], a: [0.55, 0.85], size: 1 });
        addRadial(x, y, K_GLINT, 4, [30, 90], { dur: [0.5, 1.0], a: [0.6, 0.9] });
    }

    function wind() {
        if (!state.running) return;
        const W = state.w, H = state.h;
        for (let i = 0; i < parts.length; i++) {
            const p = parts[i];
            // 只推会飘的东西；星点/浮尘/雾团保持原位，否则会被推出屏幕再也回不来
            if (p.k !== K_PETAL && p.k !== K_SNOW && p.k !== K_RAIN) continue;
            p.vx = (p.vx || 0) + rnd(140, 380);
            if (p.k === K_PETAL) p.vr = p.vr * 2.4 + (p.vr >= 0 ? 1 : -1);
        }
        for (let i = 0; i < 10; i++) {
            if (oneshots.length >= CFG.MAX_ONESHOTS) break;
            const p = acquireOne(K_STREAK);
            p.x = rnd(-W * 0.3, 0);
            p.y = rnd(H * 0.05, H);
            p.vx = rnd(700, 1200);
            p.max = rnd(0.9, 1.6);
            p.a = rnd(0.25, 0.5);
            p.len = rnd(30, 90);
            oneshots.push(p);
        }
    }

    function hourPulse() {
        if (!state.running) return;
        const now = performance.now();
        if (now - state.lastPulse < 5000) return;      // 冷却，避免叠播
        state.lastPulse = now;
        let cx = state.w * 0.5, cy = state.h * 0.5;
        const clock = document.getElementById('time');
        if (clock && clock.getBoundingClientRect) {
            const r = clock.getBoundingClientRect();
            if (r.width) { cx = r.left + r.width / 2; cy = r.top + r.height / 2; }
        }
        const radius = Math.min(state.w, state.h) * 0.3;
        for (let i = 0; i < 14; i++) {
            if (oneshots.length >= CFG.MAX_ONESHOTS) break;
            const p = acquireOne(K_GLINT);
            const ang = i / 14 * Math.PI * 2;
            p.x = cx + Math.cos(ang) * radius;
            p.y = cy + Math.sin(ang) * radius;
            p.vx = Math.cos(ang) * 26;
            p.vy = Math.sin(ang) * 26;
            p.max = rnd(1.1, 1.9);
            p.a = rnd(0.65, 1);
            p.scale = rnd(0.6, 1.1);
            oneshots.push(p);
        }
        addRadial(cx, cy, K_PETAL, 6, [40, 110], { dur: [1.2, 2.0], a: [0.5, 0.8], size: 1 });
    }

    // ================= 事件 =================
    let resizeTimer = 0;
    function onResize() {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            const oldW = state.w, oldH = state.h;
            fitCanvas();
            const sx = oldW ? state.w / oldW : 1;
            const sy = oldH ? state.h / oldH : 1;
            for (let i = 0; i < parts.length; i++) {
                const p = parts[i];
                p.x *= sx; p.y *= sy;
                if (p.y > state.h + 40) p.y = rnd(-state.h, 0);
            }
        }, 200);
    }

    function onVisibility() {
        if (!state.started) return;
        if (document.hidden) {
            if (state.running) { cancelAnimationFrame(state.rafId); state.running = false; }
        } else if (state.level !== 'off' && !state.running) {
            state.running = true; state.last = 0; state.lastDraw = 0; state.acc = 0;
            state.rafId = requestAnimationFrame(tick);
        }
    }

    function bindEvents() {
        window.addEventListener('resize', onResize);
        window.addEventListener('orientationchange', onResize);
        document.addEventListener('visibilitychange', onVisibility);
    }

    // ================= 对外接口 =================
    function readLevel() {
        let lv = null;
        try { lv = localStorage.getItem(CFG.LEVEL_KEY); } catch (e) { lv = null; }
        if (LEVELS.indexOf(lv) >= 0) return lv;
        // 未配置过：低端机起手就轻一档
        try {
            const cores = navigator.hardwareConcurrency || 4;
            const mem = navigator.deviceMemory || 4;
            if (cores <= 4 || mem <= 2) return 'light';
        } catch (e) { /* 忽略 */ }
        return CFG.DEFAULT_LEVEL;
    }

    function start() {
        if (state.started) return;
        ensureCanvas();
        if (!ctx) return;                  // 无 Canvas 支持：静默退出，不影响页面其它功能
        bakeSprites();
        state.reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        state.level = readLevel();
        fitCanvas();
        bindEvents();
        state.started = true;
        if (state.level === 'off') { syncBodyClasses(); return; }
        applyQuality();
    }

    function stop() {
        if (state.running) { cancelAnimationFrame(state.rafId); state.running = false; }
    }

    function setLevel(level) {
        if (LEVELS.indexOf(level) < 0) return;
        state.level = level;
        try { localStorage.setItem(CFG.LEVEL_KEY, level); } catch (e) { /* 忽略 */ }
        if (!state.started) { start(); return; }
        if (level === 'off') { stop(); syncBodyClasses(); return; }
        state.downgrade = 0;
        state.overMs = 0; state.okMs = 0;
        applyQuality();
    }

    function setWeather(type, opts) {
        const next = PRESETS[type] ? type : 'sakura';
        const thunder = !!(opts && opts.thunder);
        if (next === state.preset && thunder === state.thunder && state.started) return;
        state.preset = next;
        state.thunder = thunder;
        if (!state.started || state.level === 'off') return;
        buildPreset(next, effectiveScale());
        // 雷阵雨：雨势再加一档
        if (thunder && state.running) spawnGroup(PRESETS.rain[0], 18 / PRESETS.rain[0].count);
    }

    function setBackgroundTone(lum) {
        const next = lum > 140 ? 'bright' : 'dark';
        if (next === state.tone) return;
        state.tone = next;
    }

    // 解析持久化档位：放在 IIFE 里而非 start()，这样设置面板在任何时机都能读到正确值
    state.level = readLevel();

    window.ElainaFX = {
        start: start,
        stop: stop,
        setLevel: setLevel,
        getLevel: () => state.level,
        levelLabel: (lv) => LEVEL_LABEL[lv] || LEVEL_LABEL.normal,
        getLevels: () => LEVELS.slice(),
        setWeather: setWeather,
        setBackgroundTone: setBackgroundTone,
        burst: burst,
        sparkleAt: sparkleAt,
        puffAt: puffAt,
        wind: wind,
        hourPulse: hourPulse,
        stats: () => {
            const kinds = [0, 0, 0, 0, 0, 0, 0, 0];
            for (let i = 0; i < parts.length; i++) kinds[parts[i].k]++;
            return {
                started: state.started,
                running: state.running,
                hidden: !!document.hidden,
                level: state.level,
                preset: state.preset,
                tone: state.tone,
                downgrade: state.downgrade,
                fpsCap: state.fpsCap,
                gapMs: +state.gapEma.toFixed(2),
                drawMs: +state.drawEma.toFixed(2),
                drawables: parts.length,
                oneshots: oneshots.length,
                kinds: {
                    petal: kinds[K_PETAL], snow: kinds[K_SNOW], mote: kinds[K_MOTE], glint: kinds[K_GLINT],
                    rain: kinds[K_RAIN], star: kinds[K_STAR], fog: kinds[K_FOG], streak: kinds[K_STREAK]
                },
                size: [state.w, state.h, state.dpr]
            };
        }
    };
})();

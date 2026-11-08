/**
 * 伊蕾娜の魔法手账 - 环境粒子引擎 (effects.js)
 *
 * 使用场景：老手机横屏长期挂机。设计目标是「用尽可能低的每帧成本，换取尽可能丰富的氛围」。
 *
 * 关键手段：
 *   1. 单张 Canvas 层 + 启动时一次性烘焙的 2x 超采样 sprite（绘制时缩回 CSS 尺寸），
 *      运行期只做 drawImage / fillRect；
 *   2. 热循环内不使用 shadowBlur、不新建渐变、不逐粒子 setTransform（旋转用烘焙好的旋转变体替代）；
 *   3. 自带帧率上限与自适应降级阶梯，持续超预算时自动减量，直到关掉最贵的特性；
 *   4. 页面不可见时完全停止 rAF，不空转省电。
 *
 * 对外接口（window.ElainaFX）：
 *   start() / stop() / setPaused(bool)
 *   setLevel(level) / getLevel() / levelLabel(lv) / getLevels()
 *   setWeather(type, opts)                  type: 'sakura' | 'star' | 'rain' | 'snow' | 'fog'
 *   setBackgroundTone(lum)                  0~255，壁纸平均亮度，用于微调花瓣描边强弱
 *   burst(x, y) / sparkleAt(x, y) / puffAt(el) / wind() / hourPulse()
 *   refreshGlass()                          请求页面重建动态毛玻璃表面
 *   getDeviceInfo() / stats()               调试与自检用
 *
 * 调度约定：任何时刻最多一个 pending rAF；画质切换用 generation +1 作废旧回调，
 * 绝不允许 applyQuality() 自己再 requestAnimationFrame（旧版长跑卡死的根因）。
 */
(function () {
    'use strict';

    // ================= 常量 =================
    const CFG = {
        DPR_CAP: 1.5,              // 省电档位封顶（老手机 DPR 常见 2~3）
        DPR_CAP_RICH: 2,           // 华丽档放宽换清晰度；低内存设备仍强制回 1.5
        FPS_CAP: { off: 0, light: 20, normal: 30, rich: 30 },
        SCALE: { off: 0, light: 0.6, normal: 1, rich: 1.3 },
        MAX_DRAWABLES: 96,         // 常驻绘制对象硬上限
        MAX_ONESHOTS: 56,          // 一次性特效（爆发/星芒/风痕）上限
        LEVEL_KEY: 'elaina_fx_level',
        DEFAULT_LEVEL: 'normal',
        JANK_MS: 34,               // 判卡绝对下限；实际还会按 baselineGap*1.6 动态放宽
        DRAW_BUDGET_MS: 8,         // 单帧自身绘制耗时上限（约半个 60Hz 帧）
        DRAW_SLACK: 1.9,           // 出帧间隔超过目标间隔的倍数 → 判为掉帧
        DRAW_ROOMY_SLACK: 1.55,    // 出帧间隔在这个倍数以内才算「余量充足」；
                                   // 30Hz 屏 + 20fps 档会按 2 帧节奏出帧（约 66ms），
                                   // 1.3 倍（65ms）会永远差 1ms 升不回去，故放宽到 1.55。
        DRAW_ROOMY_MS: 4,          // 「余量充足」的自身耗时
        STALL_MS: 250,             // 超过此间隔说明合成器没在出帧（息屏/窗口被遮挡），不计入采样
        PIXEL_BUDGET_LOW: 1600000, // 低内存设备的 canvas 像素预算（约 1600×1000）
        PIXEL_BUDGET: 3200000,     // 普通设备预算；超过就主动降 canvas 分辨率，别让软件光栅/显存爆
        BASELINE_SAMPLES: 60,      // 启动后采样多少帧来学习当前设备的 rAF 基线
        QUALITY_DOWN_MS: 3000,     // 持续吃紧多久降一档（比原来的 2s 更抗瞬时卡顿）
        QUALITY_UP_MS: 30000,      // 持续富余多久升一档
        QUALITY_COOLDOWN_MS: 20000,// 两次画质切换最小间隔，杜绝来回抖动
        WATCHDOG_MS: 2000,         // 看门狗检查间隔
        TICK_STALL_MS: 3000        // 可见状态下多久没出帧就判定为卡住
    };

    const LEVELS = ['off', 'light', 'normal', 'rich'];
    const LEVEL_LABEL = { off: '关闭', light: '轻盈', normal: '标准', rich: '华丽' };

    // 粒子种类
    const K_PETAL = 0, K_SNOW = 1, K_MOTE = 2, K_GLINT = 3,
          K_RAIN = 4, K_STAR = 5, K_FOG = 6, K_STREAK = 7;

    // 天气预设：每组是一类粒子的数量与运动参数
    const PRESETS = {
        sakura: [
            { kind: K_PETAL, size: 0, count: 16, vy: [18, 26], a: [0.45, 0.6], sway: [6, 14], spin: [0.15, 0.4] },
            { kind: K_PETAL, size: 1, count: 12, vy: [30, 46], a: [0.62, 0.78], sway: [10, 22], spin: [0.35, 0.8] },
            { kind: K_PETAL, size: 2, count: 4, vy: [52, 76], a: [0.8, 0.95], sway: [14, 30], spin: [0.5, 1.1] },
            { kind: K_MOTE, count: 8, vy: [-9, -3], dx: [-6, 6], a: [0.22, 0.45], scale: [0.5, 1.1] },
            { kind: K_GLINT, count: 5, dur: [1.1, 2.2], gap: [0.6, 3.2] }
        ],
        star: [
            { kind: K_STAR, count: 40, area: [0, 0.62], a: [0.22, 0.8] },
            { kind: K_MOTE, count: 8, vy: [-7, -2], dx: [-9, 9], a: [0.3, 0.6], scale: [0.6, 1.3], cool: true },
            { kind: K_PETAL, size: 1, count: 8, vy: [20, 34], a: [0.55, 0.72], sway: [8, 18], spin: [0.2, 0.6] },
            { kind: K_GLINT, count: 4, dur: [1.0, 1.9], gap: [1.4, 3.6] }
        ],
        rain: [
            { kind: K_RAIN, count: 70, vy: [420, 620], a: [0.26, 0.55] },
            { kind: K_GLINT, count: 3, dur: [0.9, 1.6], gap: [2.0, 4.5] }
        ],
        snow: [
            { kind: K_SNOW, size: 0, count: 20, vy: [24, 40], a: [0.45, 0.6], sway: [8, 18] },
            { kind: K_SNOW, size: 1, count: 18, vy: [42, 64], a: [0.62, 0.78], sway: [10, 24] },
            { kind: K_SNOW, size: 2, count: 7, vy: [66, 96], a: [0.8, 0.95], sway: [12, 28] },
            { kind: K_GLINT, count: 3, dur: [0.9, 1.7], gap: [1.6, 3.8] }
        ],
        fog: [
            { kind: K_FOG, count: 6, size: [180, 260], dx: [-16, -5], y: [0.35, 1.0], a: [0.05, 0.12] },
            { kind: K_PETAL, size: 1, count: 8, vy: [16, 26], a: [0.5, 0.66], sway: [8, 16], spin: [0.15, 0.4] },
            { kind: K_GLINT, count: 3, dur: [1.0, 1.8], gap: [1.8, 4.0] }
        ]
    };

    // ================= 内部状态 =================
    const state = {
        started: false,
        running: false,
        paused: false,           // 夜间黑屏 / 打开设置面板时暂停（与 level='off' 独立）
        level: CFG.DEFAULT_LEVEL,
        preset: 'sakura',
        thunder: false,
        tone: 'dark',            // 壁纸明暗：'dark' | 'bright'
        w: 1, h: 1, dpr: 1,
        fpsCap: 30,
        noGlint: false,          // 降级 1 级：去掉星芒
        noHeavy: false,          // 降级 2 级：去掉大面积柔光（浮尘 / 雾团）；毛玻璃不再由这里关
        downgrade: 0,            // 自适应降级层级 0~3
        rafId: 0,
        rafGen: 0,               // 调度代际：每次重启 +1，旧回调全部作废
        rafLive: 0,              // 当前 pending 的 rAF 数，正常必须为 0/1
        last: 0,
        lastDraw: 0,
        lastTickAt: 0,
        tickCount: 0,
        acc: 0,
        gapEma: 0,
        drawEma: 0,
        drawGapEma: 0,
        overMs: 0,
        okMs: 0,
        baselineGap: 0,          // 当前设备/当前省电模式的 rAF 间隔基线
        baselineSamples: 0,
        lastQualityChange: 0,
        transitions: 0,
        errCount: 0,
        lastPulse: 0,
        buildAt: 0,              // buildPreset 时间戳，用于 0.9s 全场淡入
        reduced: false,
        pixelBudget: CFG.PIXEL_BUDGET
    };

    let cv = null, ctx = null;
    const parts = [];            // 常驻粒子
    const oneshots = [];         // 一次性粒子（爆发 / 风痕 / 雨溅）
    const oneFree = [];          // 一次性粒子对象池
    const partFree = [];         // 常驻粒子对象池，避免画质切换时反复 new

    const rnd = (a, b) => a + Math.random() * (b - a);
    const rndInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1));

    // ================= sprite 烘焙 =================
    // 所有形状在这里一次性画好，运行期只贴图，避免热循环里创建渐变 / 阴影 / 矩阵。
    const SPR = {
        petal: [],               // [size].variants[]，暗色壁纸用
        petalSoft: [],           // 亮色壁纸用（加深本体 + 细描边）
        snow: [],
        stars: [],               // 星点：柔光圆点两档
        glowWarm: null,
        glowCool: null,
        glint: null,
        fog: null,
        rain: null,              // 渐变雨丝
        wind: null               // 渐变风痕
    };

    // 低内存设备：降烘焙倍率与旋转变体数，纹理内存减半。
    // deviceMemory 只有 Chromium 系支持，iOS Safari / Firefox 上恒为 undefined；
    // 用「移动端 + 核心数少」兜底，避免老 iPhone / iPad 因 canvas 纹理过大而掉帧甚至崩溃。
    function detectLowMem() {
        try {
            const mem = navigator.deviceMemory;
            const ua = navigator.userAgent || '';
            if (typeof mem === 'number') {
                // Android 的 deviceMemory 是按 2 的幂取整的，3GB 机常报 4。
                // 32 位 Android 长期挂机的目标设备统一按低内存处理，纹理/DPR 都省一档。
                if (/Android/i.test(ua)) return mem <= 4;
                return mem <= 2;
            }
            const mobile = /iPhone|iPad|iPod|Android|Mobile/i.test(ua);
            const cores = navigator.hardwareConcurrency || 4;
            return mobile && cores <= 4;
        } catch (e) { return false; }
    }
    const LOW_MEM = detectLowMem();
    const BAKE_SS = LOW_MEM ? 1.5 : 2;      // sprite 烘焙超采样倍率

    function makeCanvas(w, h, ss) {
        const s = ss || 1;
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.ceil(w * s));
        c.height = Math.max(1, Math.ceil(h * s));
        return c;
    }

    // 花瓣绘制原语：双 arc 复刻 border-radius:100% 0 100% 0 的透镜形（两端尖 / 两侧圆润），
    // 即老版 CSS 花瓣的几何等价。入参为已 translate 到中心、按 CSS 单位缩放的上下文。
    function petalPath(c, r) {
        c.beginPath();
        c.moveTo(0, -r);
        c.arc(-r, 0, r * Math.SQRT2, -Math.PI / 4, Math.PI / 4);
        c.arc(r, 0, r * Math.SQRT2, Math.PI * 0.75, Math.PI * 1.25);
        c.closePath();
    }

    function bakePetal(size, deep, steps) {
        const span = size * 3;                 // 画布 CSS 边长
        const base = makeCanvas(span, span, BAKE_SS);
        const c = base.getContext('2d');
        c.scale(BAKE_SS, BAKE_SS);
        c.translate(span / 2, span / 2);
        const r = size * 0.5;

        // 底层柔光：老版 box-shadow 0 0 5px 的等价物；亮色壁纸下弱化避免发脏
        const glowR = r * 2.6;
        const glowA = deep ? 0.2 : 0.45;
        const gg = c.createRadialGradient(0, 0, 0, 0, 0, glowR);
        gg.addColorStop(0, 'rgba(255,183,197,' + glowA + ')');
        gg.addColorStop(0.5, 'rgba(255,183,197,' + (glowA * 0.38) + ')');
        gg.addColorStop(1, 'rgba(255,183,197,0)');
        c.fillStyle = gg;
        c.beginPath();
        c.arc(0, 0, glowR, 0, Math.PI * 2);
        c.fill();

        // 花瓣本体：干净平色（老版 #ffb7c5 基准）；暗色壁纸不加描边
        petalPath(c, r);
        c.fillStyle = deep ? '#f29db1' : '#ffb7c5';
        c.fill();
        if (deep) {
            // 亮色壁纸：极淡细描边保证可辨，不做黑红重描边
            c.strokeStyle = 'rgba(150,60,95,0.28)';
            c.lineWidth = Math.max(0.5, r * 0.09);
            c.stroke();
        }

        // 预旋转成固定份数的变体，运行期按角度取图，省掉每帧矩阵运算
        const variants = [];
        for (let i = 0; i < steps; i++) {
            const s = makeCanvas(span, span, BAKE_SS);
            const sc = s.getContext('2d');
            sc.translate(s.width / 2, s.height / 2);
            sc.rotate(i / steps * Math.PI * 2);
            sc.drawImage(base, -base.width / 2, -base.height / 2);
            variants.push(s);
        }
        return { variants: variants, half: span / 2, size: span, steps: steps };
    }

    function bakeSnow(size) {
        const span = size * 3.2;
        const s = makeCanvas(span, span, BAKE_SS);
        const c = s.getContext('2d');
        c.scale(BAKE_SS, BAKE_SS);
        const cx = span / 2, r = size * 0.5;
        const g = c.createRadialGradient(cx, cx, 0, cx, cx, r * 1.6);
        g.addColorStop(0, 'rgba(255,255,255,0.98)');
        g.addColorStop(0.5, 'rgba(236,246,255,0.7)');
        g.addColorStop(1, 'rgba(210,232,255,0)');
        c.fillStyle = g;
        c.beginPath();
        c.arc(cx, cx, r * 1.6, 0, Math.PI * 2);
        c.fill();
        return { img: s, half: cx, size: span };
    }

    function bakeGlow(radius, rgb) {
        const span = radius * 6;
        const s = makeCanvas(span, span, BAKE_SS);
        const c = s.getContext('2d');
        c.scale(BAKE_SS, BAKE_SS);
        const cx = span / 2;
        const g = c.createRadialGradient(cx, cx, 0, cx, cx, radius * 2.6);
        g.addColorStop(0, 'rgba(' + rgb + ',0.95)');
        g.addColorStop(0.35, 'rgba(' + rgb + ',0.34)');
        g.addColorStop(1, 'rgba(' + rgb + ',0)');
        c.fillStyle = g;
        c.beginPath();
        c.arc(cx, cx, radius * 2.6, 0, Math.PI * 2);
        c.fill();
        return { img: s, half: cx, size: span };
    }

    function bakeGlint(radius) {
        const span = radius * 6;
        const s = makeCanvas(span, span, BAKE_SS);
        const c = s.getContext('2d');
        c.scale(BAKE_SS, BAKE_SS);
        const cx = span / 2;
        c.translate(cx, cx);
        c.strokeStyle = 'rgba(255,247,216,0.95)';
        c.lineWidth = 1.5;
        c.lineCap = 'round';                   // 臂尖圆润，避免平头硬切
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
        return { img: s, half: cx, size: span };
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

    // 星点：柔光小圆点（不画十字——十字是星芒 glint 的视觉身份，圆点拉开层次）
    function bakeStar(coreR) {
        const span = coreR * 5;
        const s = makeCanvas(span, span, BAKE_SS);
        const c = s.getContext('2d');
        c.scale(BAKE_SS, BAKE_SS);
        const cx = span / 2;
        const g = c.createRadialGradient(cx, cx, 0, cx, cx, coreR * 2.2);
        g.addColorStop(0, 'rgba(255,255,255,0.95)');
        g.addColorStop(0.4, 'rgba(240,247,255,0.42)');
        g.addColorStop(1, 'rgba(220,235,255,0)');
        c.fillStyle = g;
        c.beginPath();
        c.arc(cx, cx, coreR * 2.2, 0, Math.PI * 2);
        c.fill();
        return { img: s, half: cx, size: span };
    }

    // 雨丝：头亮尾透的渐变细线，替代纯色 fillRect
    function bakeRainStreak() {
        const W = 6, H = 40;
        const s = makeCanvas(W, H, BAKE_SS);
        const c = s.getContext('2d');
        c.scale(BAKE_SS, BAKE_SS);
        const g = c.createLinearGradient(0, 0, 0, H);
        g.addColorStop(0, 'rgba(222,238,255,0.05)');
        g.addColorStop(0.55, 'rgba(222,238,255,0.5)');
        g.addColorStop(1, 'rgba(232,244,255,0.95)');
        c.strokeStyle = g;
        c.lineCap = 'round';
        c.lineWidth = 3;
        c.beginPath();
        c.moveTo(W / 2, 1.5);
        c.lineTo(W / 2, H - 1.5);
        c.stroke();
        return { img: s, w: W, h: H };
    }

    // 风痕：水平渐变细带（尾端渐隐），与雨丝统一质感
    function bakeWindStreak() {
        const W = 64, H = 4;
        const s = makeCanvas(W, H, BAKE_SS);
        const c = s.getContext('2d');
        c.scale(BAKE_SS, BAKE_SS);
        const g = c.createLinearGradient(0, 0, W, 0);
        g.addColorStop(0, 'rgba(222,238,255,0.05)');
        g.addColorStop(1, 'rgba(232,244,255,0.85)');
        c.strokeStyle = g;
        c.lineCap = 'round';
        c.lineWidth = 1.6;
        c.beginPath();
        c.moveTo(1.5, H / 2);
        c.lineTo(W - 1.5, H / 2);
        c.stroke();
        return { img: s, w: W, h: H };
    }

    let baked = false;
    function bakeSprites() {
        if (baked) return;
        const sizes = [5, 10, 17];      // 远 / 中 / 近三档花瓣
        const steps = LOW_MEM ? [16, 16, 24] : [24, 24, 32];   // 旋转档数：24 步=15°/档，低于感知阈值
        SPR.petal = sizes.map((s, i) => bakePetal(s, false, steps[i]));
        SPR.petalSoft = sizes.map((s, i) => bakePetal(s, true, steps[i]));
        SPR.snow = [4, 7, 11].map(bakeSnow);
        SPR.glowWarm = bakeGlow(11, '255,214,140');
        SPR.glowCool = bakeGlow(11, '196,224,255');
        SPR.glint = bakeGlint(7);
        SPR.fog = bakeFog(120);         // 雾保持 1x：绘制放大 1.5~2.2 倍，糊是特性
        SPR.stars = [bakeStar(1.4), bakeStar(2.2)];
        SPR.rain = bakeRainStreak();
        SPR.wind = bakeWindStreak();
        baked = true;
    }

    function petalSet() { return state.tone === 'bright' ? SPR.petalSoft : SPR.petal; }

    // ================= 粒子构造 =================
    function makeParticle(kind) {
        return { k: kind, x: 0, y: 0, vx: 0, vy: 0, dx: 0, sub: 0, size: 0,
                 a: 0.6, amp: 0, f: 0, ph: 0, rot: 0, vr: 0, g: 0,
                 life: 0, max: 1, scale: 1, len: 1 };
    }

    function resetParticle(p, kind) {
        p.k = kind;
        p.x = 0; p.y = 0; p.vx = 0; p.vy = 0; p.dx = 0; p.sub = 0; p.size = 0;
        p.a = 0.6; p.amp = 0; p.f = 0; p.ph = 0; p.rot = 0; p.vr = 0; p.g = 0;
        p.life = 0; p.max = 1; p.scale = 1; p.len = 1;
        return p;
    }

    function acquirePart(kind) {
        const p = partFree.pop() || makeParticle(kind);
        return resetParticle(p, kind);
    }

    function spawnGroup(g, scale) {
        const n = Math.max(1, Math.round(g.count * scale));
        for (let i = 0; i < n; i++) {
            if (parts.length >= CFG.MAX_DRAWABLES) return;
            const p = acquirePart(g.kind);

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
                p.rot = rnd(0, 6.28);                 // 弧度
                p.sub = rnd(0, 6.28);                 // 副摆相位

            } else if (g.kind === K_SNOW) {
                p.size = g.size;
                p.x = rnd(0, state.w);
                p.y = rnd(-state.h, state.h);
                p.vy = rnd(g.vy[0], g.vy[1]);
                p.a = rnd(g.a[0], g.a[1]);
                p.amp = rnd(g.sway[0], g.sway[1]);
                p.f = rnd(0.3, 0.9);
                p.ph = rnd(0, 6.28);
                p.sub = rnd(0, 6.28);                 // 副摆相位

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
                p.size = Math.random() < 0.75 ? 0 : 1;  // 星点档位（两档柔光 sprite）
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
        // rich 档放宽 dpr 上限换清晰度；省电档位与低内存设备维持 1.5
        const cap = (state.level === 'rich' && !LOW_MEM) ? CFG.DPR_CAP_RICH : CFG.DPR_CAP;
        let dpr = Math.min(window.devicePixelRatio || 1, cap);
        // 像素预算：1080p×1.5 已经 580 万像素，32 位老机软件光栅/显存扛不住。
        // 粒子本身是柔光贴图，宁可降低 canvas 分辨率也不要让整页掉帧。
        const budget = LOW_MEM ? CFG.PIXEL_BUDGET_LOW : CFG.PIXEL_BUDGET;
        if (w * h * dpr * dpr > budget) {
            dpr = Math.max(0.6, Math.min(dpr, Math.sqrt(budget / (w * h))));
        }
        state.dpr = dpr;
        state.pixelBudget = budget;
        const nw = Math.max(1, Math.round(w * dpr));
        const nh = Math.max(1, Math.round(h * dpr));
        // 只有尺寸真的变了才写 width/height：写同值也会重置 backing store，
        // 部分 Chrome 版本会因此在 GPU 进程里累积大 canvas 纹理。
        if (cv.width !== nw || cv.height !== nh) {
            cv.width = nw;
            cv.height = nh;
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function effectiveScale() {
        let scale = CFG.SCALE[state.level] || 1;
        if (state.downgrade >= 1) scale *= 0.6;
        if (state.downgrade >= 3) scale *= 0.75;
        if (state.reduced) scale *= 0.7;
        return scale;
    }

    function buildPreset(type, scale) {
        // 对象回池：画质切换/天气切换不再每次 new 几十个对象，减少 32 位机上的 GC 抖动
        for (let i = 0; i < parts.length; i++) {
            if (partFree.length < 128) partFree.push(parts[i]);
        }
        parts.length = 0;
        for (let i = 0; i < oneshots.length; i++) {
            if (oneFree.length < 64) oneFree.push(oneshots[i]);
        }
        oneshots.length = 0;
        state.buildAt = performance.now();     // 重建后全场 0.9s 淡入，避免闪现
        const groups = PRESETS[type] || PRESETS.sakura;
        for (let i = 0; i < groups.length; i++) {
            const g = groups[i];
            if (state.noGlint && g.kind === K_GLINT) continue;
            if (state.noHeavy && (g.kind === K_MOTE || g.kind === K_FOG)) continue;
            spawnGroup(g, scale);
        }
    }

    // ================= 主循环 =================
    function diagEvent(type, data) {
        try {
            if (window.ElainaDiag && typeof window.ElainaDiag.record === 'function') {
                window.ElainaDiag.record(type, data);
            }
        } catch (e) { /* 诊断不能反过来影响主循环 */ }
    }

    // 单调度器：任何时刻最多只有一个 pending rAF。
    // 旧实现 tick() 里调 applyQuality()，applyQuality() 又 requestAnimationFrame，
    // tick 末尾再排一次，每切一次画质就多一条链，长跑会指数级恶化。
    function scheduleFrame() {
        if (!state.running || state.paused) return;
        const gen = state.rafGen;
        state.rafLive++;
        state.rafId = requestAnimationFrame(function (ts) {
            // 旧代际/已暂停的回调直接退出，不能去减新一代的计数
            if (gen !== state.rafGen || !state.running || state.paused) return;
            if (state.rafLive > 0) state.rafLive--;
            tick(ts);
        });
    }

    function cancelFrame() {
        if (state.rafId) {
            try { cancelAnimationFrame(state.rafId); } catch (e) { /* 忽略 */ }
            state.rafId = 0;
        }
        state.rafLive = 0;
    }

    // 重启整个循环：generation +1 让所有旧回调在下一帧自动失效
    function restartLoop(reason) {
        state.running = false;
        state.rafGen++;
        cancelFrame();
        if (!state.started || state.paused || state.level === 'off') return;
        state.running = true;
        state.last = 0;
        state.lastDraw = 0;
        state.acc = 0;
        state.gapEma = 0;
        state.drawEma = 0;
        state.drawGapEma = 0;
        state.overMs = 0;
        state.okMs = 0;
        state.baselineGap = 0;
        state.baselineSamples = 0;
        state.lastTickAt = performance.now();
        scheduleFrame();
        if (reason) diagEvent('raf-restart', { reason: reason, rafLive: state.rafLive });
    }

    function tick(ts) {
        if (!state.running || state.paused) return;
        state.lastTickAt = performance.now();
        state.tickCount++;
        if (!state.last) state.last = ts;
        let gap = ts - state.last;
        if (gap < 0) gap = 0;
        state.last = ts;
        state.acc += gap;

        const cap = 1000 / Math.max(1, state.fpsCap);
        if (state.acc < cap) { scheduleFrame(); return; }
        const dt = Math.min(state.acc, 100) / 1000;   // 卡顿时钳制，避免粒子瞬移
        state.acc = 0;

        // 距上一次真正绘制的墙钟间隔：跳帧时它比 rAF 间隔大，用它衡量「实际出帧节奏」
        const drawGap = state.lastDraw ? Math.min(ts - state.lastDraw, 1000) : cap;
        state.lastDraw = ts;

        const t0 = performance.now();
        let changed = false;
        try {
            render(dt);
            changed = sampleQuality(gap, performance.now() - t0, drawGap, cap);
            state.errCount = 0;
        } catch (e) {
            state.errCount++;
            diagEvent('fx-error', {
                message: e && e.message ? e.message : String(e),
                stack: e && e.stack ? String(e.stack).slice(0, 600) : '',
                count: state.errCount
            });
            // 连续错误说明状态已经不可信：停下并留给 watchdog/诊断，不要热循环刷屏
            if (state.errCount > 10) {
                state.running = false;
                state.rafGen++;
                cancelFrame();
                return;
            }
        }
        if (changed) {
            // 画质状态已经由 sampleQuality 改好；这里只负责重建循环时序
            restartLoop('quality');
            return;
        }
        scheduleFrame();
    }

    let curAlpha = -1;
    function setAlpha(a) {
        if (a < 0) a = 0; else if (a > 1) a = 1;
        if (Math.abs(a - curAlpha) < 0.012) return;
        ctx.globalAlpha = a;
        curAlpha = a;
    }

    let curPetalSet = null;                  // render 开头 hoist，避免逐粒子查色调

    function drawPetal(size, rot, x, y, alpha) {
        const set = curPetalSet[size];
        const steps = set.steps;
        const idx = (((rot * steps / 6.2831853) % steps + steps) % steps) | 0;   // rot 为弧度
        const spr = set.variants[idx];
        setAlpha(alpha);
        ctx.drawImage(spr, x - set.half, y - set.half, set.size, set.size);
    }

    function render(dt) {
        const W = state.w, H = state.h;
        ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);
        curAlpha = -1;
        curPetalSet = petalSet();
        // 构建淡入：切天气 / 自适应降级重建时全场 0.9s 淡入，消除整体闪现
        const gFade = state.buildAt ? Math.min(1, (performance.now() - state.buildAt) / 900) : 1;

        // ---- 常驻粒子 ----
        for (let i = parts.length - 1; i >= 0; i--) {
            const p = parts[i];
            if (p.dx || p.vx) p.x += (p.dx + (p.vx || 0)) * dt;
            if (p.vx) p.vx *= Math.pow(0.3, dt);       // 阵风冲量指数衰减
            p.y += p.vy * dt;
            if (p.f) p.ph += p.f * dt;
            if (p.sub) p.sub += p.f * 0.37 * dt;       // 副摆相位（花瓣/雪花双频摇摆）

            switch (p.k) {
                case K_PETAL: {
                    if (p.vr) p.rot += p.vr * dt;
                    if (p.y > H + 30) { p.y = -30; p.x = rnd(0, W); }
                    const x = p.x + Math.sin(p.ph) * p.amp + Math.sin(p.sub) * p.amp * 0.35;
                    if (x < -60) p.x = W + 40; else if (x > W + 60) p.x = -40;
                    const edge = p.y < 48 ? Math.max(0, Math.min(1, (p.y + 24) / 72)) : 1;
                    drawPetal(p.size, p.rot, x, p.y, p.a * gFade * edge);
                    break;
                }
                case K_SNOW: {
                    if (p.y > H + 20) { p.y = -20; p.x = rnd(0, W); }
                    const spr = SPR.snow[p.size];
                    const x = p.x + Math.sin(p.ph) * p.amp + Math.sin(p.sub) * p.amp * 0.35;
                    const edge = p.y < 48 ? Math.max(0, Math.min(1, (p.y + 24) / 72)) : 1;
                    setAlpha(p.a * gFade * edge);
                    ctx.drawImage(spr.img, x - spr.half, p.y - spr.half, spr.size, spr.size);
                    break;
                }
                case K_MOTE: {
                    if (p.y < -40) { p.y = H + 40; p.x = rnd(0, W); }
                    if (p.x < -40) p.x = W + 40; else if (p.x > W + 40) p.x = -40;
                    const spr = p.size ? SPR.glowCool : SPR.glowWarm;
                    const sz = spr.size * p.scale;
                    setAlpha(p.a * gFade * (0.55 + 0.45 * Math.sin(p.ph)));
                    ctx.drawImage(spr.img, p.x - sz / 2, p.y - sz / 2, sz, sz);
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
                    const sz = spr.size * p.scale * (0.7 + 0.5 * k);
                    setAlpha(p.a * k * gFade);
                    ctx.drawImage(spr.img, p.x - sz / 2, p.y - sz / 2, sz, sz);
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
                    const spr = SPR.rain;
                    setAlpha(p.a * gFade);
                    ctx.drawImage(spr.img, p.x | 0, p.y | 0, p.size, p.len);
                    break;
                }
                case K_STAR: {
                    setAlpha(p.a * (0.55 + 0.45 * Math.sin(p.ph)) * gFade);
                    const spr = SPR.stars[p.size];
                    ctx.drawImage(spr.img, (p.x - spr.half) | 0, (p.y - spr.half) | 0, spr.size, spr.size);
                    break;
                }
                case K_FOG: {
                    const spr = SPR.fog;
                    if (p.x < -spr.half * p.scale) { p.x = W + spr.half * p.scale * 0.6; p.y = rnd(H * 0.3, H); }
                    setAlpha(p.a * gFade);
                    ctx.drawImage(spr.img, p.x - spr.half * p.scale,
                                  p.y - spr.img.height * p.scale / 2,
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
                    const sz = spr.size * p.scale * (0.7 + 0.5 * k);
                    setAlpha(p.a * k);
                    ctx.drawImage(spr.img, p.x - sz / 2, p.y - sz / 2, sz, sz);
                    break;
                }
                case K_MOTE: {
                    const spr = p.size ? SPR.glowCool : SPR.glowWarm;
                    const sz = spr.size * p.scale;
                    setAlpha(p.a * (1 - t) * (0.6 + 0.4 * Math.sin(p.ph * 3 + p.life * 6)));
                    ctx.drawImage(spr.img, p.x - sz / 2, p.y - sz / 2, sz, sz);
                    break;
                }
                case K_STREAK: {
                    if (p.sub === 1) {                 // 雨溅：竖直小水柱
                        ctx.fillStyle = 'rgb(214,232,255)';
                        setAlpha(p.a * (1 - t));
                        ctx.fillRect(p.x | 0, (p.y - t * 8) | 0, 1, 3 + t * 3);
                    } else {                          // 风痕：横向渐变细带
                        const spr = SPR.wind;
                        setAlpha(p.a * (1 - t));
                        ctx.drawImage(spr.img, p.x | 0, (p.y + Math.sin(t * 6) * 6 - spr.h / 2) | 0, p.len, spr.h);
                    }
                    break;
                }
            }
        }
    }

    // ================= 自适应质量 =================
    // 关键修复：判据不再假设 60Hz。先学习当前设备的 rAF 基线，
    // 30Hz / Chrome 省电模式 / MIUI 限帧下 33ms 是正常的，不能当掉帧。
    function sampleQuality(gap, drawMs, drawGap, targetGap) {
        if (document.hidden || state.paused) return false;
        if (!(gap > 0)) return false;
        // 合成器长时间不出帧（息屏 / 窗口被遮挡 / 切到后台）时不计入采样，恢复后重新学习
        if (gap > CFG.STALL_MS) {
            state.gapEma = 0; state.drawEma = 0; state.drawGapEma = 0;
            state.overMs = 0; state.okMs = 0;
            state.baselineGap = 0; state.baselineSamples = 0;
            return false;
        }

        // 基线学习：前 60 个有效帧取 EMA；太离谱的 gap 不参与，避免 4K 解码/GC 一次就学歪
        if (state.baselineSamples < CFG.BASELINE_SAMPLES) {
            if (gap < 120) {
                state.baselineGap = state.baselineGap ? state.baselineGap * 0.9 + gap * 0.1 : gap;
                state.baselineSamples++;
            }
            if (state.baselineSamples < CFG.BASELINE_SAMPLES) return false;
        }
        const base = Math.max(8, Math.min(50, state.baselineGap || 16.7));

        state.gapEma = state.gapEma ? state.gapEma * 0.88 + gap * 0.12 : gap;
        state.drawEma = state.drawEma ? state.drawEma * 0.88 + drawMs * 0.12 : drawMs;
        state.drawGapEma = state.drawGapEma ? state.drawGapEma * 0.88 + drawGap * 0.12 : drawGap;

        // 两条通道：
        //   gapEma     —— 浏览器给的刷新节奏，按当前设备基线放大 1.6 倍判卡
        //   drawGapEma —— 我们自己的出帧间隔，按目标帧间隔倍数判掉帧
        const jank = state.gapEma > Math.max(CFG.JANK_MS, base * 1.6) ||
                     state.drawEma > CFG.DRAW_BUDGET_MS ||
                     state.drawGapEma > targetGap * CFG.DRAW_SLACK;
        const roomy = state.gapEma < base * 1.25 &&
                      state.drawEma < CFG.DRAW_ROOMY_MS &&
                      state.drawGapEma < targetGap * CFG.DRAW_ROOMY_SLACK;

        if (jank) { state.overMs += drawGap; state.okMs = 0; }
        else if (roomy) { state.okMs += drawGap; state.overMs = 0; }
        else { state.overMs = 0; state.okMs = 0; }

        const now = performance.now();
        if (now - state.lastQualityChange < CFG.QUALITY_COOLDOWN_MS) return false;

        if (state.overMs > CFG.QUALITY_DOWN_MS && state.downgrade < 3) {
            state.downgrade++;
            state.overMs = 0; state.okMs = 0;
            state.lastQualityChange = now;
            state.transitions++;
            applyQuality();
            diagEvent('quality', {
                dir: 'down', downgrade: state.downgrade, gap: +gap.toFixed(1),
                base: +base.toFixed(1), drawMs: +drawMs.toFixed(2), drawGap: +drawGap.toFixed(1)
            });
            return true;
        }
        if (state.okMs > CFG.QUALITY_UP_MS && state.downgrade > 0) {
            state.downgrade--;
            state.overMs = 0; state.okMs = 0;
            state.lastQualityChange = now;
            state.transitions++;
            applyQuality();
            diagEvent('quality', {
                dir: 'up', downgrade: state.downgrade, gap: +gap.toFixed(1),
                base: +base.toFixed(1), drawMs: +drawMs.toFixed(2), drawGap: +drawGap.toFixed(1)
            });
            return true;
        }
        return false;
    }

    // 把内部档位映射到 body 上的降级类（只影响粒子/装饰，不再关毛玻璃）
    function syncBodyClasses() {
        if (!document.body) return;
        document.body.classList.toggle('fx-low', state.downgrade >= 2 && state.level !== 'off');
        document.body.classList.toggle('fx-off', state.level === 'off');
    }

    function applyQuality() {
        if (state.level === 'off') { syncBodyClasses(); return; }

        let cap = CFG.FPS_CAP[state.level] || 30;
        state.noGlint = state.downgrade >= 1;
        state.noHeavy = state.downgrade >= 2;
        if (state.downgrade >= 3) cap = Math.min(cap, 18);
        if (state.reduced) cap = Math.min(cap, 20);
        state.fpsCap = cap;

        syncBodyClasses();
        buildPreset(state.preset, effectiveScale());
        // 注意：这里不再自己 requestAnimationFrame；由 tick 末尾 / restartLoop 统一调度
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
            if (!document.hidden && !state.paused && state.level !== 'off' && !state.running) {
                restartLoop('resize');
            }
        }, 200);
    }

    function onVisibility() {
        if (!state.started) return;
        if (document.hidden) {
            if (state.running) stop();
            return;
        }
        // 恢复可见：重新学习刷新基线，别拿息屏期间的数据继续判断
        state.baselineGap = 0;
        state.baselineSamples = 0;
        if (state.paused || state.level === 'off') return;
        const age = state.lastTickAt ? performance.now() - state.lastTickAt : Infinity;
        if (!state.running || age > CFG.TICK_STALL_MS) {
            restartLoop('visibility');
        }
    }

    let lastRecoverAt = 0;
    function recoverIfNeeded() {
        if (!state.started || state.paused || document.hidden || state.level === 'off') return;
        const now = performance.now();
        if (now - lastRecoverAt < 1000) return;   // 输入事件很多，1s 内只检查一次
        const age = state.lastTickAt ? now - state.lastTickAt : Infinity;
        if (!state.running || age > 1500 || state.rafLive > 1) {
            lastRecoverAt = now;
            restartLoop('recover');
        }
    }

    function watchdog() {
        if (!state.started) return;
        if (document.hidden) {
            if (state.running) stop();
            return;
        }
        if (state.paused || state.level === 'off') return;
        const now = performance.now();
        const age = state.lastTickAt ? now - state.lastTickAt : Infinity;
        if (!state.running || age > CFG.TICK_STALL_MS || state.rafLive > 1) {
            restartLoop('watchdog');
        }
    }

    function bindEvents() {
        window.addEventListener('resize', onResize);
        window.addEventListener('orientationchange', onResize);
        document.addEventListener('visibilitychange', onVisibility);
        // 不只依赖 visibilitychange：MIUI/Chrome 偶发漏事件时，焦点/触摸/毛玻璃恢复也能救回来
        window.addEventListener('pageshow', recoverIfNeeded);
        window.addEventListener('focus', recoverIfNeeded);
        window.addEventListener('pointerdown', recoverIfNeeded, { passive: true });
        window.addEventListener('touchstart', recoverIfNeeded, { passive: true });
        try { document.addEventListener('resume', recoverIfNeeded); } catch (e) { /* 忽略 */ }
        setInterval(watchdog, CFG.WATCHDOG_MS);
    }

    // ================= 对外接口 =================
    function readLevel() {
        let lv = null;
        try { lv = localStorage.getItem(CFG.LEVEL_KEY); } catch (e) { lv = null; }
        if (LEVELS.indexOf(lv) >= 0) return lv;
        // 未配置过：低端机起手就轻一档
        try {
            const cores = navigator.hardwareConcurrency || 4;
            // 沿用与 LOW_MEM 相同的判断（Android 4GB 及以下、少核心、无 deviceMemory 的移动端）
            if (cores <= 4 || LOW_MEM) return 'light';
        } catch (e) { /* 忽略 */ }
        return CFG.DEFAULT_LEVEL;
    }

    function clearCanvas() {
        if (!ctx || !cv) return;
        try {
            ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
            ctx.clearRect(0, 0, state.w, state.h);
            curAlpha = -1;
        } catch (e) { /* 忽略 */ }
    }

    function start() {
        if (state.started) {
            if (state.paused) setPaused(false);
            else recoverIfNeeded();
            return;
        }
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
        restartLoop('start');
    }

    function stop() {
        state.running = false;
        state.rafGen++;
        cancelFrame();
    }

    function setPaused(paused) {
        paused = !!paused;
        if (state.paused === paused) return;
        state.paused = paused;
        if (paused) {
            state.running = false;
            state.rafGen++;
            cancelFrame();
            diagEvent('fx-paused', { paused: true });
        } else if (state.started && state.level !== 'off') {
            restartLoop('unpaused');
            diagEvent('fx-paused', { paused: false });
        }
    }

    function refreshGlass() {
        // 让 script.js 重新挂一次动态毛玻璃（Chromium 偶发丢 backdrop 表面时用）
        try {
            window.dispatchEvent(new CustomEvent('elaina:refresh-glass'));
        } catch (e) { /* 忽略 */ }
    }

    function setLevel(level) {
        if (LEVELS.indexOf(level) < 0) return;
        state.level = level;
        try { localStorage.setItem(CFG.LEVEL_KEY, level); } catch (e) { /* 忽略 */ }
        if (!state.started) { start(); return; }
        if (level === 'off') {
            stop();
            clearCanvas();
            syncBodyClasses();
            return;
        }
        state.downgrade = 0;
        state.overMs = 0;
        state.okMs = 0;
        state.baselineGap = 0;
        state.baselineSamples = 0;
        state.lastQualityChange = 0;
        fitCanvas();               // dpr 上限随档位变化（rich→2），画布需重设
        applyQuality();
        if (!state.paused) restartLoop('setLevel');
    }

    function setWeather(type, opts) {
        const next = PRESETS[type] ? type : 'sakura';
        const thunder = !!(opts && opts.thunder);
        if (next === state.preset && thunder === state.thunder && state.started) return;
        state.preset = next;
        state.thunder = thunder;
        if (!state.started || state.level === 'off') return;
        buildPreset(next, effectiveScale());
        // 雷阵雨：雨势再加一档（暂停时也先建好，恢复后直接显示）
        if (thunder) spawnGroup(PRESETS.rain[0], 18 / PRESETS.rain[0].count);
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
        setPaused: setPaused,
        refreshGlass: refreshGlass,
        setLevel: setLevel,
        getLevel: () => state.level,
        getDeviceInfo: () => ({
            lowMem: LOW_MEM,
            cores: navigator.hardwareConcurrency || null,
            deviceMemory: (typeof navigator.deviceMemory === 'number') ? navigator.deviceMemory : null,
            dpr: state.dpr,
            pixelBudget: state.pixelBudget
        }),
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
                paused: state.paused,
                hidden: !!document.hidden,
                level: state.level,
                preset: state.preset,
                tone: state.tone,
                downgrade: state.downgrade,
                transitions: state.transitions,
                fpsCap: state.fpsCap,
                rafLive: state.rafLive,
                rafGen: state.rafGen,
                tickAge: state.lastTickAt ? Math.round(performance.now() - state.lastTickAt) : -1,
                tickCount: state.tickCount,
                baselineGap: +state.baselineGap.toFixed(2),
                pixelBudget: state.pixelBudget,
                canvasPixels: cv ? cv.width * cv.height : 0,
                gapMs: +state.gapEma.toFixed(2),
                drawGapMs: +state.drawGapEma.toFixed(2),
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

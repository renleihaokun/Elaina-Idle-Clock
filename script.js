/**
 * 伊蕾娜の魔法手账 - 核心逻辑 (稳定版)
 */

// ================= 配置与常量 =================
const CONFIG = {
    API_URL: 'https://elaina.haokun.me',                           // 原图兜底（只给非低端设备）
    THUMB_MANIFEST: 'https://elaina.haokun.me/imgs/thumb/manifest.json',
    THUMB_BASE: 'https://elaina.haokun.me/imgs/thumb/',
    THUMB_CACHE_KEY: 'elaina_thumb_manifest',
    THUMB_CACHE_TTL_MS: 24 * 60 * 60 * 1000,
    THUMB_TIMEOUT_MS: 8000,
    BG_SWITCH_MINUTES: 5,
    BG_LOAD_TIMEOUT_MS: 12000,
    BG_PRELOAD_DELAY_MS: 1800,                                     // 旧层淡出后再预加载下一张，避免打断过渡
    WEATHER_UPDATE_MINUTES: 30,
    QUOTE_UPDATE_MINUTES: 10,
    AUTO_RELOAD_HOUR: 4                                            // 低端机每日自愈刷新时间
};

// 环境特效档位：索引即设置面板滑块的取值
const FX_LEVELS = ['off', 'light', 'normal', 'rich'];

let state = {
    currentWeatherType: 'sakura',
    isThunder: false,
    activeBg: 1,
    currentScale: 1.0,
    isPressing: false,
    pressTimer: null,
    pressStart: null,        // { x, y, t, onBackground }：区分短按星芒与长按爆发
    coursePressTimer: null,
    shakeCooldown: false,
    lastShake: { x: 0, y: 0, z: 0 },
    lastMotionTs: 0,
    lastTouchTs: 0,
    weatherRetryCount: 0,
    weatherTimer: null,
    weatherSeq: 0,
    weatherInFlight: false,
    weatherPending: false,
    lastWeatherFetchAt: 0,
    bgTimer: null,
    bgPreloadTimer: null,
    bgSeq: 0,
    bgLoading: null,
    bgPending: null,
    bgApplying: false,
    bgSwapping: false,
    bgReady: false,
    bgEverReady: false,
    bgCurrentName: '',
    bgCurrentKind: '',
    bgSwitchDueAt: 0,
    bgAuditFails: 0,
    reloadAttemptedAt: 0,
    thumbManifest: null,
    thumbManifestAt: 0,
    thumbVersion: '',
    glassPref: 'auto',
    glassMode: 'static',
    glassImageUrl: '',
    glassBuildSeq: 0,
    glassLayoutTimer: 0,
    maskDark: false,
    panelOpen: false,
    hiddenAt: 0,
    autoReload: false,
    autoReloadTimer: null,
    lastInteraction: Date.now(),
    toastTimer: null,
    timeTimer: null,
    quoteTimer: null,
    lastPulseHour: -1,       // 整点脉冲去重
    thunderTimer: null,
    thunderClearTimer: null,
    suppressCourseClick: false,   // 长按翘课后，抑制同一次交互顺带打开导入框
    lunarCacheDay: '',            // 农历/节日按天缓存，避免每秒重建 Lunar 对象
    lunarCache: null,
    lastCourseMinute: ''          // 课表按分钟刷新（比「秒数==0」更抗定时器漂移）
};

// ================= 通用工具 =================
// localStorage 里的数据可能被手改、被旧版本写坏；解析失败必须降级，不能把 init 打断
function safeParse(raw, fallback) {
    if (!raw) return fallback;
    try {
        const v = JSON.parse(raw);
        return v == null ? fallback : v;
    } catch (e) {
        return fallback;
    }
}

// 带超时的 fetch：老手机弱网下请求可能长期挂起，超时后走同一套降级逻辑
async function fetchWithTimeout(url, ms) {
    if (typeof AbortController === 'undefined') return fetch(url);
    const ctl = new AbortController();
    const timer = setTimeout(() => {
        try { ctl.abort(); } catch (e) { /* 忽略 */ }
    }, ms || 12000);
    try {
        return await fetch(url, { signal: ctl.signal });
    } finally {
        clearTimeout(timer);
    }
}

// 诊断记录：diag.js 没加载时也不能影响主流程
function diag(type, data) {
    try {
        if (window.ElainaDiag && typeof window.ElainaDiag.record === 'function') {
            window.ElainaDiag.record(type, data);
        }
    } catch (e) { /* 忽略 */ }
}

// 低端判定：Android + 内存/核心数。32 位 Android 10 / MIUI 12.5 通常都在这个范围，
// 直接决定“实时毛玻璃”还是“预模糊静态毛玻璃”，以及原图兜底是否允许。
function isLowEndDevice() {
    try {
        const ua = navigator.userAgent || '';
        if (!/Android/i.test(ua)) return false;
        const mem = navigator.deviceMemory;
        const cores = navigator.hardwareConcurrency || 8;
        if (typeof mem === 'number') return mem <= 4 || cores <= 4;
        return cores <= 4;
    } catch (e) {
        return false;
    }
}

function supportsBackdropFilter() {
    try {
        return !!(window.CSS && CSS.supports &&
            (CSS.supports('backdrop-filter', 'blur(1px)') ||
             CSS.supports('-webkit-backdrop-filter', 'blur(1px)')));
    } catch (e) {
        return false;
    }
}

// 非阻塞提示：替代 alert，避免系统对话框把页面看起来像卡死
function showToast(text) {
    const el = document.getElementById('toast');
    if (!el) {
        try { alert(text); } catch (e) { /* 忽略 */ }
        return;
    }
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

// 屏幕常亮：挂机场景屏幕必须亮着。浏览器要求用户手势后才能申请，
// 因此挂在任意首次交互上；切后台会被系统自动释放，重新可见时再补一次。
let wakeLock = null;

function requestWakeLock() {
    if (!navigator.wakeLock || wakeLock) return;
    try {
        const req = navigator.wakeLock.request('screen');
        if (!req || typeof req.then !== 'function') return;
        req.then(lock => {
            wakeLock = lock;
            lock.addEventListener('release', () => { wakeLock = null; });
        }).catch(() => { /* 系统拒绝或不支持：静默降级，不影响时钟本体 */ });
    } catch (e) { /* 忽略 */ }
}

// ================= 初始化 =================
function init() {
    state.autoReload = loadAutoReloadPref();
    initGlassMode();          // 先定毛玻璃模式，避免首屏先 live 再切 static 闪一下
    startFX();
    setupUI();
    setupEventListeners();
    syncMaskState();          // 读取上次亮度，恢复夜间黑屏状态

    updateTime();
    state.timeTimer = setInterval(updateTime, 1000);

    changeBackground();
    scheduleBackgroundSwitch();

    fetchWitchQuote();
    state.quoteTimer = setInterval(fetchWitchQuote, CONFIG.QUOTE_UPDATE_MINUTES * 60 * 1000);

    updateBattery();
    updateCourseDisplay();
    scheduleGlassLayout();

    fetchWeather();
    initAutoReload();
}

// ================= 特效接线 =================
// effects.js 未加载（或被浏览器拦截）时全部退化为无操作，不影响时钟本体
function fx() {
    return (typeof window.ElainaFX !== 'undefined' && window.ElainaFX) ? window.ElainaFX : null;
}

function startFX() {
    const api = fx();
    if (!api) return;
    api.start();
    api.setWeather(state.currentWeatherType, { thunder: state.isThunder });
}

// ================= UI 控制 =================
function setupUI() {
    let savedScale = '';
    try { savedScale = localStorage.getItem('elaina_ui_scale') || ''; } catch (e) { savedScale = ''; }
    const parsed = parseFloat(savedScale);
    if (Number.isFinite(parsed) && parsed >= 0.5 && parsed <= 1.5) {
        state.currentScale = parsed;
    } else {
        state.currentScale = window.innerWidth < 600 ? 0.85 : 1.0;
    }

    updateUIScale(state.currentScale);
    const slider = document.getElementById('scale-slider');
    if (slider) slider.value = state.currentScale;

    // 环境特效档位：持久化交给 effects.js，这里同步 UI
    const fxSlider = document.getElementById('fx-level-slider');
    if (fxSlider) {
        const api = fx();
        const saved = api ? api.getLevel() : (localStorage.getItem('elaina_fx_level') || 'normal');
        const idx = Math.max(0, FX_LEVELS.indexOf(saved));
        fxSlider.value = idx;
        updateFxLevelLabel(idx);
    }

    // 毛玻璃模式
    const glassSelect = document.getElementById('glass-mode-select');
    if (glassSelect) glassSelect.value = state.glassMode;
    updateGlassModeLabel();

    // 每日自愈刷新
    const autoToggle = document.getElementById('auto-reload-toggle');
    if (autoToggle) autoToggle.checked = !!state.autoReload;

    // 填充巴法云配置输入框
    var bemfaUid = '';
    var bemfaTopic = '';
    try {
        bemfaUid = localStorage.getItem('elaina_bemfa_uid') || '';
        bemfaTopic = localStorage.getItem('elaina_bemfa_topic') || '';
    } catch (e) { /* 忽略 */ }
    var uidEl = document.getElementById('bemfa-uid');
    var topicEl = document.getElementById('bemfa-topic');
    if (uidEl && bemfaUid) uidEl.value = bemfaUid;
    if (topicEl && bemfaTopic) topicEl.value = bemfaTopic;
}

function updateUIScale(val) {
    const n = parseFloat(val);
    const scale = Number.isFinite(n) ? Math.max(0.5, Math.min(1.5, n)) : 1;
    state.currentScale = scale;
    document.documentElement.style.setProperty('--ui-scale', scale);
    const valEl = document.getElementById('scale-value');
    if (valEl) valEl.innerText = Math.round(scale * 100) + '%';
    try { localStorage.setItem('elaina_ui_scale', scale); } catch (e) { /* 忽略 */ }
    scheduleGlassLayout();
}

function updateFxLevelLabel(idx) {
    const el = document.getElementById('fx-level-value');
    if (!el) return;
    const api = fx();
    const fallback = { off: '关闭', light: '轻盈', normal: '标准', rich: '华丽' };
    el.textContent = api ? api.levelLabel(FX_LEVELS[idx]) : (fallback[FX_LEVELS[idx]] || '标准');
}

function applyFxLevel(idx) {
    const level = FX_LEVELS[idx] || 'normal';
    const api = fx();
    if (api) {
        api.setLevel(level);
    } else {
        try { localStorage.setItem('elaina_fx_level', level); } catch (e) { /* 忽略 */ }
    }
    updateFxLevelLabel(idx);
    // 背景轮换间隔随档位变化，立即按新档位重排，而不是等下一次 fire
    scheduleBackgroundSwitch();
}

function togglePanel(panelId) {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    document.querySelectorAll('.modal-panel').forEach(p => {
        if (p.id !== panelId) p.style.display = 'none';
    });
    const isVisible = panel.style.display === 'block';
    panel.style.display = isVisible ? 'none' : 'block';
    let anyOpen = false;
    document.querySelectorAll('.modal-panel').forEach(p => {
        if (p.style.display === 'block') anyOpen = true;
    });
    state.panelOpen = anyOpen;
    document.body.classList.toggle('panel-open', anyOpen);
    syncFxPaused();
}

// ================= 气象更新引擎 =================
// 单飞：同一时刻只允许一个天气请求。以前 saveLocation 连续调用会留下多个
// 孤儿 timer，每个 timer 又各自 fetch，越跑越多。
async function fetchWeather() {
    if (state.weatherInFlight) {
        state.weatherPending = true;
        return;
    }
    if (state.weatherTimer) {
        clearTimeout(state.weatherTimer);
        state.weatherTimer = null;
    }
    state.weatherInFlight = true;
    state.weatherSeq++;
    const seq = state.weatherSeq;
    const weatherMainEl = document.getElementById('weather-main');
    let scheduleNext = CONFIG.WEATHER_UPDATE_MINUTES * 60 * 1000;

    // 隐藏 / 夜间黑屏时不发请求，等恢复可见/亮屏时再补
    if (document.hidden || state.maskDark) {
        state.weatherInFlight = false;
        state.weatherTimer = setTimeout(fetchWeather, 5 * 60 * 1000);
        return;
    }
    state.lastWeatherFetchAt = Date.now();

    try {
        let lat, lon, locName = '';
        const savedLoc = safeParse(localStorage.getItem('elaina_location'), null);

        if (savedLoc && Number.isFinite(savedLoc.lat) && Number.isFinite(savedLoc.lon)) {
            lat = savedLoc.lat; lon = savedLoc.lon; locName = savedLoc.name || '';
        } else {
            // 坏配置直接清掉，否则每次刷新都会解析失败、永远退不出去
            if (localStorage.getItem('elaina_location')) localStorage.removeItem('elaina_location');
            const geoRes = await fetchWithTimeout('https://get.geojs.io/v1/ip/geo.json', 10000);
            const geoData = await geoRes.json();
            lat = geoData.latitude || 39.9;
            lon = geoData.longitude || 116.4;
            locName = geoData.city || '北京';
        }

        const weatherRes = await fetchWithTimeout(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code`, 12000);
        const weatherData = await weatherRes.json();

        if (!weatherData.current) throw new Error('API error');

        state.weatherRetryCount = 0;
        localStorage.setItem('elaina_weather_cache', JSON.stringify({
            current: weatherData.current,
            locName: locName,
            timestamp: Date.now()
        }));

        updateWeatherUI(weatherData.current, locName);

    } catch (err) {
        state.weatherRetryCount++;
        scheduleNext = state.weatherRetryCount === 1 ? 10000 : (state.weatherRetryCount === 2 ? 300000 : 1800000);

        const cached = safeParse(localStorage.getItem('elaina_weather_cache'), null);
        if (cached && cached.current) {
            updateWeatherUI(cached.current, cached.locName || '');
        }

        if (weatherMainEl && !weatherMainEl.textContent.includes('°C')) {
            weatherMainEl.textContent = "🌐 气象魔法感知中...";
        }
        diag('weather-error', { retry: state.weatherRetryCount, message: err && err.message ? err.message : String(err) });
    } finally {
        state.weatherInFlight = false;
        if (state.weatherPending) {
            state.weatherPending = false;
            fetchWeather();
            return;
        }
        if (seq === state.weatherSeq) {
            state.weatherTimer = setTimeout(fetchWeather, scheduleNext);
        }
    }
}

function updateWeatherUI(current, locName) {
    const code = current.weather_code;
    const temp = current.temperature_2m;
    const feelsLike = current.apparent_temperature;
    const humidity = current.relative_humidity_2m;
    const hour = new Date().getHours();
    const isNight = hour >= 19 || hour < 6;
    
    let icon = '☁️', text = '多云', advice = '是个适合旅行的好天气。';
    state.currentWeatherType = 'sakura'; 
    state.isThunder = false;

    if (code === 0) {
        icon = '☀️'; text = '晴朗';
        state.currentWeatherType = isNight ? 'star' : 'sakura';
    }
    else if (code >= 1 && code <= 3) { icon = '⛅'; text = '多云'; }
    else if (code >= 45 && code <= 48) {
        icon = '🌫️'; text = '雾'; state.currentWeatherType = 'fog';
    }
    else if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) { 
        icon = '🌧️'; text = '降雨'; state.currentWeatherType = 'rain'; 
    }
    else if ((code >= 71 && code <= 77) || code === 85 || code === 86) { 
        icon = '❄️'; text = '降雪'; state.currentWeatherType = 'snow'; 
    }
    else if (code >= 95) {
        icon = '⛈️'; text = '雷阵雨'; state.currentWeatherType = 'rain'; state.isThunder = true;
    }

    if (state.currentWeatherType === 'rain') advice = '下雨了，带好伞保护魔法书。';
    else if (state.currentWeatherType === 'snow') advice = '下雪了，气温骤降注意保暖。';
    else if (state.currentWeatherType === 'fog') advice = '雾气很重，出门当心迷路。';
    else if (isNight && code === 0) advice = '星星很亮，是个适合旅行的夜晚。';
    else if (temp > 30) advice = '阳光刺眼，注意防暑防晒。';

    const mainEl = document.getElementById('weather-main');
    const detEl = document.getElementById('weather-details');
    const advEl = document.getElementById('weather-advice');
    if (mainEl) mainEl.textContent = `[${locName}] ${icon} ${text} ${temp}°C`;
    if (detEl) detEl.textContent = `体感 ${feelsLike}°C | 湿度 ${humidity}%`;
    if (advEl) advEl.textContent = `* ${advice}`;

    const api = fx();
    if (api) api.setWeather(state.currentWeatherType, { thunder: state.isThunder });
    scheduleThunder();
}

// ================= 课表处理 (侧边分组布局 - 纵向贯穿版) =================
function updateCourseDisplay() {
    let stored = '';
    try { stored = localStorage.getItem('elaina_courses') || ''; } catch (e) { stored = ''; }
    const labelEl = document.getElementById('course-label');
    const itemsContainer = document.getElementById('course-items-container');
    
    if (!labelEl || !itemsContainer) return;

    // 从未导入过课表：显示中性标签，别让「加载中」在挂机页上永远转下去
    if (!stored) {
        labelEl.textContent = '课表';
        return;
    }

    const courses = safeParse(stored, []);
    if (!Array.isArray(courses)) return;

    const now = new Date();
    const nowTime = now.getTime();
    const allFutureCourses = courses
        .filter(c => c && Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > nowTime)
        .sort((a, b) => a.start - b.start);

    if (allFutureCourses.length === 0) {
        labelEl.textContent = "自由";
        itemsContainer.innerHTML = `<span id="course-title">✨ 近期无课</span>`;
        return;
    }

    // 1. 获取基准时段
    const baseCourse = allFutureCourses[0];
    const baseDate = new Date(baseCourse.start);
    
    const getPeriodLabel = (h) => {
        if (h < 12) return "上午";
        if (h < 18.5) return "下午";
        return "晚课";
    };
    
    const getDayLabel = (date) => {
        const dStr = date.toDateString();
        if (dStr === now.toDateString()) return "接下来";
        const tomorrow = new Date(nowTime + 86400000).toDateString();
        if (dStr === tomorrow) return "明天";
        const afterTomorrow = new Date(nowTime + 172800000).toDateString();
        if (dStr === afterTomorrow) return "后天";
        return `${date.getMonth() + 1}/${date.getDate()}`;
    };

    const basePeriod = getPeriodLabel(baseDate.getHours());
    const baseDay = getDayLabel(baseDate);
    const baseDateStr = baseDate.toDateString();

    // 2. 筛选同时段课程并进行去重处理
    const seenFocus = new Set();
    const focusCourses = allFutureCourses.filter(c => {
        const d = new Date(c.start);
        const isSamePeriod = d.toDateString() === baseDateStr && getPeriodLabel(d.getHours()) === basePeriod;
        if (!isSamePeriod) return false;
        
        // 使用标题、时间、地点作为唯一标识进行去重
        const key = `${c.title}-${c.start}-${c.end}-${c.location}`;
        if (seenFocus.has(key)) return false;
        seenFocus.add(key);
        return true;
    }).slice(0, 2);

    // 3. 确定当前状态（用于实时更新左侧标签）
    let currentStatus = null;
    focusCourses.forEach(c => {
        if (nowTime >= c.start && nowTime <= c.end) {
            currentStatus = c.skipped ? "翘课中" : "上课中";
        }
    });
    
    // 更新左侧纵向标签：优先显示实时状态
    labelEl.textContent = currentStatus || `${baseDay}·${basePeriod}`;
    renderCourseItems(itemsContainer, focusCourses, nowTime);
}

// 课程项一律走 DOM API：.ics 的标题/地点属于外部输入，拼进 innerHTML 会变成 XSS
function renderCourseItems(container, courses, nowTime) {
    const fmt = (d) => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    const frag = document.createDocumentFragment();

    courses.forEach((c, index) => {
        const sd = new Date(c.start), ed = new Date(c.end);
        const isNow = (nowTime >= c.start && nowTime <= c.end);

        if (index > 0) {
            const divider = document.createElement('div');
            divider.className = 'course-v-divider';
            frag.appendChild(divider);
        }

        const item = document.createElement('div');
        item.className = 'course-item' + (c.skipped ? ' skipped' : '') + (isNow ? ' ongoing' : '');
        item.dataset.title = c.title || '';
        item.dataset.start = String(c.start);
        item.dataset.end = String(c.end);

        const name = document.createElement('span');
        name.className = 'course-name-row';
        if (isNow && !c.skipped) name.style.color = '#ff9a9e';
        name.textContent = c.title || '';

        const time = document.createElement('span');
        time.className = 'course-time-row';
        time.textContent = `${fmt(sd)} - ${fmt(ed)}`;

        const loc = document.createElement('span');
        loc.className = 'course-loc-row';
        loc.textContent = c.location || '未知';

        item.appendChild(name);
        item.appendChild(time);
        item.appendChild(loc);
        frag.appendChild(item);
    });

    container.textContent = '';
    container.appendChild(frag);
}

function toggleSkipCourse(title, start, end) {
    let stored = '';
    try { stored = localStorage.getItem('elaina_courses') || ''; } catch (e) { stored = ''; }
    if (!stored) return;
    
    let courses = safeParse(stored, []);
    if (!Array.isArray(courses)) return;

    let found = false;
    let isSkipping = false;

    courses = courses.map(c => {
        if (c && c.title === title && c.start === start && c.end === end) {
            c.skipped = !c.skipped;
            found = true;
            isSkipping = c.skipped;
        }
        return c;
    });

    if (found) {
        try { localStorage.setItem('elaina_courses', JSON.stringify(courses)); } catch (e) { /* 忽略 */ }
        updateCourseDisplay();

        const api = fx();
        if (api) api.puffAt(document.getElementById('course-items-container'));
        
        const txt = document.getElementById('hitokoto-text');
        if (txt) {
            if (isSkipping) {
                const skipQuotes = [
                    "「诶？这节课要翘掉吗？真是个不爱学习的坏学生呢。」",
                    "「逃课去休息？虽然我不讨厌追求自由的人，但知识也是魔法的基础哦。」",
                    "「既然你这么想休息，那就把变聪明的机会留给我这位天才魔女好了。」",
                    "「敢在我的注视下翘课，你的胆量倒是值得称赞呢，呵呵。」",
                    "「不想去上课？那就把自己关在房间里写日记吧，就像我那样。」",
                    "「虽然翘课很刺激，但如果因此变成笨蛋，我可不会承认认识你哦。」",
                    "「在这种地方偷懒，难道是在等哪位美丽的魔女带你去旅行吗？」"
                ];
                txt.innerText = skipQuotes[Math.floor(Math.random() * skipQuotes.length)];
            } else {
                txt.innerText = "「哦？打算回去上课了吗？这种迷途知返的行为倒也不坏。」";
            }
        }
    }
}

// 长按事件用委托绑定在容器上：课程项每次重建都不需要重新挂 handler，
// 标题/时间从 dataset 取，避免把外部输入拼进内联事件属性。
function startCoursePress(e) {
    const target = e.target;
    const item = target && target.closest ? target.closest('.course-item.ongoing') : null;
    if (!item) return;

    e.stopPropagation(); // 防止触发背景的魔法爆发
    state.suppressCourseClick = false;   // 新的按下动作开始，清掉上一次可能残留的抑制标记
    clearTimeout(state.coursePressTimer);
    state.coursePressTimer = setTimeout(() => {
        state.coursePressTimer = null;
        state.suppressCourseClick = true;   // 长按后不要顺带打开课表导入框（由随后的 click 消费）
        toggleSkipCourse(item.dataset.title || '', Number(item.dataset.start), Number(item.dataset.end));
    }, 800);
}

function cancelCoursePress() {
    clearTimeout(state.coursePressTimer);
    state.coursePressTimer = null;
}

// ================= 特效与交互 =================
// 雷阵雨的低亮度闪屏：一次性动画，带冷却，不叠加
function spawnThunder() {
    const flash = document.getElementById('magic-flash');
    if (!flash) return;
    flash.classList.remove('thunder');
    void flash.offsetWidth;              // 强制回流，保证连续两次闪都能重播
    flash.classList.add('thunder');
    // 移除 class 用独立定时器：不能和「下一次闪烁」的调度共用 handle，
    // 否则后者会清掉前者，class 永远留在 DOM 上
    clearTimeout(state.thunderClearTimer);
    state.thunderClearTimer = setTimeout(() => flash.classList.remove('thunder'), 1200);
}

function scheduleThunder() {
    clearTimeout(state.thunderTimer);
    // 注意：这里不能清 thunderClearTimer，否则 spawnThunder 刚设的
    // “移除 thunder class” 会被立刻清掉，class 会一直留在 DOM 上。
    if (!state.isThunder) return;        // 天气转晴时把待播的闪屏一并取消
    if (document.hidden || state.maskDark) return;
    state.thunderTimer = setTimeout(() => {
        spawnThunder();
        scheduleThunder();
    }, Math.random() * 14000 + 6000);
}

function triggerMagicExplosion() {
    if (state.maskDark) return;
    const flash = document.getElementById('magic-flash');
    if (flash) {
        flash.style.opacity = '1';
        setTimeout(() => { flash.style.opacity = '0'; }, 600);
    }
    const api = fx();
    if (api) {
        // 长按位置优先，其次取屏幕中心
        const pt = state.pressStart || { x: window.innerWidth / 2, y: window.innerHeight / 2 };
        api.burst(pt.x, pt.y);
    }
    const txt = document.getElementById('hitokoto-text');
    const aut = document.getElementById('hitokoto-author');
    if (txt) txt.innerText = "「你在期待什么奇迹发生吗？可惜，这里只有一位美丽的魔女。」";
    if (aut) aut.innerText = "—— 灰之魔女 伊蕾娜";
    const p = changeBackground('explosion');
    if (p && typeof p.finally === 'function') p.finally(() => scheduleBackgroundSwitch());
    else scheduleBackgroundSwitch();
}

// ================= 定位与搜索 =================
async function autoLocate() {
    const resDiv = document.getElementById('loc-results');
    if (resDiv) resDiv.innerHTML = '<div class="loc-item">正在请求定位权限...</div>';
    if (!navigator.geolocation) {
        if (resDiv) resDiv.innerHTML = '<div class="loc-item">浏览器不支持定位，可手动搜索城市。</div>';
        return;
    }
    navigator.geolocation.getCurrentPosition(async pos => {
        const { latitude: lat, longitude: lon } = pos.coords;
        try {
            const res = await fetchWithTimeout(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=zh`, 10000);
            const data = await res.json();
            saveLocation(lat, lon, data.locality || data.city || "当前位置");
        } catch(e) { saveLocation(lat, lon, "当前位置"); }
    }, () => {
        if (resDiv) resDiv.innerHTML = '<div class="loc-item">定位失败，可手动搜索城市。</div>';
    }, { timeout: 10000 });
}

function saveLocation(lat, lon, name) {
    try { localStorage.setItem('elaina_location', JSON.stringify({ lat, lon, name })); } catch (e) { /* 忽略 */ }
    togglePanel('location-panel');
    fetchWeather();
}

async function searchLocation() {
    const query = document.getElementById('loc-input').value.trim();
    const resDiv = document.getElementById('loc-results');
    if (!query || !resDiv) return;
    resDiv.innerHTML = '<div class="loc-item">正在穿透网络迷雾...</div>';
    try {
        const res = await fetchWithTimeout(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=10&language=zh`, 10000);
        const data = await res.json();
        resDiv.textContent = '';
        (data.results || []).forEach(item => {
            const div = document.createElement('div');
            div.className = 'loc-item';
            div.textContent = `📍 ${item.name} `;

            const sub = document.createElement('span');
            sub.className = 'loc-item-sub';
            sub.textContent = `${item.admin1 || ''} ${item.country || ''}`.trim();
            div.appendChild(sub);

            div.onclick = () => saveLocation(item.latitude, item.longitude, item.name);
            resDiv.appendChild(div);
        });
    } catch (e) { resDiv.innerHTML = '<div class="loc-item">搜索失败。</div>'; }
}

// ================= 时间与状态 =================
// 每秒只做取值与比较，DOM 写入前先判等：
// 时间只显示到分钟、日期/农历/周末倒计时按天变，真正的宽度变化约每 86 秒一次。
// 老手机长期挂机时，这能省掉大量无意义的重排与重绘。
function updateTime() {
    if (document.hidden || state.maskDark) return;
    const now = new Date();
    const fmt = (n) => String(now[`get${n}`]()).padStart(2, '0');
    const timeEl = document.getElementById('time');
    const dateEl = document.getElementById('date');

    if (timeEl) {
        const text = `${fmt('Hours')}:${fmt('Minutes')}`;
        if (timeEl.textContent !== text) timeEl.textContent = text;
    }
    if (dateEl) {
        const days = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
        const text = `${now.getMonth() + 1}月${now.getDate()}日 ${days[now.getDay()]}`;
        if (dateEl.textContent !== text) dateEl.textContent = text;
    }

    if (window.Lunar) {
        // 农历 / 节气 / 节日按天变化，缓存一天只算一次，避免每秒重建 Lunar 对象
        const dayKey = now.toDateString();
        if (dayKey !== state.lunarCacheDay) {
            state.lunarCacheDay = dayKey;
            try {
                const lunarDate = Lunar.fromDate(now);
                state.lunarCache = {
                    date: `${lunarDate.getMonthInChinese()}月${lunarDate.getDayInChinese()}`,
                    holiday: lunarDate.getFestivals()[0] || Solar.fromDate(now).getFestivals()[0] || lunarDate.getJieQi() || ''
                };
            } catch (e) { state.lunarCache = null; }
        }
        const lDateEl = document.getElementById('lunar-date');
        const hTagEl = document.getElementById('holiday-tag');
        if (lDateEl && state.lunarCache) lDateEl.textContent = state.lunarCache.date;
        if (hTagEl) hTagEl.textContent = (state.lunarCache && state.lunarCache.holiday) ? `[${state.lunarCache.holiday}]` : '';
    }

    const wcdEl = document.getElementById('weekend-countdown');
    if (wcdEl) {
        const dayIdx = now.getDay();
        const text = (dayIdx === 6 || dayIdx === 0) ? '✨ 已经是周末啦！' : `⏳ 距周末还有 ${6 - dayIdx} 天`;
        if (wcdEl.textContent !== text) wcdEl.textContent = text;
    }

    const progTE = document.getElementById('progress-text');
    const progFE = document.getElementById('progress-fill');
    if (progTE && progFE) {
        const passed = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
        const progress = ((passed / 86400) * 100).toFixed(1);
        const text = `${progress}%`;
        if (progTE.textContent !== text) {
            progTE.textContent = text;
            progFE.style.width = text;   // 宽度由内联样式驱动，只在百分比真正变化时写
        }
    }

    // 每跨一分钟刷新一次课表：用「年月日时分」做 key，
    // 比 now.getSeconds()===0 稳，定时器抖动错过第 0 秒也不会漏掉整分钟
    const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
    if (minuteKey !== state.lastCourseMinute) {
        state.lastCourseMinute = minuteKey;
        try { updateCourseDisplay(); } catch (e) { /* 坏课表数据不能打断时间显示 */ }
    }

    // 整点：一圈星芒脉冲，给常驻画面一个时间刻度
    if (now.getMinutes() === 0 && state.lastPulseHour !== now.getHours()) {
        state.lastPulseHour = now.getHours();
        const api = fx();
        if (api) api.hourPulse();
    }
}

function fetchWitchQuote() {
    if (document.hidden || state.maskDark) return;
    if (state.shakeCooldown) return;
    const witchQuotes = [
        { text: "这种美丽可爱，甚至有些令人怜爱的美少女到底是谁呢？没错，就是我。", author: "伊蕾娜" },
        { text: "请不要在意。我是旅人，得继续赶路才行。", author: "伊蕾娜" },
        { text: "别哭，伊蕾娜。重要的不是结果，而是你在这个过程中学到了什么。", author: "芙兰" },
        { text: "在这个广阔的世界里，我只是一个顺路经过的魔女。", author: "伊蕾娜" },
        { text: "哪怕是被雨淋湿，被泥沾污，也一定要坚持走下去。", author: "伊蕾娜" },
        { text: "我是一个旅人。我必须继续我的旅行。", author: "伊蕾娜" },
        { text: "不要为了不属于你的东西哭泣。无论多么痛苦，都要学会接受它。", author: "芙兰" },
        { text: "如果不努力的话，就没有权利去追求梦想。", author: "芙兰" },
        { text: "这世上所有的不期而遇，都是理所当然的巧合。", author: "伊蕾娜" },
        { text: "书上的故事总是有个美好的结局，但现实的旅行可不会总如人意。", author: "伊蕾娜" }
    ];
    const quote = witchQuotes[Math.floor(Math.random() * witchQuotes.length)];
    const textEl = document.getElementById('hitokoto-text');
    const authEl = document.getElementById('hitokoto-author');
    if (textEl) textEl.innerText = `「${quote.text}」`;
    if (authEl) authEl.innerText = `—— ${quote.author}`;

    const api = fx();
    if (api) api.puffAt(textEl);
}

// ================= 壁纸管线 =================
function activeBgEl() {
    return document.getElementById(state.activeBg === 1 ? 'bg1' : 'bg2');
}

function inactiveBgEl() {
    return document.getElementById(state.activeBg === 1 ? 'bg2' : 'bg1');
}

function readThumbCache() {
    let cached = null;
    try { cached = safeParse(localStorage.getItem(CONFIG.THUMB_CACHE_KEY), null); } catch (e) { cached = null; }
    if (cached && Array.isArray(cached.images) && cached.images.length) return cached;
    return null;
}

async function loadThumbManifest() {
    if (state.thumbManifest && state.thumbManifest.length &&
        Date.now() - state.thumbManifestAt < CONFIG.THUMB_CACHE_TTL_MS) {
        return state.thumbManifest;
    }
    const cached = readThumbCache();
    if (cached && Date.now() - (cached.at || 0) < CONFIG.THUMB_CACHE_TTL_MS) {
        state.thumbManifest = cached.images;
        state.thumbManifestAt = cached.at || 0;
        state.thumbVersion = cached.generatedAt || '';
        return state.thumbManifest;
    }

    try {
        const res = await fetchWithTimeout(CONFIG.THUMB_MANIFEST, CONFIG.THUMB_TIMEOUT_MS);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        const images = (data.images || []).filter(im =>
            im && im.name != null && Number.isFinite(im.w) && Number.isFinite(im.h));
        if (!images.length) throw new Error('empty manifest');
        state.thumbManifest = images;
        state.thumbManifestAt = Date.now();
        state.thumbVersion = data.generatedAt || '';
        try {
            localStorage.setItem(CONFIG.THUMB_CACHE_KEY, JSON.stringify({
                at: Date.now(),
                generatedAt: state.thumbVersion,
                images: images
            }));
        } catch (e) { /* 配额/隐私模式：忽略 */ }
        diag('thumb-manifest', { count: images.length });
        return images;
    } catch (err) {
        diag('thumb-manifest-error', { message: err && err.message ? err.message : String(err) });
        if (cached) {
            state.thumbManifest = cached.images;
            state.thumbManifestAt = cached.at || 0;
            state.thumbVersion = cached.generatedAt || '';
            return state.thumbManifest;
        }
        return null;
    }
}

function pickNextThumb(images) {
    const landscape = images.filter(im => im.w >= im.h);
    const pool = landscape.length ? landscape : images;
    if (!pool.length) return null;
    for (let i = 0; i < 10; i++) {
        const im = pool[Math.floor(Math.random() * pool.length)];
        if (String(im.name) !== String(state.bgCurrentName)) return im;
    }
    return pool[0];
}

function thumbUrl(im) {
    let url = CONFIG.THUMB_BASE + encodeURIComponent(im.name) + '.webp';
    if (state.thumbVersion) url += '?v=' + encodeURIComponent(String(state.thumbVersion).slice(0, 24));
    return url;
}

// 把一张图加载到指定 <img> 层；只有真正 decode 成功、naturalWidth>0 才算成功。
// 不再用「new Image + CSS background」：那样同一张图会按 CORS/非 CORS 各下载/解码一次。
function loadLayer(layer, url) {
    return new Promise(resolve => {
        if (!layer) { resolve(false); return; }
        let done = false;
        let timer = 0;
        const finish = ok => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            layer.onload = null;
            layer.onerror = null;
            resolve(!!ok && layer.naturalWidth > 0);
        };
        layer.style.opacity = '0';
        try { layer.removeAttribute('src'); } catch (e) { /* 忽略 */ }
        layer.crossOrigin = 'anonymous';
        layer.decoding = 'async';
        timer = setTimeout(() => finish(false), CONFIG.BG_LOAD_TIMEOUT_MS);
        layer.onload = () => finish(layer.naturalWidth > 0);
        layer.onerror = () => finish(false);
        layer.src = url;
        if (layer.decode) {
            layer.decode().then(() => finish(layer.naturalWidth > 0), () => finish(false));
        }
    });
}

function preloadNextBackground() {
    if (state.bgLoading) return state.bgLoading;
    state.bgLoading = (async () => {
        try {
            const seq = ++state.bgSeq;
            const layer = inactiveBgEl();
            if (!layer) return false;

            const images = await loadThumbManifest();
        if (images && images.length) {
            for (let attempt = 0; attempt < 3; attempt++) {
                const im = pickNextThumb(images);
                if (!im) break;
                const url = thumbUrl(im);
                const ok = await loadLayer(layer, url);
                if (seq !== state.bgSeq || layer !== inactiveBgEl()) return false;
                if (ok) {
                    state.bgPending = { layer: layer, url: url, name: String(im.name), kind: 'thumb' };
                    diag('bg-preload', { kind: 'thumb', name: String(im.name), w: layer.naturalWidth, h: layer.naturalHeight });
                    return true;
                }
            }
        }

            // 缩略图全挂：只在非低端设备上退回原图；低端机宁可保留上一张/渐变，也不冒 4K 解码的险
            if (!isLowEndDevice()) {
                const url = `${CONFIG.API_URL}/?t=${Date.now()}`;
                const ok = await loadLayer(layer, url);
                if (seq !== state.bgSeq || layer !== inactiveBgEl()) return false;
                if (ok) {
                    state.bgPending = { layer: layer, url: url, name: '', kind: 'orig' };
                    diag('bg-preload', { kind: 'orig', w: layer.naturalWidth, h: layer.naturalHeight });
                    return true;
                }
            }
            return false;
        } catch (e) {
            diag('bg-preload-error', { message: e && e.message ? e.message : String(e) });
            return false;
        }
    })().finally(() => { state.bgLoading = null; });
    return state.bgLoading;
}

function applyPendingBackground() {
    if (state.bgApplying) return false;
    const p = state.bgPending;
    if (!p || !p.layer || !p.layer.naturalWidth) return false;
    const old = activeBgEl();
    if (!old || old === p.layer) { state.bgPending = null; return false; }

    state.bgApplying = true;
    const next = p.layer;
    state.activeBg = next.id === 'bg1' ? 1 : 2;
    state.bgPending = null;
    state.bgReady = true;
    state.bgEverReady = true;
    state.bgCurrentName = p.name || '';
    state.bgCurrentKind = p.kind;

    // 新层已 decode，先亮起新层，再把旧层淡出：
    // 旧代码是先淡出旧层、新层 CSS 背景还在解码，遇到 4K 就会中间黑一下。
    next.style.opacity = '1';
    requestAnimationFrame(() => {
        try { old.style.opacity = '0'; } catch (e) { /* 忽略 */ }
    });

    sampleBgTone(next);
    if (state.glassMode === 'static') buildGlassFromCurrent();

    // 旧层淡出完成后再释放，并预加载下一张（避免在旧层还在用时占用它）
    clearTimeout(state.bgPreloadTimer);
    state.bgPreloadTimer = setTimeout(() => {
        state.bgApplying = false;
        if (activeBgEl() !== old) {
            try { old.removeAttribute('src'); } catch (e) { /* 忽略 */ }
            old.style.opacity = '0';
        }
        if (!document.hidden && !state.maskDark) preloadNextBackground();
    }, 1900);

    diag('bg-apply', { kind: p.kind, name: p.name, w: next.naturalWidth, h: next.naturalHeight });
    return true;
}

function applyFallbackBackground() {
    // 不主动清掉已有图层；两层都空时 body 的深紫渐变会兜底
    const bg1 = document.getElementById('bg1');
    const bg2 = document.getElementById('bg2');
    if (bg1 && (!bg1.getAttribute('src') || bg1.naturalWidth === 0)) bg1.style.opacity = '0';
    if (bg2 && (!bg2.getAttribute('src') || bg2.naturalWidth === 0)) bg2.style.opacity = '0';
    diag('bg-fallback', { reason: 'all-load-failed' });
}

// 背景审计 + 兜底：15s 一次，确认「当前层真的有图、真的可见」。
// 这是黑屏的最后一道保险：图片 404/decode 失败/被清空时，至少 body 渐变还在，
// 连续修不好才做一次受保护的刷新。
function canReloadSafely() {
    try {
        const last = parseInt(sessionStorage.getItem('elaina_last_reload') || '0', 10) || 0;
        return Date.now() - last > 10 * 60 * 1000;
    } catch (e) {
        return true;
    }
}

function safeReload(reason) {
    if (!canReloadSafely()) return;
    try { sessionStorage.setItem('elaina_last_reload', String(Date.now())); } catch (e) { /* 忽略 */ }
    diag('safe-reload', { reason: reason });
    try { location.reload(); } catch (e) { /* 忽略 */ }
}

function auditBackground() {
    if (document.hidden) return;
    if (state.maskDark) {
        const mask = document.getElementById('bemfa-mask');
        if (mask && (parseFloat(getComputedStyle(mask).opacity) || 0) < 0.5) syncMaskState();
        return;
    }

    const active = activeBgEl();
    const other = inactiveBgEl();
    const activeSrc = active ? (active.getAttribute('src') || '') : '';
    const activeOpacity = active ? (parseFloat(getComputedStyle(active).opacity) || 0) : 0;
    const activeGood = !!activeSrc && active.naturalWidth > 0;

    if (activeGood) {
        if (activeOpacity < 0.05) active.style.opacity = '1';
        state.bgAuditFails = 0;
    } else {
        if (active && activeSrc && active.naturalWidth === 0) active.style.opacity = '0';
        if (!activeSrc && other && !other.getAttribute('src')) applyFallbackBackground();
        if (!state.bgLoading && !state.bgApplying) {
            if (state.bgPending) applyPendingBackground();
            else preloadNextBackground();
        }
        // 从来没有成功过 = 图源/网络问题，body 渐变已经是可接受的兜底，不要刷新风暴；
        // 曾经有图、现在突然全没了，才按“黑屏故障”计数并做受保护的刷新。
        if (state.bgEverReady) {
            state.bgAuditFails++;
            if (state.bgAuditFails >= 3) safeReload('background-lost');
        } else {
            state.bgAuditFails = 0;
        }
    }

    if (document.body.classList.contains('glass-static')) {
        if (activeGood && !state.glassImageUrl) buildGlassFromCurrent();
        // 没有 ResizeObserver 的老浏览器：靠 15s 审计兜住内容尺寸变化后的裁切对齐
        scheduleGlassLayout();
    }

    // 特效也有 watchdog；这里从页面侧再加一道，防止脚本层状态错乱
    const api = fx();
    if (api && api.stats) {
        const s = api.stats();
        if (s && (s.rafLive > 1 || (s.running && s.tickAge > 5000))) {
            api.start();
            if (s.tickAge > 5000) kickCompositor();
        }
    }
}

async function changeBackground(reason) {
    try {
        if (document.hidden || state.maskDark) return false;
        if (state.bgApplying) return false;
        if (state.bgPending) return applyPendingBackground();
        const ok = await preloadNextBackground();
        if (state.maskDark || document.hidden) return false;
        if (ok) return applyPendingBackground();
        applyFallbackBackground();
        return false;
    } catch (e) {
        diag('bg-change-error', { reason: reason, message: e && e.message ? e.message : String(e) });
        applyFallbackBackground();
        return false;
    }
}

// 壁纸轮换：低端档位放慢一倍；隐藏/黑屏时暂停，恢复后按剩余时间补上。
function scheduleBackgroundSwitch(delayMs) {
    clearTimeout(state.bgTimer);
    state.bgTimer = null;
    if (state.maskDark || document.hidden) {
        state.bgSwitchDueAt = Date.now() + (delayMs != null ? delayMs : 60 * 1000);
        return;
    }
    let delay = delayMs;
    if (delay == null) {
        const api = fx();
        const level = api ? api.getLevel() : 'normal';
        const minutes = (level === 'light' || level === 'off')
            ? CONFIG.BG_SWITCH_MINUTES * 2
            : CONFIG.BG_SWITCH_MINUTES;
        delay = minutes * 60 * 1000;
    }
    state.bgSwitchDueAt = Date.now() + delay;
    state.bgTimer = setTimeout(() => {
        state.bgTimer = null;
        if (document.hidden || state.maskDark) {
            scheduleBackgroundSwitch(60 * 1000);
            return;
        }
        if (state.bgApplying) {
            scheduleBackgroundSwitch(5000);
            return;
        }
        const p = changeBackground('timer');
        if (p && typeof p.finally === 'function') {
            p.finally(() => scheduleBackgroundSwitch());
        } else {
            scheduleBackgroundSwitch();
        }
    }, delay);
}

// 8×8 缩略图估平均亮度：复用同一块 canvas，切一次图只做一次很小的工作
let toneCanvas = null;
function sampleBgTone(imgEl) {
    try {
        if (!imgEl || !imgEl.naturalWidth) return;
        if (!toneCanvas) { toneCanvas = document.createElement('canvas'); toneCanvas.width = 8; toneCanvas.height = 8; }
        const ctx = toneCanvas.getContext('2d', { willReadFrequently: true });
        ctx.clearRect(0, 0, 8, 8);
        ctx.drawImage(imgEl, 0, 0, 8, 8);
        const d = ctx.getImageData(0, 0, 8, 8).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        const api = fx();
        if (api) api.setBackgroundTone(sum / (d.length / 4));
    } catch (e) { /* 画布被污染/老浏览器不支持 willReadFrequently：忽略 */ }
}

// ================= 静态毛玻璃 =================
function readGlassPref() {
    try {
        const v = localStorage.getItem('elaina_glass_mode');
        if (v === 'live' || v === 'static') return v;
    } catch (e) { /* 忽略 */ }
    return 'auto';
}

function resolveGlassMode(pref) {
    if (pref === 'static') return 'static';
    if (pref === 'live') return supportsBackdropFilter() ? 'live' : 'static';
    if (!supportsBackdropFilter()) return 'static';
    return isLowEndDevice() ? 'static' : 'live';
}

function updateGlassModeLabel() {
    const el = document.getElementById('glass-mode-value');
    if (!el) return;
    if (state.glassPref === 'auto') {
        el.textContent = '自动（' + (state.glassMode === 'static' ? '静态' : '动态') + '）';
    } else {
        el.textContent = state.glassPref === 'static' ? '静态' : '动态';
    }
}

function initGlassMode() {
    state.glassPref = readGlassPref();
    state.glassMode = resolveGlassMode(state.glassPref);
    document.body.classList.toggle('glass-static', state.glassMode === 'static');
    document.body.classList.toggle('glass-live', state.glassMode === 'live');
    const sel = document.getElementById('glass-mode-select');
    if (sel) sel.value = state.glassPref;
    updateGlassModeLabel();
}

function applyGlassMode(pref) {
    state.glassPref = (pref === 'live' || pref === 'static') ? pref : 'auto';
    state.glassMode = resolveGlassMode(state.glassPref);
    document.body.classList.toggle('glass-static', state.glassMode === 'static');
    document.body.classList.toggle('glass-live', state.glassMode === 'live');
    const sel = document.getElementById('glass-mode-select');
    if (sel) sel.value = state.glassPref;
    updateGlassModeLabel();
    try { localStorage.setItem('elaina_glass_mode', state.glassPref === 'auto' ? '' : state.glassPref); } catch (e) { /* 忽略 */ }
    if (state.glassMode === 'static') {
        buildGlassFromCurrent();
        scheduleGlassLayout();
    } else {
        clearGlass();
        const api = fx();
        if (api && api.refreshGlass) api.refreshGlass();
    }
    diag('glass-mode', { pref: state.glassPref, resolved: state.glassMode });
}

let glassCanvas = null;
let glassTemp = null;
function buildGlassFromCurrent() {
    if (state.glassMode !== 'static') return;
    const active = activeBgEl();
    if (!active || !active.naturalWidth) {
        clearGlass();
        return;
    }
    const seq = ++state.glassBuildSeq;
    try {
        const vw = Math.max(1, window.innerWidth);
        const vh = Math.max(1, window.innerHeight);
        const w = 256;
        const h = Math.max(64, Math.round(w * vh / vw));
        const tw = 64;
        const th = Math.max(16, Math.round(tw * vh / vw));

        // 先画一张不透明的小图，再平滑放大：不会像 ctx.filter 那样
        // 在画布边缘把透明/黑色混进来（那会把靠边的卡片压成深灰）。
        if (!glassTemp) glassTemp = document.createElement('canvas');
        glassTemp.width = tw;
        glassTemp.height = th;
        const tctx = glassTemp.getContext('2d');
        const iw = active.naturalWidth, ih = active.naturalHeight;
        const ts = Math.max(tw / iw, th / ih);
        const tdw = iw * ts, tdh = ih * ts;
        tctx.clearRect(0, 0, tw, th);
        tctx.drawImage(active, (tw - tdw) / 2, (th - tdh) / 2, tdw, tdh);

        if (!glassCanvas) glassCanvas = document.createElement('canvas');
        glassCanvas.width = w;
        glassCanvas.height = h;
        const ctx = glassCanvas.getContext('2d');
        ctx.clearRect(0, 0, w, h);
        ctx.imageSmoothingEnabled = true;
        try { ctx.imageSmoothingQuality = 'high'; } catch (e) { /* 忽略 */ }
        ctx.drawImage(glassTemp, 0, 0, w, h);
        // 压一层暗色保证文字对比；太黑会让卡片和壁纸脱节，0.22 比较合适
        ctx.fillStyle = 'rgba(14,10,24,0.22)';
        ctx.fillRect(0, 0, w, h);

        const url = glassCanvas.toDataURL('image/jpeg', 0.65);
        if (seq !== state.glassBuildSeq || state.glassMode !== 'static') return;
        state.glassImageUrl = url;
        document.documentElement.style.setProperty('--glass-image', 'url("' + url + '")');
        scheduleGlassLayout();
    } catch (e) {
        clearGlass();
        diag('glass-build-error', { message: e && e.message ? e.message : String(e) });
    }
}

function layoutGlass() {
    if (state.glassMode !== 'static' || !state.glassImageUrl) return;
    const S = Math.max(0.1, Number(state.currentScale) || 1);
    const vw = Math.max(1, window.innerWidth);
    const vh = Math.max(1, window.innerHeight);
    const widgets = document.querySelectorAll('.widget');
    for (let i = 0; i < widgets.length; i++) {
        const el = widgets[i];
        let ox = 0, oy = 0;
        try {
            const parts = String(getComputedStyle(el).transformOrigin || '0px 0px').split(' ');
            ox = parseFloat(parts[0]) || 0;
            oy = parseFloat(parts[1]) || 0;
        } catch (e) { ox = 0; oy = 0; }
        const left = el.offsetLeft || 0;
        const top = el.offsetTop || 0;
        // 元素先按局部坐标画背景，再被 scale(S) 缩放；
        // 要让背景在屏幕上对齐视口：P = O*(1-1/S) - offset/S
        const px = ox * (1 - 1 / S) - left / S;
        const py = oy * (1 - 1 / S) - top / S;
        el.style.backgroundImage = 'url("' + state.glassImageUrl + '")';
        el.style.backgroundSize = (vw / S) + 'px ' + (vh / S) + 'px';
        el.style.backgroundPosition = px + 'px ' + py + 'px';
        el.style.backgroundRepeat = 'no-repeat';
    }
}

function scheduleGlassLayout() {
    if (state.glassLayoutTimer) return;
    state.glassLayoutTimer = setTimeout(() => {
        state.glassLayoutTimer = 0;
        layoutGlass();
    }, 60);
}

function clearGlass() {
    state.glassImageUrl = '';
    state.glassBuildSeq++;
    document.documentElement.style.removeProperty('--glass-image');
    const widgets = document.querySelectorAll('.widget');
    for (let i = 0; i < widgets.length; i++) {
        const el = widgets[i];
        el.style.backgroundImage = '';
        el.style.backgroundSize = '';
        el.style.backgroundPosition = '';
        el.style.backgroundRepeat = '';
    }
}

// 从长时间隐藏/息屏恢复后，轻轻踢一下合成器：
// 给 body 一个短暂的 translateZ(0) 强制重建根层，同时重挂动态毛玻璃。
function kickCompositor() {
    try {
        const active = activeBgEl();
        if (active && active.getAttribute('src')) active.style.opacity = '1';
        const api = fx();
        if (api && api.refreshGlass) api.refreshGlass();
        document.body.style.transform = 'translateZ(0)';
        void document.body.offsetHeight;
        requestAnimationFrame(() => {
            try { document.body.style.transform = ''; } catch (e) { /* 忽略 */ }
        });
        diag('compositor-kick', {});
    } catch (e) { /* 忽略 */ }
}

// Chromium 偶发丢 backdrop 表面：把 backdrop-filter 摘掉再挂回去，强制重建
function refreshLiveGlass() {
    if (state.glassMode !== 'live') return;
    const widgets = document.querySelectorAll('.widget');
    for (let i = 0; i < widgets.length; i++) {
        widgets[i].style.backdropFilter = 'none';
        widgets[i].style.webkitBackdropFilter = 'none';
    }
    void document.body.offsetHeight;
    requestAnimationFrame(() => {
        for (let i = 0; i < widgets.length; i++) {
            widgets[i].style.backdropFilter = '';
            widgets[i].style.webkitBackdropFilter = '';
        }
    });
}

// ================= 夜间黑屏 / 自愈刷新 =================
function syncFxPaused() {
    const api = fx();
    if (api && api.setPaused) api.setPaused(!!(state.maskDark || state.panelOpen));
}

function syncMaskState(detail) {
    let dark = state.maskDark;
    if (detail && typeof detail.opacity === 'number') {
        dark = detail.opacity >= 0.9;
    } else {
        let brightness = null;
        try { brightness = (window.Bemfa && Bemfa.getBrightness) ? Bemfa.getBrightness() : null; } catch (e) { brightness = null; }
        if (typeof brightness === 'number') {
            dark = brightness <= 8;
        } else {
            const mask = document.getElementById('bemfa-mask');
            if (mask) dark = (parseFloat(getComputedStyle(mask).opacity) || 0) >= 0.9;
        }
    }

    if (dark === state.maskDark) {
        document.body.classList.toggle('screen-dark', dark);
        syncFxPaused();
        return;
    }
    state.maskDark = dark;
    document.body.classList.toggle('screen-dark', dark);

    if (dark) {
        // 黑屏时内容层 display:none，粒子/背景轮换/天气闪屏全部停掉
        clearTimeout(state.bgTimer);
        state.bgTimer = null;
        state.bgSwitchDueAt = Date.now() + 60 * 1000;
        clearTimeout(state.thunderTimer);
        state.thunderTimer = null;
        clearTimeout(state.weatherTimer);
        state.weatherTimer = null;
    } else {
        try {
            updateTime();
            updateCourseDisplay();
            scheduleGlassLayout();
            if (state.glassMode === 'live') refreshLiveGlass();
            if (state.bgPending) applyPendingBackground();
            else if (!state.bgLoading && !state.bgApplying) preloadNextBackground();
            const remain = state.bgSwitchDueAt ? state.bgSwitchDueAt - Date.now() : 0;
            scheduleBackgroundSwitch(Math.max(0, remain));
            if (state.isThunder) scheduleThunder();
            if (Date.now() - (state.lastWeatherFetchAt || 0) > 5 * 60 * 1000) fetchWeather();
        } catch (e) {
            diag('mask-wake-error', { message: e && e.message ? e.message : String(e) });
        }
    }
    syncFxPaused();
    diag('mask', { dark: dark, opacity: detail ? detail.opacity : null });
}

function loadAutoReloadPref() {
    try {
        const v = localStorage.getItem('elaina_auto_reload');
        if (v === '0') return false;
        if (v === '1') return true;
    } catch (e) { /* 忽略 */ }
    // 默认关闭：04:00 的整页刷新会释放 Wake Lock，可能让常亮屏在刷新后睡下去。
    // 如果用户愿意用“每天短暂重载”换浏览器级兜底，可在设置里手动打开。
    return false;
}

function setAutoReload(on) {
    state.autoReload = !!on;
    try { localStorage.setItem('elaina_auto_reload', state.autoReload ? '1' : '0'); } catch (e) { /* 忽略 */ }
    const t = document.getElementById('auto-reload-toggle');
    if (t) t.checked = state.autoReload;
    scheduleAutoReload();
    diag('auto-reload-setting', { on: state.autoReload });
}

function scheduleAutoReload(delayMs) {
    clearTimeout(state.autoReloadTimer);
    state.autoReloadTimer = null;
    if (!state.autoReload) return;
    let delay = delayMs;
    if (delay == null) {
        const now = new Date();
        const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), CONFIG.AUTO_RELOAD_HOUR, 0, 0, 0);
        if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
        delay = target.getTime() - now.getTime();
    }
    state.autoReloadTimer = setTimeout(() => {
        state.autoReloadTimer = null;
        if (!state.autoReload) return;
        // 最近 10 分钟有交互就顺延，别在用户正在看的时候刷新
        if (document.hidden || Date.now() - state.lastInteraction > 10 * 60 * 1000) {
            try { sessionStorage.setItem('elaina_last_reload', String(Date.now())); } catch (e) { /* 忽略 */ }
            diag('auto-reload', {});
            try { location.reload(); } catch (e) { /* 忽略 */ }
            return;
        }
        scheduleAutoReload(30 * 60 * 1000);
    }, Math.max(1000, delay));
}

function initAutoReload() {
    const t = document.getElementById('auto-reload-toggle');
    if (t) t.checked = !!state.autoReload;
    scheduleAutoReload();
}

// ================= 事件监听 =================
function setupEventListeners() {
    const slider = document.getElementById('scale-slider');
    const fxSlider = document.getElementById('fx-level-slider');
    const glassSelect = document.getElementById('glass-mode-select');
    const autoToggle = document.getElementById('auto-reload-toggle');
    const ics = document.getElementById('ics-upload');
    if (slider) slider.addEventListener('input', e => updateUIScale(e.target.value));
    if (fxSlider) fxSlider.addEventListener('input', e => applyFxLevel(parseInt(e.target.value, 10)));
    if (glassSelect) glassSelect.addEventListener('change', e => applyGlassMode(e.target.value));
    if (autoToggle) autoToggle.addEventListener('change', e => setAutoReload(e.target.checked));
    if (ics) ics.addEventListener('change', handleIcsUpload);

    window.addEventListener('mousedown', startPress);
    window.addEventListener('touchstart', startPress, { passive: true });
    window.addEventListener('mouseup', cancelPress);
    window.addEventListener('touchend', cancelPress);
    window.addEventListener('devicemotion', handleMotion);

    // 记录交互时间（每日自愈刷新避开用户操作），并驱动毛玻璃/背景的重排
    ['pointerdown', 'touchstart', 'keydown'].forEach(evt => {
        window.addEventListener(evt, () => { state.lastInteraction = Date.now(); }, { passive: true });
    });
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('orientationchange', onViewportChange);
    window.addEventListener('elaina:brightness', e => {
        const d = e && e.detail ? e.detail : {};
        syncMaskState(d);
    });
    window.addEventListener('elaina:refresh-glass', refreshLiveGlass);

    // 控件/文字尺寸变化会影响静态玻璃的裁切位置
    if (window.ResizeObserver) {
        try {
            const ro = new ResizeObserver(() => scheduleGlassLayout());
            document.querySelectorAll('.widget').forEach(el => ro.observe(el));
        } catch (e) { /* 忽略 */ }
    }
    if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => scheduleGlassLayout()).catch(() => {});
    }

    // 黑屏/背景丢失/特效链异常的最后一道自检
    setInterval(auditBackground, 15000);

    // 课程长按：委托到容器，课程项重建时无需重新绑定
    const courseContainer = document.getElementById('course-items-container');
    if (courseContainer) {
        courseContainer.addEventListener('mousedown', startCoursePress);
        courseContainer.addEventListener('touchstart', startCoursePress, { passive: true });
        courseContainer.addEventListener('mouseup', cancelCoursePress);
        courseContainer.addEventListener('mouseleave', cancelCoursePress);
        courseContainer.addEventListener('touchend', cancelCoursePress);
        courseContainer.addEventListener('touchcancel', cancelCoursePress);
    }

    // 点击课表卡片导入 .ics；长按翘课后的那次 click 要吞掉，否则会误打开文件选择框
    const courseSection = document.querySelector('.bottom-right');
    if (courseSection) {
        courseSection.addEventListener('click', () => {
            if (state.suppressCourseClick) { state.suppressCourseClick = false; return; }
            const input = document.getElementById('ics-upload');
            if (input) input.click();
        });
    }

    // 屏幕常亮：浏览器要求用户手势后才能申请，首次交互时补上
    ['pointerdown', 'touchstart', 'mousedown'].forEach(evt => {
        window.addEventListener(evt, requestWakeLock, { passive: true });
    });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            state.hiddenAt = Date.now();
            return;
        }
        const away = state.hiddenAt ? Date.now() - state.hiddenAt : 0;
        state.hiddenAt = 0;
        requestWakeLock();
        updateTime();
        updateCourseDisplay();
        syncMaskState();
        if (away > 2000) refreshLiveGlass();
        if (away > 5000) kickCompositor();
        if (!state.maskDark) {
            if (!state.bgPending && !state.bgApplying) preloadNextBackground();
            const remain = state.bgSwitchDueAt ? state.bgSwitchDueAt - Date.now() : null;
            if (remain != null) scheduleBackgroundSwitch(Math.max(0, remain));
            else scheduleBackgroundSwitch();
            if (Date.now() - (state.lastWeatherFetchAt || 0) > 5 * 60 * 1000) fetchWeather();
        }
    });
}

// 视口/方向变化：静态玻璃要重新生成（宽高比变了），布局也要重算
let viewportGlassTimer = 0;
function onViewportChange() {
    clearTimeout(viewportGlassTimer);
    viewportGlassTimer = setTimeout(() => {
        if (state.glassMode === 'static') buildGlassFromCurrent();
        scheduleGlassLayout();
    }, 250);
}

function handleIcsUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        const events = parseIcs(ev.target.result);
        if (events.length > 0) {
            try { localStorage.setItem('elaina_courses', JSON.stringify(events)); } catch (err) { /* 忽略 */ }
            showToast("✅ 课表记录完成。");
            updateCourseDisplay();
        } else {
            showToast("⚠️ 没有解析到有效课程，请确认文件是 .ics 格式。");
        }
        e.target.value = '';   // 允许再次选择同一个文件
    };
    reader.onerror = () => {
        showToast("⚠️ 文件读取失败。");
        e.target.value = '';
    };
    reader.readAsText(file);
}

function parseIcs(data) {
    const events = [], lines = data.split(/\r?\n/);
    let curr = null;

    const parseICSTime = (s) => {
        if (!s || s.length < 8) return 0;
        const y = parseInt(s.substring(0, 4)), m = parseInt(s.substring(4, 6)) - 1, d = parseInt(s.substring(6, 8));
        if (s.length >= 15 && s.includes('T')) {
            const h = parseInt(s.substring(9, 11)), min = parseInt(s.substring(11, 13)), sec = parseInt(s.substring(13, 15));
            return s.endsWith('Z') ? Date.UTC(y, m, d, h, min, sec) : new Date(y, m, d, h, min, sec).getTime();
        }
        return new Date(y, m, d).getTime();
    };

    const sameDay = (a, b) => {
        const da = new Date(a), db = new Date(b);
        return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
    };

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        while (i + 1 < lines.length && (lines[i+1].startsWith(' ') || lines[i+1].startsWith('\t'))) {
            line += lines[i+1].substring(1); i++;
        }

        if (line.startsWith('BEGIN:VEVENT')) curr = { exdates: [] };
        else if (line.startsWith('END:VEVENT')) {
            // 缺 DTSTART 或 DTEND 的事件直接丢弃，避免 NaN 时间戳混进课表
            if (curr && curr.start && curr.end) {
                if (curr.rrule) {
                    let cs = new Date(curr.start), ce = new Date(curr.end), r = curr.rrule;
                    let interval = (r.match(/INTERVAL=(\d+)/) || [0, 1])[1] * 1;
                    let count = (r.match(/COUNT=(\d+)/) || [0, 0])[1] * 1;
                    let untilMatch = r.match(/UNTIL=(\d{8}(T\d{6}Z?)?)/);
                    let until = untilMatch ? parseICSTime(untilMatch[1]) : Infinity;

                    if (count === 0 && until === Infinity) count = 30;

                    for (let j = 0; (count > 0 ? j < count : true); j++) {
                        if (cs.getTime() > until || j > 100) break;
                        // EXDATE 可能只写日期（无时间），按「同一天」匹配才不会被漏掉
                        if (!curr.exdates.some(t => sameDay(t, cs.getTime()))) {
                            events.push({ 
                                title: curr.title, 
                                location: curr.location, 
                                start: cs.getTime(), 
                                end: ce.getTime() 
                            });
                        }
                        cs.setDate(cs.getDate() + 7 * interval); 
                        ce.setDate(ce.getDate() + 7 * interval);
                    }
                } else {
                    events.push({ title: curr.title, location: curr.location, start: curr.start, end: curr.end });
                }
            }
            curr = null;
        } else if (curr) {
            if (line.startsWith('SUMMARY')) curr.title = line.substring(line.indexOf(':') + 1).trim();
            else if (line.startsWith('LOCATION')) curr.location = line.substring(line.indexOf(':') + 1).trim();
            else if (line.startsWith('DTSTART')) {
                const m = line.match(/:(\d{8}(T\d{6}Z?)?)/);
                if (m) curr.start = parseICSTime(m[1]);
            } else if (line.startsWith('DTEND')) {
                const m = line.match(/:(\d{8}(T\d{6}Z?)?)/);
                if (m) curr.end = parseICSTime(m[1]);
            } else if (line.startsWith('RRULE:')) curr.rrule = line.substring(6).trim();
            else if (line.startsWith('EXDATE')) {
                const m = line.match(/:([\d{8}T\d{6}Z?,?]+)/);
                if (m) m[1].split(',').forEach(s => curr.exdates.push(parseICSTime(s)));
            }
        }
    }
    return events;
}

function startPress(e) {
    if (state.maskDark) return;         // 夜间黑屏的单击交给 bemfa.js 本地唤醒
    // 新的按下动作：清掉上一次长按可能残留的「抑制导入框」标记
    state.suppressCourseClick = false;

    // 触屏上 touchstart 之后浏览器还会补一次 mousedown，忽略它以免短按特效放两遍
    if (e.type === 'mousedown' && Date.now() - state.lastTouchTs < 700) return;

    let x = e.clientX, y = e.clientY;
    if (e.touches && e.touches.length) {
        state.lastTouchTs = Date.now();
        x = e.touches[0].clientX;
        y = e.touches[0].clientY;
    }

    const onBackground = !(e.target && e.target.closest &&
        (e.target.closest('.widget') || e.target.closest('.modal-panel')));
    state.pressStart = { x: x || 0, y: y || 0, t: Date.now(), onBackground, fired: false };
    if (!onBackground) return;

    state.isPressing = true;
    state.pressTimer = setTimeout(() => {
        if (state.isPressing && state.pressStart) {
            state.pressStart.fired = true;
            triggerMagicExplosion();
        }
    }, 1500);
}

function cancelPress() {
    const start = state.pressStart;
    state.isPressing = false;
    clearTimeout(state.pressTimer);
    // 短按空白处：来一小撮星芒，让常驻页面有点回应
    if (start && start.onBackground && !start.fired && Date.now() - start.t < 400) {
        const api = fx();
        if (api) api.sparkleAt(start.x, start.y);
    }
    state.pressStart = null;
}

function handleMotion(e) {
    if (document.hidden || state.maskDark) return;
    // 传感器回调可达 60Hz；10Hz 已足够识别「摇一摇」，省掉老手机上的无谓计算
    const now = Date.now();
    if (now - state.lastMotionTs < 100) return;
    state.lastMotionTs = now;

    const acc = e.accelerationIncludingGravity;
    if (!acc || state.shakeCooldown) return;
    const delta = Math.abs(acc.x - state.lastShake.x) + Math.abs(acc.y - state.lastShake.y) + Math.abs(acc.z - state.lastShake.z);
    if (delta > 15) {
        state.shakeCooldown = true;
        const txt = document.getElementById('hitokoto-text');
        if (txt) txt.innerText = "「遭遇不明气流！请不要随便摇晃别人的世界好吗？」";
        const api = fx();
        if (api) api.wind();
        setTimeout(() => { state.shakeCooldown = false; fetchWitchQuote(); }, 5000);
    }
    state.lastShake = { x: acc.x, y: acc.y, z: acc.z };
}

function updateBattery() {
    if (!navigator.getBattery) return;
    try {
        navigator.getBattery().then(bat => {
            const update = () => {
                const el = document.getElementById('battery');
                if (el) el.textContent = `${bat.charging ? '⚡' : '🔋'} ${Math.round(bat.level * 100)}%`;
            };
            update();
            bat.onchargingchange = update;
            bat.onlevelchange = update;
        }).catch(() => { /* 系统拒绝：静默降级 */ });
    } catch (e) { /* 忽略 */ }
}

function toggleFullScreen() {
    const req = (el, fn) => {
        try {
            const p = el && el[fn] ? el[fn]() : null;
            if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch (e) { /* 忽略 */ }
    };
    if (!document.fullscreenElement) {
        if (document.documentElement.requestFullscreen) {
            req(document.documentElement, 'requestFullscreen');
        } else if (document.documentElement.webkitRequestFullscreen) {
            req(document.documentElement, 'webkitRequestFullscreen');
        } else if (document.documentElement.msRequestFullscreen) {
            req(document.documentElement, 'msRequestFullscreen');
        }
    } else {
        if (document.exitFullscreen) {
            req(document, 'exitFullscreen');
        } else if (document.webkitExitFullscreen) {
            req(document, 'webkitExitFullscreen');
        } else if (document.msExitFullscreen) {
            req(document, 'msExitFullscreen');
        }
    }
}

window.togglePanel = togglePanel;
window.searchLocation = searchLocation;
window.autoLocate = autoLocate;
window.fetchWitchQuote = fetchWitchQuote;
window.toggleFullScreen = toggleFullScreen;

// 用 DOMContentLoaded 而不是 load：不等待字体、农历库、背景图等外部资源，
// 老手机弱网下时钟能先跑起来，农历库晚到也会在后续每秒 tick 里自动接上
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

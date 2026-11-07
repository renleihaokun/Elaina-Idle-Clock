/**
 * 伊蕾娜の魔法手账 - 核心逻辑 (稳定版)
 */

// ================= 配置与常量 =================
const CONFIG = {
    API_URL: 'https://elaina.haokun.me',
    BG_SWITCH_MINUTES: 5,
    BG_LOAD_TIMEOUT_MS: 15000,
    WEATHER_UPDATE_MINUTES: 30,
    QUOTE_UPDATE_MINUTES: 10
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
    bgTimer: null,
    bgToneTimer: null,
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
    startFX();
    setupUI();
    setupEventListeners();
    
    updateTime();
    setInterval(updateTime, 1000);
    
    changeBackground();
    scheduleBackgroundSwitch();
    
    fetchWitchQuote();
    setInterval(fetchWitchQuote, CONFIG.QUOTE_UPDATE_MINUTES * 60 * 1000);
    
    updateBattery();
    updateCourseDisplay();
    
    fetchWeather();
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
    let savedScale = localStorage.getItem('elaina_ui_scale');
    if (!savedScale) {
        state.currentScale = window.innerWidth < 600 ? 0.85 : 1.0;
    } else {
        state.currentScale = parseFloat(savedScale);
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

    // 填充巴法云配置输入框
    var bemfaUid = localStorage.getItem('elaina_bemfa_uid');
    var bemfaTopic = localStorage.getItem('elaina_bemfa_topic');
    var uidEl = document.getElementById('bemfa-uid');
    var topicEl = document.getElementById('bemfa-topic');
    if (uidEl && bemfaUid) uidEl.value = bemfaUid;
    if (topicEl && bemfaTopic) topicEl.value = bemfaTopic;
}

function updateUIScale(val) {
    document.documentElement.style.setProperty('--ui-scale', val);
    const valEl = document.getElementById('scale-value');
    if (valEl) valEl.innerText = Math.round(val * 100) + '%';
    localStorage.setItem('elaina_ui_scale', val);
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
}

function togglePanel(panelId) {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    document.querySelectorAll('.modal-panel').forEach(p => {
        if (p.id !== panelId) p.style.display = 'none';
    });
    const isVisible = panel.style.display === 'block';
    panel.style.display = isVisible ? 'none' : 'block';
}

// ================= 气象更新引擎 =================
async function fetchWeather() {
    if (state.weatherTimer) clearTimeout(state.weatherTimer);
    
    const weatherMainEl = document.getElementById('weather-main');
    let scheduleNext = 30 * 60 * 1000;
    
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
    } finally {
        state.weatherTimer = setTimeout(fetchWeather, scheduleNext);
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
    const stored = localStorage.getItem('elaina_courses');
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
    const stored = localStorage.getItem('elaina_courses');
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
        localStorage.setItem('elaina_courses', JSON.stringify(courses));
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
    clearTimeout(state.thunderClearTimer);
    if (!state.isThunder) return;        // 天气转晴时把待播的闪屏一并取消
    state.thunderTimer = setTimeout(() => {
        spawnThunder();
        scheduleThunder();
    }, Math.random() * 14000 + 6000);
}

function triggerMagicExplosion() {
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
    changeBackground(); 
}

// ================= 定位与搜索 =================
async function autoLocate() {
    const resDiv = document.getElementById('loc-results');
    if (resDiv) resDiv.innerHTML = '<div class="loc-item">正在请求定位权限...</div>';
    if (!navigator.geolocation) return;
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
    localStorage.setItem('elaina_location', JSON.stringify({ lat, lon, name }));
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
        updateCourseDisplay();
    }

    // 整点：一圈星芒脉冲，给常驻画面一个时间刻度
    if (now.getMinutes() === 0 && state.lastPulseHour !== now.getHours()) {
        state.lastPulseHour = now.getHours();
        const api = fx();
        if (api) api.hourPulse();
    }
}

function fetchWitchQuote() {
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

function changeBackground() {
    loadBackground(true);
}

// 壁纸轮换：低端档位放慢一倍。每次切换都要整屏解码，是最贵的一次性操作，
// 老手机发热/掉帧大多出现在这个瞬间，所以用「按当前档位重算间隔」的自调度定时器。
function scheduleBackgroundSwitch() {
    clearTimeout(state.bgTimer);
    const api = fx();
    const level = api ? api.getLevel() : 'normal';
    const minutes = (level === 'light' || level === 'off')
        ? CONFIG.BG_SWITCH_MINUTES * 2
        : CONFIG.BG_SWITCH_MINUTES;
    state.bgTimer = setTimeout(() => {
        changeBackground();
        scheduleBackgroundSwitch();
    }, minutes * 60 * 1000);
}

// 加载并淡入新壁纸；allowCors 为真时顺带取平均亮度给粒子引擎调色
// （服务端已返回 access-control-allow-origin: *，不会产生额外请求）
function loadBackground(allowCors) {
    const imgUrl = `${CONFIG.API_URL}/?t=${Date.now()}`;
    const img = new Image();
    if (allowCors) img.crossOrigin = 'anonymous';

    // 弱网 / 服务端挂起时不让请求无限悬空：超时后按「加载失败」处理并降级重试
    let settled = false;
    const timer = setTimeout(() => { giveUp(allowCors); }, CONFIG.BG_LOAD_TIMEOUT_MS);

    function giveUp(retryPlain) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        img.onload = img.onerror = null;
        try { img.src = ''; } catch (e) { /* 忽略 */ }
        if (retryPlain) loadBackground(false);   // 只在带 CORS 的首次尝试失败时退化为普通加载
    }

    img.onerror = () => {
        // 万一 CORS 头失效会导致整张图加载失败，退化为普通加载
        giveUp(allowCors);
    };

    img.onload = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        // 先解码再换图，避免老手机在切换瞬间卡一下
        const swap = () => {
            const bg1 = document.getElementById('bg1'), bg2 = document.getElementById('bg2');
            if (!bg1 || !bg2) return;
            let outgoing;
            if (state.activeBg === 1) {
                outgoing = bg1;
                bg2.style.backgroundImage = `url(${imgUrl})`;
                bg2.style.opacity = 1; bg1.style.opacity = 0;
                state.activeBg = 2;
            } else {
                outgoing = bg2;
                bg1.style.backgroundImage = `url(${imgUrl})`;
                bg1.style.opacity = 1; bg2.style.opacity = 0;
                state.activeBg = 1;
            }
            // 淡出结束后释放旧图层，避免两张整屏解码图长期占着老手机的内存；
            // 若这段时间里又轮换了一次，旧图层可能已经重新变成当前层，要跳过。
            setTimeout(() => {
                const active = state.activeBg === 1 ? bg1 : bg2;
                if (active !== outgoing) outgoing.style.backgroundImage = 'none';
            }, 1700);

            if (allowCors) sampleBgTone(img);
        };
        if (img.decode) { img.decode().then(swap, swap); } else { swap(); }
    };
    img.src = imgUrl;
}

// 8×8 缩略图估平均亮度：亮壁纸用描边更重的花瓣，暗壁纸用光晕更足的花瓣
function sampleBgTone(img) {
    try {
        const c = document.createElement('canvas');
        c.width = 8; c.height = 8;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, 8, 8);
        const d = ctx.getImageData(0, 0, 8, 8).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        const api = fx();
        if (api) api.setBackgroundTone(sum / (d.length / 4));
    } catch (e) { /* 画布被污染时忽略，沿用默认色调 */ }
}

// ================= 事件监听 =================
function setupEventListeners() {
    const slider = document.getElementById('scale-slider');
    const fxSlider = document.getElementById('fx-level-slider');
    const ics = document.getElementById('ics-upload');
    if (slider) slider.addEventListener('input', e => updateUIScale(e.target.value));
    if (fxSlider) fxSlider.addEventListener('input', e => applyFxLevel(parseInt(e.target.value, 10)));
    if (ics) ics.addEventListener('change', handleIcsUpload);

    window.addEventListener('mousedown', startPress);
    window.addEventListener('touchstart', startPress, { passive: true });
    window.addEventListener('mouseup', cancelPress);
    window.addEventListener('touchend', cancelPress);
    window.addEventListener('devicemotion', handleMotion);

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
        if (!document.hidden) requestWakeLock();
    });
}

function handleIcsUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        const events = parseIcs(ev.target.result);
        if (events.length > 0) {
            localStorage.setItem('elaina_courses', JSON.stringify(events));
            alert("✅ 课表记录完成。");
            updateCourseDisplay();
        } else {
            alert("⚠️ 没有解析到有效课程，请确认文件是 .ics 格式。");
        }
        e.target.value = '';   // 允许再次选择同一个文件
    };
    reader.onerror = () => {
        alert("⚠️ 文件读取失败。");
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
    if (navigator.getBattery) {
        navigator.getBattery().then(bat => {
            const update = () => {
                const el = document.getElementById('battery');
                if (el) el.textContent = `${bat.charging ? '⚡' : '🔋'} ${Math.round(bat.level * 100)}%`;
            };
            update(); bat.onchargingchange = update; bat.onlevelchange = update;
        });
    }
}

function toggleFullScreen() {
    if (!document.fullscreenElement) {
        if (document.documentElement.requestFullscreen) {
            document.documentElement.requestFullscreen();
        } else if (document.documentElement.webkitRequestFullscreen) {
            document.documentElement.webkitRequestFullscreen();
        } else if (document.documentElement.msRequestFullscreen) {
            document.documentElement.msRequestFullscreen();
        }
    } else {
        if (document.exitFullscreen) {
            document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen();
        } else if (document.msExitFullscreen) {
            document.msExitFullscreen();
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

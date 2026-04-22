/**
 * 伊蕾娜の魔法手账 - 核心逻辑 (稳定版)
 */

// ================= 配置与常量 =================
const CONFIG = {
    API_URL: 'https://elaina.haokun.me',
    BG_SWITCH_MINUTES: 5,
    WEATHER_UPDATE_MINUTES: 30,
    QUOTE_UPDATE_MINUTES: 10,
    PARTICLE_INTERVAL_MS: 400
};

let state = {
    currentWeatherType: 'sakura',
    activeBg: 1,
    currentScale: 1.0,
    isPressing: false,
    pressTimer: null,
    shakeCooldown: false,
    lastShake: { x: 0, y: 0, z: 0 },
    weatherRetryCount: 0, 
    weatherTimer: null    
};

// ================= 初始化 =================
function init() {
    setupUI();
    setupEventListeners();
    
    updateTime();
    setInterval(updateTime, 1000);
    
    changeBackground();
    setInterval(changeBackground, CONFIG.BG_SWITCH_MINUTES * 60 * 1000);
    
    fetchWitchQuote();
    setInterval(fetchWitchQuote, CONFIG.QUOTE_UPDATE_MINUTES * 60 * 1000);
    
    updateBattery();
    updateCourseDisplay();
    
    fetchWeather();
    
    setInterval(createParticle, CONFIG.PARTICLE_INTERVAL_MS);
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
}

function updateUIScale(val) {
    document.documentElement.style.setProperty('--ui-scale', val);
    const valEl = document.getElementById('scale-value');
    if (valEl) valEl.innerText = Math.round(val * 100) + '%';
    localStorage.setItem('elaina_ui_scale', val);
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
        const savedLoc = localStorage.getItem('elaina_location');
        
        if (savedLoc) {
            const parsed = JSON.parse(savedLoc);
            lat = parsed.lat; lon = parsed.lon; locName = parsed.name;
        } else {
            const geoRes = await fetch('https://get.geojs.io/v1/ip/geo.json');
            const geoData = await geoRes.json();
            lat = geoData.latitude || 39.9; 
            lon = geoData.longitude || 116.4; 
            locName = geoData.city || '北京';
        }

        const weatherRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code`);
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

        const cached = localStorage.getItem('elaina_weather_cache');
        if (cached) {
            const { current, locName } = JSON.parse(cached);
            updateWeatherUI(current, locName);
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
    
    let icon = '☁️', text = '多云', advice = '是个适合旅行的好天气。';
    state.currentWeatherType = 'sakura'; 

    if (code === 0) { icon = '☀️'; text = '晴朗'; }
    else if (code >= 1 && code <= 3) { icon = '⛅'; text = '多云'; }
    else if (code >= 45 && code <= 48) { icon = '🌫️'; text = '雾'; }
    else if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) { 
        icon = '🌧️'; text = '降雨'; state.currentWeatherType = 'rain'; 
    }
    else if ((code >= 71 && code <= 77) || code === 85 || code === 86) { 
        icon = '❄️'; text = '降雪'; state.currentWeatherType = 'snow'; 
    }
    else if (code >= 95) { icon = '⛈️'; text = '雷阵雨'; state.currentWeatherType = 'rain'; }

    if (state.currentWeatherType === 'rain') advice = '下雨了，带好伞保护魔法书。';
    else if (state.currentWeatherType === 'snow') advice = '下雪了，气温骤降注意保暖。';
    else if (temp > 30) advice = '阳光刺眼，注意防暑防晒。';

    const mainEl = document.getElementById('weather-main');
    const detEl = document.getElementById('weather-details');
    const advEl = document.getElementById('weather-advice');
    if (mainEl) mainEl.textContent = `[${locName}] ${icon} ${text} ${temp}°C`;
    if (detEl) detEl.textContent = `体感 ${feelsLike}°C | 湿度 ${humidity}%`;
    if (advEl) advEl.textContent = `* ${advice}`;
}

// ================= 课表处理 (侧边分组布局 - 纵向贯穿版) =================
function updateCourseDisplay() {
    const stored = localStorage.getItem('elaina_courses');
    const labelEl = document.getElementById('course-label');
    const itemsContainer = document.getElementById('course-items-container');
    
    if (!stored || !labelEl || !itemsContainer) return;
    
    const now = new Date();
    const nowTime = now.getTime();
    const allFutureCourses = JSON.parse(stored)
        .filter(c => c.end > nowTime)
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

    // 更新左侧纵向标签
    labelEl.textContent = `${baseDay}·${basePeriod}`;

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

    // 3. 构造课程项 HTML
    let html = '';
    focusCourses.forEach((c, index) => {
        const sd = new Date(c.start), ed = new Date(c.end);
        const fmt = (d) => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
        const isNow = (nowTime >= c.start && nowTime <= c.end);
        
        if (index > 0) html += `<div class="course-v-divider"></div>`;

        html += `
            <div class="course-item">
                <span class="course-name-row" style="${isNow ? 'color: #ff9a9e;' : ''}">
                    ${c.title}
                </span>
                <span class="course-time-row">
                    ${fmt(sd)} - ${fmt(ed)}
                </span>
                <span class="course-loc-row">
                    ${c.location || '未知'}
                </span>
            </div>
        `;
    });
    
    itemsContainer.innerHTML = html;
}

// ================= 特效与交互 =================
function createParticle() {
    const container = document.getElementById('particle-container');
    const maxCount = state.currentWeatherType === 'rain' ? 30 : 15; 
    if (!container || container.childElementCount > maxCount) return;
    
    const p = document.createElement('div');
    p.className = `particle ${state.currentWeatherType}`;
    p.style.left = `${Math.random() * 100}vw`;
    const duration = state.currentWeatherType === 'rain' ? Math.random() * 1 + 1.5 : 
                    state.currentWeatherType === 'snow' ? Math.random() * 5 + 8 : 
                    Math.random() * 4 + 5;
    
    if (state.currentWeatherType === 'sakura') {
        const size = Math.random() * 8 + 6;
        p.style.width = p.style.height = `${size}px`;
    }
    p.style.animationDuration = `${duration}s`;
    p.style.opacity = Math.random() * 0.5 + 0.3;
    container.appendChild(p);
    setTimeout(() => { if(p.parentNode) p.remove(); }, 9000);
}

function triggerMagicExplosion() {
    const flash = document.getElementById('magic-flash');
    if (flash) {
        flash.style.opacity = '1'; 
        setTimeout(() => { flash.style.opacity = '0'; }, 600);
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
            const res = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=zh`);
            const data = await res.json();
            saveLocation(lat, lon, data.locality || data.city || "当前位置");
        } catch(e) { saveLocation(lat, lon, "当前位置"); }
    }, null, { timeout: 10000 });
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
        const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=10&language=zh`);
        const data = await res.json();
        resDiv.innerHTML = '';
        (data.results || []).forEach(item => {
            const div = document.createElement('div');
            div.className = 'loc-item';
            div.innerHTML = `📍 ${item.name} <span class="loc-item-sub">${item.admin1 || ''} ${item.country || ''}</span>`;
            div.onclick = () => saveLocation(item.latitude, item.longitude, item.name);
            resDiv.appendChild(div);
        });
    } catch (e) { resDiv.innerHTML = '<div class="loc-item">搜索失败。</div>'; }
}

// ================= 时间与状态 =================
function updateTime() {
    const now = new Date();
    const fmt = (n) => String(now[`get${n}`]()).padStart(2, '0');
    const timeEl = document.getElementById('time');
    const dateEl = document.getElementById('date');
    if (timeEl) timeEl.textContent = `${fmt('Hours')}:${fmt('Minutes')}`;
    if (dateEl) {
        const days = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
        dateEl.textContent = `${now.getMonth() + 1}月${now.getDate()}日 ${days[now.getDay()]}`;
    }
    if (window.Lunar) {
        const lunarDate = Lunar.fromDate(now);
        const lDateEl = document.getElementById('lunar-date');
        const hTagEl = document.getElementById('holiday-tag');
        if (lDateEl) lDateEl.textContent = `${lunarDate.getMonthInChinese()}月${lunarDate.getDayInChinese()}`;
        if (hTagEl) {
            let holiday = lunarDate.getFestivals()[0] || Solar.fromDate(now).getFestivals()[0] || lunarDate.getJieQi();
            hTagEl.textContent = holiday ? `[${holiday}]` : '';
        }
    }
    const wcdEl = document.getElementById('weekend-countdown');
    if (wcdEl) {
        const dayIdx = now.getDay();
        wcdEl.textContent = (dayIdx === 6 || dayIdx === 0) ? '✨ 已经是周末啦！' : `⏳ 距周末还有 ${6 - dayIdx} 天`;
    }
    const progTE = document.getElementById('progress-text');
    const progFE = document.getElementById('progress-fill');
    if (progTE && progFE) {
        const passed = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
        const progress = ((passed / 86400) * 100).toFixed(1);
        progTE.textContent = `${progress}%`;
        progFE.style.width = `${progress}%`;
    }
    if (now.getSeconds() === 0) updateCourseDisplay();
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
}

function changeBackground() {
    const imgUrl = `${CONFIG.API_URL}/?t=${Date.now()}`;
    const img = new Image();
    img.onload = () => {
        const bg1 = document.getElementById('bg1'), bg2 = document.getElementById('bg2');
        if (!bg1 || !bg2) return;
        if (state.activeBg === 1) {
            bg2.style.backgroundImage = `url(${imgUrl})`;
            bg2.style.opacity = 1; bg1.style.opacity = 0;
            state.activeBg = 2;
        } else {
            bg1.style.backgroundImage = `url(${imgUrl})`;
            bg1.style.opacity = 1; bg2.style.opacity = 0;
            state.activeBg = 1;
        }
    };
    img.src = imgUrl;
}

// ================= 事件监听 =================
function setupEventListeners() {
    const slider = document.getElementById('scale-slider');
    const ics = document.getElementById('ics-upload');
    if (slider) slider.addEventListener('input', e => updateUIScale(e.target.value));
    if (ics) ics.addEventListener('change', handleIcsUpload);
    window.addEventListener('mousedown', startPress);
    window.addEventListener('touchstart', startPress, { passive: true });
    window.addEventListener('mouseup', cancelPress);
    window.addEventListener('touchend', cancelPress);
    window.addEventListener('devicemotion', handleMotion);
}

function handleIcsUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        const events = parseIcs(e.target.result);
        if (events.length > 0) {
            localStorage.setItem('elaina_courses', JSON.stringify(events));
            alert("✅ 课表记录完成。");
            updateCourseDisplay();
        }
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

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        while (i + 1 < lines.length && (lines[i+1].startsWith(' ') || lines[i+1].startsWith('\t'))) {
            line += lines[i+1].substring(1); i++;
        }

        if (line.startsWith('BEGIN:VEVENT')) curr = { exdates: [] };
        else if (line.startsWith('END:VEVENT')) {
            if (curr && curr.start) {
                if (curr.rrule) {
                    let cs = new Date(curr.start), ce = new Date(curr.end), r = curr.rrule;
                    let interval = (r.match(/INTERVAL=(\d+)/) || [0, 1])[1] * 1;
                    let count = (r.match(/COUNT=(\d+)/) || [0, 0])[1] * 1;
                    let untilMatch = r.match(/UNTIL=(\d{8}(T\d{6}Z?)?)/);
                    let until = untilMatch ? parseICSTime(untilMatch[1]) : Infinity;

                    if (count === 0 && until === Infinity) count = 30;

                    for (let j = 0; (count > 0 ? j < count : true); j++) {
                        if (cs.getTime() > until || j > 100) break;
                        if (!curr.exdates.includes(cs.getTime())) {
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
    if (e.target.closest('.widget') || e.target.closest('.modal-panel')) return; 
    state.isPressing = true;
    state.pressTimer = setTimeout(() => { if (state.isPressing) triggerMagicExplosion(); }, 1500);
}

function cancelPress() { state.isPressing = false; clearTimeout(state.pressTimer); }

function handleMotion(e) {
    const acc = e.accelerationIncludingGravity;
    if (!acc || state.shakeCooldown) return;
    const delta = Math.abs(acc.x - state.lastShake.x) + Math.abs(acc.y - state.lastShake.y) + Math.abs(acc.z - state.lastShake.z);
    if (delta > 15) {
        state.shakeCooldown = true;
        const txt = document.getElementById('hitokoto-text');
        if (txt) txt.innerText = "「遭遇不明气流！请不要随便摇晃别人的世界好吗？」";
        document.querySelectorAll('.particle').forEach(p => p.classList.add('particle-windy'));
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

window.addEventListener('load', init);

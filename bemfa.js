/**
 * 巴法云亮度控制模块 (bemfa.js)
 * 通过 MQTT over WebSocket 订阅巴法云主题，控制网页遮罩层亮度。
 *
 * 配置方式：在网页设置面板中填写 UID 和主题名，点击连接即可。
 * 支持指令：
 *   "on"       → 遮罩全透明（亮度 100%）
 *   "off"      → 遮罩近乎全黑（亮度 0%）
 *   "on#50"    → 亮度 50%（遮罩透明度 0.5）
 *   "on#0"     → 亮度 0%（遮罩近乎全黑）
 *   "on#100"   → 亮度 100%（遮罩全透明）
 */

const BEMFA_BROKER = 'wss://bemfa.com:9504/wss';

(function () {
    'use strict';

    let client = null;
    let reconnectTimer = null;
    let reconnectDelay = 0;        // 指数退避当前值，0 表示还没重试
    let retryUid = '';
    let retryTopic = '';
    let desired = false;           // 用户是否希望保持连接；主动断开/清配置后不再自动重连
    let manualClose = true;        // 主动断开标记，防止 close 回调误触发重连
    let connectSeq = 0;            // 连接序号：异步加载库期间被新连接/断开取代时作废旧回调
    let mqttPromise = null;        // mqtt 动态加载的 Promise（只加载一次）
    let lastBrightness = 100;      // 上次亮度，script.js 初始化时用来同步夜间黑屏状态

    const RETRY_BASE_MS = 5000;    // 首次重试 5s，之后翻倍
    const RETRY_MAX_MS = 300000;   // 封顶 5min，弱网挂机时别一直唤醒无线模块

    // 获取遮罩层 DOM
    const mask = document.getElementById('bemfa-mask');
    if (!mask) {
        console.warn('[巴法云] 未找到 #bemfa-mask 元素');
        return;
    }

    // 首屏应用上次亮度：避免刷新后先亮一下再变黑（silent，交给 script.js 初始化时统一同步）
    try {
        var savedBrightness = parseFloat(localStorage.getItem('elaina_bemfa_brightness'));
        if (isFinite(savedBrightness)) {
            var prevTransition = mask.style.transition;
            mask.style.transition = 'none';
            setBrightness(savedBrightness, { silent: true });
            void mask.offsetWidth;
            mask.style.transition = prevTransition || '';
        }
    } catch (_) { /* 忽略 */ }

    // 更新设置面板中的连接状态显示
    function updateConnectionStatus(text, color) {
        try {
            var el = document.getElementById('bemfa-status');
            if (el) { el.textContent = text; el.style.color = color; }
            var btn = document.getElementById('bemfa-action-btn');
            if (btn) { btn.textContent = '🔌 连接'; }
            // 若有 activeClient（已连接），按钮改为断开
            if (client && client.connected && btn) {
                btn.textContent = '🔌 断开连接';
            }
        } catch (_) {}
    }

    /**
     * 设置遮罩透明度
     * 亮度值 0~100 映射为透明度 0.98~0
     */
    function setBrightness(brightness, opts) {
        var val = Math.max(0, Math.min(100, brightness));
        var opacity = val >= 100 ? 0 : (1 - val / 100) * 0.98;
        mask.style.opacity = opacity;
        lastBrightness = val;
        try { localStorage.setItem('elaina_bemfa_brightness', String(val)); } catch (_) {}
        // script.js 用这个事件暂停/恢复粒子和背景轮换；silent 用于首屏同步，避免重复处理
        if (!opts || !opts.silent) {
            try {
                window.dispatchEvent(new CustomEvent('elaina:brightness', {
                    detail: { value: val, opacity: opacity }
                }));
            } catch (_) {}
        }
    }

    /**
     * 解析巴法云消息并执行亮度控制
     */
    function handleMessage(message) {
        var text = message.toString().trim().toLowerCase();
        if (text === 'on') {
            setBrightness(100);
        } else if (text === 'off') {
            setBrightness(0);
        } else if (text.startsWith('on#')) {
            var num = parseInt(text.substring(3), 10);
            if (!isNaN(num)) {
                setBrightness(num);
            }
        }
    }

    // 拆掉当前连接，不改遮罩、不改状态提示（内部复用）
    function teardown() {
        manualClose = true;
        connectSeq++;                  // 作废还在等待加载库的旧连接
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
        if (client) {
            try { client.end(true); } catch (_) {}
            client = null;
        }
    }

    // 用户主动断开：额外重置遮罩亮度
    function disconnect() {
        teardown();
        desired = false;
        setBrightness(100);
        updateConnectionStatus('未连接', '#ff9a9e');
    }

    // 夜间黑屏时单击屏幕：本地唤醒（不发 MQTT，下一条远程消息仍可覆盖）
    function localWake() {
        if (!document.body) return;
        let dark = document.body.classList.contains('screen-dark');
        if (!dark) {
            try { dark = (parseFloat(getComputedStyle(mask).opacity) || 0) >= 0.9; } catch (e) { dark = false; }
        }
        if (!dark) return;
        setBrightness(100);
    }

    // 连接失败后的指数退避重试：5s → 10s → … → 5min 封顶
    function scheduleReconnect() {
        if (!desired || reconnectTimer) return;
        reconnectDelay = reconnectDelay ? Math.min(reconnectDelay * 2, RETRY_MAX_MS) : RETRY_BASE_MS;
        updateConnectionStatus('已断开，' + Math.round(reconnectDelay / 1000) + ' 秒后重试', '#ffeb3b');
        reconnectTimer = setTimeout(function () {
            reconnectTimer = null;
            connect(retryUid, retryTopic);
        }, reconnectDelay);
    }

    // 按需加载 mqtt 库：unpkg 在大陆网络下经常不可达，绝不能让它阻塞首屏解析。
    // 同一时刻只加载一次，10s 超时视为失败。
    function loadMqtt() {
        if (typeof mqtt !== 'undefined' && mqtt && typeof mqtt.connect === 'function') {
            return Promise.resolve(true);
        }
        if (mqttPromise) return mqttPromise;

        mqttPromise = new Promise(function (resolve) {
            var done = false;
            var timer = 0;
            var s = document.createElement('script');
            s.src = 'https://unpkg.com/mqtt/dist/mqtt.min.js';
            s.async = true;

            function finish(ok) {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve(ok);
            }

            timer = setTimeout(function () { finish(false); }, 10000);
            s.onload = function () {
                finish(typeof mqtt !== 'undefined' && !!mqtt && typeof mqtt.connect === 'function');
            };
            s.onerror = function () { finish(false); };
            document.head.appendChild(s);
        });
        return mqttPromise;
    }

    // 连接巴法云 MQTT：先确保库加载完成，再建连接
    function connect(uid, topic) {
        teardown();
        var seq = ++connectSeq;
        manualClose = false;
        retryUid = uid;
        retryTopic = topic;

        if (!uid || !topic) {
            updateConnectionStatus('请填写 UID 和主题名', '#ff9a9e');
            return;
        }

        updateConnectionStatus('正在连接...', '#ffeb3b');

        loadMqtt().then(function (ok) {
            if (seq !== connectSeq) return;   // 等待库加载期间已被新的连接/断开取代
            if (!ok) {
                mqttPromise = null;           // 允许下次点击重新尝试加载
                updateConnectionStatus('MQTT 库加载失败（请检查网络）', '#ff9a9e');
                return;
            }
            startClient(uid, topic);
        });
    }

    // 真正建立 MQTT 连接
    function startClient(uid, topic) {
        const c = mqtt.connect(BEMFA_BROKER, {
            clientId: uid,
            username: uid,
            password: uid,
            clean: true,
            connectTimeout: 10000,
            // 关掉内置的固定间隔重连，改用上面的指数退避：弱网下不再每 5s 唤醒一次无线模块
            reconnectPeriod: 0
        });
        client = c;

        c.on('connect', function () {
            if (client !== c) return;
            reconnectDelay = 0;      // 连上了，下次断线从小间隔重新退避
            console.log('[巴法云] ✅ 连接成功，正在订阅主题:', topic);
            c.subscribe(topic, { qos: 0 }, function (err) {
                if (err) {
                    console.error('[巴法云] 订阅失败:', err);
                    updateConnectionStatus('订阅失败', '#ff9a9e');
                } else {
                    console.log('[巴法云] ✅ 订阅成功');
                    updateConnectionStatus('已连接 · ' + topic, '#81ecec');
                }
            });
        });

        c.on('message', function (t, message) {
            if (client !== c) return;
            console.log('[巴法云] 收到消息:', t, '→', message.toString());
            handleMessage(message);
        });

        c.on('error', function (err) {
            if (client !== c) return;
            console.error('[巴法云] 连接错误:', err.message);
            updateConnectionStatus('连接失败', '#ff9a9e');
        });

        c.on('close', function () {
            // 主动断开（切后台/清配置）不重连；已被替换的旧连接也不处理
            if (manualClose || client !== c) return;
            scheduleReconnect();
        });
    }

    // 暴露 API 给设置面板调用
    window.Bemfa = {
        /**
         * 保存配置并连接（由"连接"按钮调用）
         */
        save: function () {
            var uidEl = document.getElementById('bemfa-uid');
            var topicEl = document.getElementById('bemfa-topic');
            if (!uidEl || !topicEl) return;

            var uid = uidEl.value.trim();
            var topic = topicEl.value.trim();

            if (!uid || !topic) {
                updateConnectionStatus('请填写完整配置', '#ff9a9e');
                return;
            }

            try {
                localStorage.setItem('elaina_bemfa_uid', uid);
                localStorage.setItem('elaina_bemfa_topic', topic);
            } catch (e) { /* 忽略 */ }
            desired = true;
            connect(uid, topic);
        },

        /**
         * 断开连接但保留配置（由主按钮在已连接时调用）
         */
        disconnect: function () {
            disconnect();
        },

        /**
         * 断开连接并清除所有配置（由"断开并清除配置"按钮调用）
         */
        clear: function () {
            disconnect();
            try {
                localStorage.removeItem('elaina_bemfa_uid');
                localStorage.removeItem('elaina_bemfa_topic');
            } catch (e) { /* 忽略 */ }
            var uidEl = document.getElementById('bemfa-uid');
            var topicEl = document.getElementById('bemfa-topic');
            if (uidEl) uidEl.value = '';
            if (topicEl) topicEl.value = '';
        },

        /**
         * 查询当前连接状态
         */
        isConnected: function () {
            return client && client.connected;
        },

        /**
         * 上次亮度（0~100），script.js 初始化时同步夜间黑屏状态
         */
        getBrightness: function () {
            return lastBrightness;
        },

        /**
         * 本地唤醒：夜间黑屏时点一下屏幕就恢复，不发送 MQTT
         */
        localWake: function () {
            localWake();
        }
    };

    // 夜间黑屏单点唤醒（passive，不拦截正常点击）
    ['pointerdown', 'touchstart'].forEach(function (evt) {
        window.addEventListener(evt, localWake, { passive: true });
    });

    // 页面加载时，若有保存的配置则自动连接
    var savedUid = '';
    var savedTopic = '';
    try {
        savedUid = localStorage.getItem('elaina_bemfa_uid') || '';
        savedTopic = localStorage.getItem('elaina_bemfa_topic') || '';
    } catch (e) { /* 忽略 */ }
    if (savedUid && savedTopic) {
        desired = true;
        connect(savedUid, savedTopic);
    }

    // 切到后台时主动断开 MQTT，可见时再连回来：老手机挂机整夜，
    // 后台保持长连接只会白白耗电，亮度遮罩的状态本身不需要连接维持。
    document.addEventListener('visibilitychange', function () {
        if (!desired) return;
        if (document.hidden) {
            teardown();
            updateConnectionStatus('已暂停（页面不可见）', '#ffeb3b');
        } else {
            reconnectDelay = 0;
            connect(retryUid, retryTopic);
        }
    });

})();

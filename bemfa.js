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

    // 获取遮罩层 DOM
    const mask = document.getElementById('bemfa-mask');
    if (!mask) {
        console.warn('[巴法云] 未找到 #bemfa-mask 元素');
        return;
    }

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
    function setBrightness(brightness) {
        var val = Math.max(0, Math.min(100, brightness));
        var opacity = val >= 100 ? 0 : (1 - val / 100) * 0.98;
        mask.style.opacity = opacity;
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

    // 断开当前连接
    function disconnect() {
        if (client) {
            try { client.end(true); } catch (_) {}
            client = null;
        }
        mask.style.opacity = 0;
        updateConnectionStatus('未连接', '#ff9a9e');
    }

    // 连接巴法云 MQTT
    function connect(uid, topic) {
        disconnect();

        if (!uid || !topic) {
            updateConnectionStatus('请填写 UID 和主题名', '#ff9a9e');
            return;
        }

        updateConnectionStatus('正在连接...', '#ffeb3b');

        client = mqtt.connect(BEMFA_BROKER, {
            clientId: uid,
            username: uid,
            password: uid,
            clean: true,
            connectTimeout: 10000,
            reconnectPeriod: 5000
        });

        client.on('connect', function () {
            console.log('[巴法云] ✅ 连接成功，正在订阅主题:', topic);
            client.subscribe(topic, { qos: 0 }, function (err) {
                if (err) {
                    console.error('[巴法云] 订阅失败:', err);
                    updateConnectionStatus('订阅失败', '#ff9a9e');
                } else {
                    console.log('[巴法云] ✅ 订阅成功');
                    updateConnectionStatus('已连接 · ' + topic, '#81ecec');
                }
            });
        });

        client.on('message', function (t, message) {
            console.log('[巴法云] 收到消息:', t, '→', message.toString());
            handleMessage(message);
        });

        client.on('error', function (err) {
            console.error('[巴法云] 连接错误:', err.message);
            updateConnectionStatus('连接失败', '#ff9a9e');
        });

        client.on('close', function () {
            // 只在非主动断开时显示重连提示
            if (client) {
                updateConnectionStatus('已断开，正在重连...', '#ffeb3b');
            }
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

            localStorage.setItem('elaina_bemfa_uid', uid);
            localStorage.setItem('elaina_bemfa_topic', topic);
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
            localStorage.removeItem('elaina_bemfa_uid');
            localStorage.removeItem('elaina_bemfa_topic');
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
        }
    };

    // 页面加载时，若有保存的配置则自动连接
    var savedUid = localStorage.getItem('elaina_bemfa_uid');
    var savedTopic = localStorage.getItem('elaina_bemfa_topic');
    if (savedUid && savedTopic) {
        connect(savedUid, savedTopic);
    }

})();

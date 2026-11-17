# 项目长期笔记（伊蕾娜时钟）

## 架构约束（改动必须遵守）
- 粒子引擎全在 `effects.js` 单文件；`window.ElainaFX` 原有方法签名不可破坏，可以加方法/字段（已加 `setPaused()` / `refreshGlass()` / `getDeviceInfo()`）
- 热循环（render/tick）零新建对象/渐变/阴影/逐粒子 setTransform；新视觉资产一律在 `bakeSprites()` 启动期烘焙
- **rAF 单链纪律**：任何时刻只允许一个 pending rAF；`applyQuality()` 绝对不能再自己 `requestAnimationFrame`。画质切换用 `rafGen+1` 作废旧回调，`restartLoop()` 统一重排。stats 的 `rafLive` 必须恒为 1（暂停/关闭时为 0）
- 目标设备：老手机横屏长期挂机 → 省电优先；帧率上限、visibilitychange、watchdog、reduced-motion 逻辑不要动
- 自适应判据：先学 `baselineGap`（当前设备 rAF 基线），`jank = gapEma > max(34, base*1.6)`，`roomy = gapEma < base*1.25`；不要写死 60Hz / 24ms，否则 30Hz 省电模式下降级后永远升不回去
- `fx-low` 只降粒子/帧率/装饰动画，**不再关毛玻璃**；毛玻璃由 `body.glass-static` / `glass-live` 决定，低端机静态、高档机动态
- 壁纸：优先 `https://elaina.haokun.me/imgs/thumb/manifest.json` 的 640px 缩略图 + 两个 `<img>` 双缓冲；4K 原图只做非低端兜底。`Image + CSS background` 会重复解码/黑屏，不要再回去
- 壁纸比例过滤：`pickNextThumb()` 走 `buildThumbPool()`，按「铺满全屏要裁掉多少」`crop = 1 - min(图比例, 屏幕比例)/max(两者)` 筛，默认 ≤0.20；池子 <10 张自动降档（0.15 一档），最后一级全量。目标比例取 `screen` 长短边归一（**不要**改回视口比例，没全屏时会把 16:9 误杀）；档位存 `localStorage.elaina_bg_aspect`
- 静态玻璃：64px 缩小 → 256px 平滑放大 → 叠暗色 → JPEG dataURL；4 个 widget 按 `transform-origin` + `offsetLeft/Top` 算 `background-size/position`，不要用透明边 blur
- sprite 烘焙 2x 超采样（`BAKE_SS`），绘制时缩回 CSS 尺寸；fog 保持 1x（放大 1.5~2.2 倍绘制，糊是特性）
- 旋转变体 24/24/32 档；`p.rot` 单位是**弧度**，变体下标换算在 `drawPetal`（曾经是"变体序号"，踩过 3 倍转速陷阱）
- DPR 上限：rich=2 / 其他档=1.5；Android `deviceMemory≤4` 视为 LOW_MEM，降烘焙倍率与变体数；canvas 另有像素预算（低端 1.6M / 普通 3.2M）
- 粒子重建统一走 `buildPreset()`，它记 `state.buildAt` → render 全场 0.9s 淡入；粒子/一次性对象已回池，别在热循环 new
- 夜间黑屏：`body.screen-dark` 会 display:none 内容层并暂停 FX；本地单击唤醒由 bemfa.js 负责，不刷新也要能恢复
- **自愈不许刷新页面**：04:00 自愈走 `runSelfHeal()` 页内回收重建（FX.reset + 壁纸换层 + 玻璃重建 + MQTT 重连），刷新一定会退出全屏且拿不回来（requestFullscreen 需要用户手势，规范至今没有刷新恢复能力）。只有背景审计连自愈都救不回来才 `safeReload`
- **全屏意图**：只记 `sessionStorage.elaina_fs_wanted`；退出全屏要**延迟 2s** 再清标记（刷新时 fullscreenchange/pagehide 顺序不确定）；加载后有标记就在第一次 pointerdown/touchend 上自动补全屏，别去设置里手动点

## 审美基准
- 花瓣 = 老版 CSS 花瓣：vesica 透镜形（双 arc 路径 `petalPath`）+ 纯色 `#ffb7c5` + 同色径向柔光；**禁止**线性渐变、深色描边
- 亮色壁纸用 petalSoft 集（`#f29db1` + 0.28alpha 细描边）
- 星点用柔光圆点（≠ 星芒的十字，视觉身份要拉开）

## 验证方法（本机专用，重要）
- 系统 Chrome/Edge 被现有会话接管，headless 完全不可用（连 --version 都只回一句"正在现有的浏览器会话中打开"）
- 可用 puppeteer 缓存的独立 Chrome（路径写在 `.dsh/tools/fx_cdp.js` 的 `CHROME` 常量里，不入库），必须 `--headless=old` + 独立 `--user-data-dir`
- 验收工具已归档 `.dsh/tools/`：`fx_cdp.js`（CDP 真实时间泵帧 + 像素采样 + 截图）+ `fx_test.html`（URL 参数 weather/tone/level/txt）
  用法：`node .dsh/tools/fx_cdp.js "<file:///.../.dsh/tools/fx_test.html?weather=star&txt=0>" out.png [dpr2|burst]`
- 纯 `--virtual-time-budget` 截图有 rAF 帧调度间歇性（画面忽有忽无），别依赖它做视觉验收

## 历史
- 2026-11-17 目录搬家：上一代代理留下的 `.workbuddy/`（记忆 + 验收工具）整体迁到 `.dsh/` 并删除，`memory/` 入库、`tools/` 仍留在本机不入库。
- 2026-10-09 粒子视觉优化 S1~S6（去取整/弧度化/花瓣重画/2x烘焙/DPR分档/alpha收窄/构建淡入/星雨风 sprite 化/双频摇摆），验证 drawMs≈0.2ms。详见 `.dsh/memory/2026-10-09.md`
- 2026-11-07 低端机长期稳定性专项修复（自适应采样双通道、iOS 低内存兜底、Wake Lock、背景超时/图层释放、MQTT 退避、XSS 与解析容错）。详见 `.dsh/memory/2026-11-07.md`
- 2026-11-17 凌晨自愈不再刷新页面（改页内软自愈），刷新场景用全屏意图标记在首次点击时自动恢复全屏。详见 `.dsh/memory/2026-11-17.md`
- 2026-11-17 晚 壁纸按手机屏幕比例过滤：方图/近方图不再选中（红米 8A 19:9 上方图要裁 52.6%），设置面板可切标准/宽松/关闭，诊断条加裁切百分比。详见 `.dsh/memory/2026-11-17.md` 追加节
- 2026-11-08 32 位 Android 长跑专项（4K 原图/重复解码 → 640 缩略图 + `<img>` 双缓冲；rAF 多链 bug；30Hz 基线；静态毛玻璃；夜间暂停/本地唤醒；诊断与受保护自愈刷新）。详见 `.dsh/memory/2026-11-08.md`

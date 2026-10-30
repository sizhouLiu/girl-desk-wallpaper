# 3D 场景 → 交互式动态壁纸：实现流程报告

本报告总结"女孩书桌"壁纸项目从 3D 模型到 Wallpaper Engine 壁纸的完整流程，以及把这条流程接入无限画布（infinite-canvas）、变成可重复跑通的工作流需要做什么。

- 项目目录：`C:\Users\asus\Documents\girl_desk_wallpaper\`
- Blender 工程：`C:\Users\asus\Documents\girl_desk_scene\girl_desk_scene1.blend`
- 最终产物：`wallpaper\`（可直接被 Wallpaper Engine 导入的网页壁纸）

---

## 1. 总流程

```
 ① 素材生成          ② 场景搭建            ③ 导出              ④ 优化             ⑤ 网页运行时          ⑥ 打包
 Tripo 3D 生成   →   Blender 布景/灯光  →  GLB + scene.json →  贴图 WebP 压缩  →  three.js 渲染+交互 →  Wallpaper Engine
 人物 / 道具          相机 / 卡通着色        (351 MB)           几何 meshopt       (Vite 开发/构建)       web 壁纸
                                                                (→ 24 MB)
```

| 阶段 | 工具 | 输入 | 输出 | 自动化程度 |
| --- | --- | --- | --- | --- |
| ① 素材生成 | Tripo（画布已集成） | 文字 / 参考图 | 单个道具 GLB | 已在画布内 |
| ② 场景搭建 | Blender | 道具 GLB、参考图 | `.blend` 工程 | 手工 + 对话式脚本 |
| ③ 导出 | Blender Python | `.blend` | `export/room.glb`、`export/scene.json` | 脚本在 Blender 内执行过，**未保存成文件** |
| ④ 优化 | gltf-transform + PIL | `export/room.glb` | `public/room.glb` | 三条命令 |
| ⑤ 运行时 | three.js 0.170 + Vite 5 | `public/` | 网页 | 代码 |
| ⑥ 打包 | Vite build + 复制 | `src/`、`public/` | `wallpaper/` | 两条命令 + 手动导入 |

---

## 2. 各阶段做了什么

### ① 素材生成

人物和大部分道具（显示器、时钟、猫、吉他、植物、手办等）是 Tripo 生成的 GLB，材质名形如 `tripo_material_<uuid>`。

Tripo 模型的特点，后续每一步都要照顾到：

- 一个物体只有一张贴图，屏幕、外壳、按键都烤在同一张图上。
- 面数偏高，人物 156 万三角面，占全场景 522 万的约 30%。
- 没有可用的 UV 分区信息，"哪块是屏幕"只能从几何上推断。

### ② 场景搭建（Blender）

- 房间：墙、地板、书桌、书架、床、衣柜、门窗、窗帘、百叶窗，大多是基础方块。
- 灯光：17 盏，其中台灯、屏幕补光、门缝光等是面光源。
- 相机：`SCN_Camera`、`CAM_Bedroom`、`CAM_Shelf` 三个机位。
- 卡通着色：4 段色阶 ramp，加几何节点做的描边，共 68 个物体有描边。
- 书架：56 本书，每本书的书名记在物体上。

### ③ 导出（Blender Python 脚本）

导出日志 `export/export_log.txt` 记录的处理内容：

| 处理 | 数量 | 说明 |
| --- | --- | --- |
| 导出网格 | 263 | |
| 标记描边物体 | 68 | 写进 `scene.json.outlined` |
| 烘焙人物颜色贴图 | 4096² | 人物原本是节点材质，导出前烘成一张图 |
| 重新关联材质 | 34 | |
| 方块投影 UV | 13 个物体 | 墙、书架木板 |
| 写出 `scene.json` | — | 相机 3、灯光 17、书名 56、自发光材质 27、曝光值 |

`scene.json` 是 Blender 和网页之间的数据契约，three.js 读不到 Blender 的灯光、相机参数和自定义属性，全靠它传过去：

```jsonc
{
  "cameras":     { "SCN_Camera": { "pos": [...], "quat": [...], "lens": 19, "sensor": 36 } },
  "lights":      [ { "name": "LGT_LampBulb", "type": "POINT", "pos": [...], "energy": 55, "color": [...] } ],
  "books":       { "BOOK_001": "Deep Learning" },
  "interactive": { "lamp": [...], "clock": [...], "monitors": [...], "window": [...], "cat": [...] },
  "outlined":    [ "CHAR_Girl", "DK_Leg_0" ],
  "emissive":    { "screen_code": 2.6 },
  "exposure":    0
}
```

> 注意：这一步的脚本是在 Blender 里直接执行的，没有存成 `.py` 文件。要做成可重复的流程，第一件事就是把它补成文件（见第 4 节）。

### ④ 优化（`tools/optimize.mjs` + `tools/resize_textures.py`）

```bash
node tools/optimize.mjs dump        # 删掉法线/粗糙度/AO 贴图，导出所有贴图到 work/tex_in/
python tools/resize_textures.py     # 缩到 1024（人物 2048），转 WebP
node tools/optimize.mjs pack        # 塞回 WebP，meshopt 压缩几何 → public/room.glb
```

结果是 351 MB 降到 24 MB。贴图处理用 PIL，因为这台机器上 `sharp` 装不上。卡通着色本来就用不到法线和粗糙度贴图，所以可以直接删。

### ⑤ 网页运行时（`src/`，约 1300 行）

| 文件 | 职责 |
| --- | --- |
| `main.js` | 加载 GLB、换卡通材质、灯光转换、相机、后处理链、帧率控制 |
| `toon.js` | 卡通材质（硬明暗交界、阴影偏紫、角色边缘光）、反向外壳描边 |
| `anime.js` | 三渲二后处理：用深度缓冲给所有物体勾线，再提高饱和度 |
| `interact.js` | 所有点击交互、悬停提示、昼夜和窗帘的状态 |
| `dashboard.js` | 显示器上的实时系统监控画面（canvas 贴图） |
| `sound.js` | 呼噜声和吉他声用代码合成，猫叫用 CC0 录音 |
| `settings.js` | Wallpaper Engine 用户设置 ↔ 运行时参数 |
| `bookLinks.js` | 书名 → 免费版或配套代码链接 |

渲染链：`RenderPass` → `AnimePass`（勾线 + 饱和度）→ `UnrealBloomPass`（泛光）→ `OutputPass`（AgX 色调映射）。

运行时补救了一些导出没带过来的东西：

- **灯光：** Blender 面光源 three.js 没有对应类型，转成宽角聚光灯。窗户和床头的三盏会产生奇怪光斑，直接删除。
- **贴图坐标：** 地板、桌面、机箱的程序化贴图坐标在导出时丢了，运行时按真实尺寸重新生成。
- **正面相机：** 参考图 `渲染测试.png` 的相机没导出来，用 12 个对应点从图片反推出位置、朝向和视角，误差约 7 像素。

### ⑥ 交互功能清单

| 交互 | 实现方式 |
| --- | --- |
| 显示器开关 | 自动识别屏幕平面，盖一层黑色矩形淡入淡出，外壳不变 |
| 实时时钟 | canvas 画时间，贴在时钟屏幕上（模型屏幕不平，贴在最前面那个点之前） |
| 昼夜切换 | 窗外加一层白天贴图交叉淡入，加白天环境光 |
| 窗帘 / 百叶窗 | 改位置、缩放、旋转做动画，联动环境光强度 |
| 书 | 30 本打开免费版或配套代码，其余打开搜索 |
| 猫 | 顶点着色器做呼吸，点击后呼噜或猫叫 |
| 吉他 | 合成的扫弦声（电吉他带失真），吉他轻轻晃动 |
| 系统监控屏 | 本地辅助程序 `helper/stats-server.mjs` 提供 CPU、GPU、内存、网络数据 |
| 台灯、鼠标视差 | 灯光开关；相机跟随鼠标轻微偏移 |

### ⑦ 打包到 Wallpaper Engine

```bash
npx vite build                       # vite.config.js 里 base: './'，保证从本地文件打开时路径正确
cp -r dist/* wallpaper/              # public/ 里的 project.json、room.glb、sounds/ 会一起带过去
```

然后在 Wallpaper Engine 里选"打开壁纸 → 从文件打开 → `wallpaper/index.html`"。

`project.json` 定义了 `type: "web"` 和设置面板里的用户属性：镜头、帧率、分辨率、灯光、曝光、泛光、描边、三渲二强度、音量等。页面通过 `window.wallpaperPropertyListener` 接收这些值。

---

## 3. 踩过的坑

这些问题在换一个场景时大概率会再次出现，自动化流程需要把它们变成固定步骤或检查项。

| 现象 | 根本原因 | 处理 | 自动化建议 |
| --- | --- | --- | --- |
| 地板、桌面、机箱贴图拉伸 | Blender 程序化贴图坐标（Generated/Object）不会导出 | 运行时按世界尺寸重做 UV | 导出脚本里先把程序化坐标烘成真实 UV |
| 修了 UV 还是不对 | meshopt 把 UV 量化成 0–1 的整数，平铺的大数值被截断 | 换成 float UV | 平铺贴图的物体在优化时排除 UV 量化 |
| 墙上、床头有圆形光斑 | 面光源被换成聚光灯 | 删掉这几盏灯，改用环境光 | 导出时给每盏灯标"网页用 / 不用" |
| 显示器一点整个变黑 | 屏幕和外壳在同一张贴图上 | 识别屏幕平面再盖黑层 | 通用的"屏幕识别"函数 |
| 时钟数字被戳穿 | 模型的屏幕是斜的，不是平面 | 贴图放到最前面那个点之前 | 同上，带深度检查 |
| 预设镜头里都看不到时钟 | 场景布局问题 | 运行时把时钟挪到可见位置 | 在搭建阶段就用壁纸相机检查可见性 |
| 三渲二开启后整屏黑 | 深度贴图被两个渲染目标共用，形成读写回环 | 给第二个目标单独的深度贴图 | 已修，属于框架层 |
| 网页读不到 CPU/GPU | 浏览器沙箱限制 | 本地辅助程序 + `127.0.0.1` 接口 | 作为可选组件打包 |

---

## 4. 接入无限画布：做成可跑通的流程

### 4.1 现状和差距

无限画布已有的能力：

- **Tripo 3D 生成节点：** 能产出单个道具 GLB，覆盖第 ① 步。
- **节点插件体系：** `plugins/canvas/`，用 TypeScript 写 React 节点，`panorama` 插件已经在节点里跑 three.js。
- **本地 Canvas Agent：** `canvas-agent/`，把画布连到本机的 Codex / Claude Code。它自己提供的 MCP 工具只操作画布（`canvas_get_state`、`canvas_apply_ops`、`canvas_create_text_node` 等），不直接执行本地命令。但侧边栏里跑的 Codex / Claude Code 本身就能执行 shell 命令，所以"调用 Blender、跑构建"由它们来做，再用 `canvas_apply_ops` 把结果写回画布节点。

做第一步之前，②–⑥ 是靠对话里临时写脚本完成的，下面这些都写死在代码里。现在已经全部移进配置文件（见 4.3）：

| 写死的内容 | 位置 | 换场景时的问题 |
| --- | --- | --- |
| 导出脚本 | 只存在于 Blender 会话里 | 无法重跑 |
| 物体名：窗帘 `BWIN_Curtain*`、百叶 `WIN_Slat_*`、吉他、监控屏 `PROP_Mon_Dash` | `interact.js` | 新场景物体名不同就失效 |
| 时钟摆放位置、正面相机参数、要删除的灯 | `interact.js`、`main.js` | 每个场景都不一样 |
| 需要重做 UV 的材质和平铺尺寸 | `main.js` 的 `BOX_UV` | 同上 |

### 4.2 目标流程

```
[Tripo 节点] ×N ──┐
[参考图节点] ─────┼─→ [场景组装] ─→ [壁纸构建] ─→ [壁纸预览] ─→ [导出 zip / 导入 WE]
[交互配置节点] ───┘     (Blender)      (CLI)        (插件节点)
```

| 节点 | 做什么 | 实现方式 |
| --- | --- | --- |
| Tripo 节点 | 生成道具 | 已有 |
| 交互配置节点 | 填"哪个物体做什么交互"、相机、要删的灯 | 新插件，输出 `wallpaper.config.json` |
| 场景组装 | 摆放道具、灯光、相机，导出 GLB + scene.json | Blender 无界面模式执行脚本，由侧边栏 Agent 调用 |
| 壁纸构建 | 优化 → 构建 → 打包 | 一条 CLI 命令，由侧边栏 Agent 调用 |
| 壁纸预览 | 在画布节点里直接看效果、点交互 | 新插件，iframe 加载构建产物 |

### 4.3 已完成：第一到第三步

**第一步：一条命令跑完整个流程（已完成）**

```bash
cd C:\Users\asus\Documents\girl_desk_wallpaper
npm run pipeline -- --check                 # 完整流程，含 Blender 导出，约 1.5 分钟
npm run pipeline -- --skip-export --check   # 没改 Blender 场景时用，跳过导出，约 1 分钟
```

| 步骤 | 做什么 | 实测耗时 |
| --- | --- | --- |
| export | Blender 无界面执行 `pipeline/export_scene.py`，输出 `export/room.glb` + `scene.json` | 24 s |
| optimize | 贴图转 WebP、几何压缩，输出 `public/room.glb`（205 MB → 24 MB） | 35 s |
| runtime | 从配置生成 `public/runtime.json`，同步 `scene.json` 和 `project.json` 的标题、镜头下拉框 | <1 s |
| build | `vite build` | 2 s |
| package | 生成 `wallpaper/`（导入 Wallpaper Engine 用）和 `release/girl-desk-night-room.zip` | 2.5 s |
| check | 用 Chrome 以本地文件方式打开 `wallpaper/index.html`，每个镜头截图，有页面报错就判失败 | 25 s |

- **报告：** 每步结果写进 `work/pipeline/report.json`，完整日志在 `work/pipeline/<步骤>.log`，截图在 `work/pipeline/shots/`。
- **失败处理：** 任何一步失败都立即停止，退出码为 1，报告里写明是哪一步、错误是什么。例如 Blender 路径写错时，报告为 `step "export": Blender not found: ... — pass --blender <exe> ...`。
- **结果核对：** 和改造前的参考截图对比，四个镜头的平均像素差为 2.7–4.8（满分 255），肉眼看不出区别。

具体改动：

- **导出脚本补成了文件：** `pipeline/export_scene.py`。原来的导出逻辑只在 Blender 会话里执行过，这次照着旧的导出结果还原，对比后节点、材质和 `scene.json` 都一致。脚本不会保存 `.blend`，对场景的改动只在本次运行里生效。
- **场景相关的值全部移进 `wallpaper.config.json`：** 物体名、镜头、要删的灯、台灯、时钟位置、需要重做 UV 的材质、贴图尺寸、书名都在这里。运行时代码不再写死任何物体名，换场景时只改这个文件。
- **修了导出时遇到的 Blender 问题：**
  - 部分 Tripo 贴图打包后损坏，导出器读取时会让 Blender 直接崩溃。现在只导出网页实际用到的颜色、自发光和透明度贴图。
  - 重新烘焙人物贴图时，GPU（OptiX、CUDA）烘出来是全黑的，现在默认用 CPU 烘焙。烘焙后会检查结果，全黑就报错，不会把坏贴图导出去。
  - 平时复用已经烘好的 `export/girl_albedo.png`，需要重新烘焙时加 `--rebake`。

**第二步：画布里预览（已完成）**

- 新插件 `plugins/canvas/wallpaper-preview`，节点名「壁纸预览」。
- `npm run preview`（`pipeline/serve.mjs`）用一个端口 4173 提供项目里所有已构建的壁纸。壁纸列表在 `/wallpapers.json`，每个壁纸页在 `/w/<id>/`。新构建的壁纸会自动出现在列表里，不用重启服务。
- 节点不用填地址：「壁纸」下拉框从列表里选择已构建的壁纸，「机位」下拉框只列当前壁纸自己的机位，换壁纸时机位回到默认。
- 节点也可以连上游文本节点：文本是壁纸 id（如 `cafe-mellow-beans`）就选中该壁纸，文本是网址就直接预览该页。
- 节点里可以直接点灯、显示器触发交互，拖动顶部控制条可以移动节点。
- 已在真实画布里对真实壁纸页测过：画面能渲染；点显示器能黑屏，再点能恢复；切到卧室镜头后画面跟着变；拖动后节点移动、页面继续渲染。截图在 `D:\工程插件\wallpaper-preview-check\`。

**第三步：由侧边栏 Agent 驱动（已完成，用 Skill 方式）**

- 新 Skill `plugins/infinite-canvas/skills/wallpaper-pipeline`。用户对 Agent 说"构建壁纸"时，Agent 会：
  1. 运行 `npm run pipeline -- --skip-export --check`。
  2. 读取 `report.json`，失败时按步骤名汇报。
  3. 成功时在画布上写一个结果摘要节点，再加一个预览地址节点连到「壁纸预览」节点。
  4. 最后提醒用户手动导入 Wallpaper Engine。
- 两个限制，已记入画布仓库的待办：
  - Canvas Agent 的 `add_node` 不能创建插件节点，「壁纸预览」节点需要用户手动加一次。
  - 不能用本地图片路径创建图片节点，所以截图只列出路径。
- 这个 Skill 还没有让 Agent 实际跑过一遍。
- 没有做正式的 `wallpaper_build` MCP 工具。它需要定超时时间等边界值，按画布仓库的规范要先由用户决定。

**画布仓库的改动（未提交）**

- 新增：`plugins/canvas/wallpaper-preview/`、`plugins/infinite-canvas/skills/wallpaper-pipeline/`。
- 按仓库规范更新：`CHANGELOG.md`、`pending-test`（中英两份）、`todo`（中英两份）。

**第四步（可选，暂不做）：减少 Blender 手工**

8. 场景组装目前离不开 Blender，人工摆放、调灯光是主要工作量。可以先做"道具 GLB + 摆放坐标 JSON → 自动生成 .blend"，让画布端只负责摆放，Blender 只做导出。完全在画布里组装场景是更大的工程，建议放在最后评估。

### 4.4 风险和待确认事项

- **Blender 路径：** 本机的 Blender 是 `F:\blender5.2\blender.exe`（5.2.2 LTS），已写进配置。换机器时用 `--blender` 参数或环境变量 `BLENDER` 指定。
- **GPU 烘焙出黑图：** 在这台机器上用 OptiX 和 CUDA 烘焙人物都得到全黑贴图，所以默认改用 CPU 烘焙。512 像素约 5 秒，4096 像素会慢很多。只有加 `--rebake` 时才会重新烘焙。
- **Tripo 贴图损坏：** 有些 Tripo 模型打包的 ORM/法线贴图 Blender 解不开，导出或烘焙时偶尔会让 Blender 崩溃。导出时这些贴图已经断开不用，烘焙时也会隐藏其他物体。如果以后又崩溃，看 `work/pipeline/export.log` 和 `%TEMP%` 下的 `*.crash.txt`。
- **Wallpaper Engine 导入：** 没有公开的命令行导入接口，最后一步"从文件打开"仍需手动。发布到创意工坊也要在 Wallpaper Engine 里操作。
- **系统监控屏依赖 Node.js：** 分享给别人时，对方没装 Node 就看不到实时数据，其他功能不受影响。
- **性能：** 当前 522 万三角面，1080p 下 30 帧上限稳定，开三渲二仍能到 60 帧（RTX 3060）。人物面数是主要大头，换低配机器前建议给人物减面。
- **未在 Wallpaper Engine 内实测的：** 点书打开浏览器、连接本地监控程序。这两项在 Chrome 里测通了，Wallpaper Engine 内置的也是 Chromium，预计一致，但要实际确认。

---

## 附录：常用命令

```bash
cd C:\Users\asus\Documents\girl_desk_wallpaper

npm run pipeline -- --check                  # 一键：导出 → 优化 → 构建 → 打包 → 截图检查（约 1.5 分钟）
npm run pipeline -- --skip-export --check    # 没改 .blend 时用（约 1 分钟）
npm run pipeline -- --rebake --check         # 改了人物材质，需要重新烘焙人物贴图时用
npm run preview                              # 预览所有已构建的壁纸 http://localhost:4173（「壁纸预览」节点从这里读列表）
npm run pipeline -- --config scenes/cafe/wallpaper.config.json --check   # 构建第二个场景（咖啡馆），输出到 scenes/cafe/
npm run dev                                  # 开发预览 http://localhost:5199
helper\start-stats.bat                       # 启动系统监控辅助程序
```

`npm run pipeline` 的其他参数：`--config <文件>`、`--blend <文件>`、`--blender <exe>`。Blender 路径也可以用环境变量 `BLENDER` 指定。

备份：
- `backups/before_anime_look_20261027_2108/`：三渲二改动前的完整副本。
- `backups/before_pipeline_20261028_1707/`：一键流程改造前的完整副本。

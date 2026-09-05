# dsh-tool-lipsync

[![DSH Plugin](https://img.shields.io/badge/DSH-Plugin-blue?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZD0iTTEyIDJMMyA3djEwbDkgNSA5LTVIN0wxMiAyeiIgZmlsbD0iI2ZmZiIvPjwvc3ZnPg==)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![DSH Version](https://img.shields.io/badge/DSH-%3E%3D0.1.0--rc.6-orange.svg)](https://github.com/deepseek-ai/deepseek-harness)

**免 Key、免登录**的 AI 对口型口播视频生成插件，为 DeepSeek Harness (DSH) 注册 5 个工具，使用免费开放 API 生成对口型视频。

> 3000+ 声音 · 500+ 语言 · 最长 20 秒 · 无水印 · 1-3 分钟出片

---
<img width="1440" height="739" alt="image" src="https://github.com/user-attachments/assets/31849f67-cdad-4095-ba9d-683e903f5bfe" />
---

## 功能一览

| 工具 | 作用 |
|---|---|
| `lipsync_list_voices` | 列出预设声音（按语言/关键词筛选） |
| `lipsync_list_samples` | 列出示例人脸/宠物/卡通素材 |
| `lipsync_generate` | 提交对口型口播视频生成任务 |
| `lipsync_status` | 轮询生成状态（5-6 秒/次） |
| `lipsync_download` | 下载成片 MP4 到本地 |

### 免费层特性

- **无需 API Key**、无需登录账号
- 最长 20 秒视频，无水印
- 大多数 1-3 分钟内生成完成
- 支持中文、英文、日文等 500+ 语言预设声音
- 支持自定义人脸图片

---

## 安装

### 方式一：CLI 安装（推荐）

```bash
# 在 DSH Web profile 中安装
dsh plugin --profile web add github:yu-wenchao/dsh-tool-lipsync
```

安装后重启 DSH 即可生效。

### 方式二：一键安装包

1. 下载本仓库 Release 中的安装包
2. 解压到任意目录
3. 双击 `安装.bat`
4. 按提示选择安装目录，等待安装完成
5. 双击 `重启.bat` 重启 DSH

### 方式三：手动安装

```bash
# 克隆仓库
git clone https://github.com/yu-wenchao/dsh-tool-lipsync.git

# 安装到 DSH web profile
dsh plugin --profile web add ./dsh-tool-lipsync
```

---

## 卸载

```bash
dsh plugin --profile web remove dsh-tool-lipsync
```

或使用安装包中的 `卸载.bat`。

---

## 使用示例

在 DSH 对话中输入：

> 帮我用 FreeLipSync 做一段口播视频，让这个人说"大家好，欢迎收看今天的节目"。先列出中文声音和示例人脸素材，然后生成，完成后下载到工作区。

模型会自动调用：
1. `lipsync_list_voices` — 获取中文声音列表
2. `lipsync_list_samples` — 获取示例人脸素材
3. `lipsync_generate` — 提交生成任务
4. `lipsync_status` — 轮询进度
5. `lipsync_download` — 下载成片

### 高级用法

```
# 指定声音和人脸生成
请用日语女声，配合示例人脸素材，生成一段 15 秒的口播视频，内容是"こんにちは、世界"

# 使用自定义人脸
用这张图片作为人脸 https://example.com/face.jpg，配上英文男声说"This is a test"

# 批量生成
分别用中文、英文、日文生成三段口播视频，内容都是"欢迎订阅我的频道"
```

---

## 工作原理

```
DSH 对话 → lipsync_generate 工具调用
    ↓
提交生成任务到后端 API
    ↓
轮询查询生成状态
    ↓
下载成片 MP4
    ↓
保存到本地工作区
```

- 首次请求自动建立匿名会话
- 所有 API 调用完全开放、无 Key、无登录
- 插件通过 HTTP 代理绕过浏览器限制

---

## 技术细节

### 插件结构

```
dsh-tool-lipsync/
├── package.json          # DSH bundle manifest
├── cordis.patch.yml      # 向 profile 组合插入本插件
├── lib/
│   ├── index.js          # 插件入口（注册 5 个工具）
│   ├── index.d.ts        # TypeScript 类型定义
│   └── client.js         # Web UI 面板（可选）
└── README.md
```

### API 接口

| 接口 | 方法 | 说明 |
|---|---|---|
| `/api/catalog/voices` | GET | 获取声音列表 |
| `/api/samples` | GET | 获取示例素材 |
| `/api/generate` | POST | 提交生成任务 |
| `/api/status/batch` | POST | 批量查询状态 |
| `/api/download/{id}` | GET | 下载成片 |

### 依赖

- DeepSeek Harness >= 0.1.0-rc.6
- Node.js >= 18
- 网络连接

---

## 注意事项

- 免费层输出为**低清 preview** 版；高清无水印原片需登录/付费
- 本插件依赖第三方免费服务，其免费额度与接口随时可能调整
- 请注意素材/肖像版权
- 后端接口未来可能变动

---

## 常见问题

### Q: 安装后 DSH 报错 "Failed to load plugins"

A: 重启 DSH 即可。如果仍然报错，检查 DSH 版本是否 >= 0.1.0-rc.6。

### Q: 生成的视频在哪里？

A: 默认保存在 DSH 工作区目录下。使用 `lipsync_download` 工具时可以指定保存路径。

### Q: 支持自定义人脸吗？

A: 支持。在 `lipsync_generate` 工具中传入 `faceUrl` 参数即可，支持任何公开可访问的图片 URL。

### Q: 生成速度慢怎么办？

A: 免费层生成速度取决于服务器负载，通常 1-3 分钟。可以使用 `lipsync_status` 工具轮询进度。

---

## 许可证

MIT License

---

## 相关链接

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [Awesome DSH Plugin](https://awesome-dsh-plugin.com)

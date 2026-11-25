# dsh-super-image

[简体中文](#简体中文) · [English](#english) · [下载 / Downloads](https://github.com/Byton-Patrica/dsh-super-image/releases)

## 简体中文

为 DeepSeek Harness (DSH) 提供图像生成。每个后端可以独立启用，并使用 OpenAI Images 兼容 API 或 ComfyUI。启用两个后端时并行生成。你可以按需求逐项比较候选图，也可以在视觉模型可用时生成融合图。

### 安装

需要支持 DSH 插件的 Web profile，以及 Node.js 22.19 或更高版本。从 GitHub 安装到名为 `web` 的 profile：

```powershell
dsh plugin --profile web add github:Byton-Patrica/dsh-super-image
```

将 `web` 换成你的 profile 名称。也可以从 [v0.1.3 发布页](https://github.com/Byton-Patrica/dsh-super-image/releases/tag/v0.1.3) 下载 `.tgz` 安装包。安装后完整重启 DSH，再进入「设置 → Super Image」。

### 配置和使用

1. 至少启用一个后端。只用一个时，可关闭另一个后端，原有配置会保留。API 后端填写地址、模型和凭据。默认凭据引用为 `SUPER_IMAGE_A_API_KEY` 和 `SUPER_IMAGE_B_API_KEY`。
2. ComfyUI 后端填写服务地址，再选择 API 格式的工作流或填写本地文件路径。点击「检查配置」可以在保存前检查字段、凭据状态和工作流节点，不会提交生成任务。详见 [ComfyUI 配置指南](docs/comfyui-contract.md#简体中文)。
3. 保存设置。在聊天框输入 `/super-image 一张雨后夜市的街景，暖色灯光，横向构图`，命令会返回生成摘要和文件路径。工具 `super_image` 还会返回候选图预览。

每个启用的后端可请求 1–4 张图。批量生成部分失败时，插件保留成功的图，并显示实际完成数量。原图和融合图保存在当前会话工作区的 `generate/super-image/`。并排模式只返回候选图。生成融合图需要启用需求校验、可用的视觉模型和至少两张候选图。

### 开发与反馈

运行 `npm install` 和 `npm test`，执行提示词、设置交互和后端回归测试。测试使用模拟服务，无需真实 API 密钥或本地 ComfyUI。提交问题时请附上 DSH 版本、插件版本、后端类型和脱敏后的错误信息。包元数据声明使用 MIT 许可证。

## English

Image generation for DeepSeek Harness (DSH). Each backend can be enabled independently and can use an OpenAI Images-compatible API or ComfyUI. When both backends are enabled, they generate in parallel. You can compare candidates against the requested requirements and generate a fused image when a vision model is available.

### Installation

Use a DSH Web profile with plugin support and Node.js 22.19 or later. To install from GitHub into a profile named `web`:

```powershell
dsh plugin --profile web add github:Byton-Patrica/dsh-super-image
```

Replace `web` with your profile name. The `.tgz` package is also available on the [v0.1.3 release page](https://github.com/Byton-Patrica/dsh-super-image/releases/tag/v0.1.3). After installing, fully restart DSH and open **Settings → Super Image**.

### Configuration and usage

1. Enable at least one backend. You can disable the other and keep its configuration for later. For API backends, enter the endpoint, model, and credentials. The default credential references are `SUPER_IMAGE_A_API_KEY` and `SUPER_IMAGE_B_API_KEY`.
2. For ComfyUI, enter the server URL and select an API-format workflow or enter a local path. **Check configuration** checks fields, credential status, and workflow nodes before saving, without submitting a generation job. See the [ComfyUI setup guide](docs/comfyui-contract.md#english).
3. Save your settings and enter `/super-image A night market after rain, warm lighting, landscape composition` in chat for a summary and file paths. The `super_image` tool also returns inline image previews.

Request 1–4 images per enabled backend. If a batch partially fails, Super Image keeps the usable images and shows the completed count. The plugin saves originals and fused images under `generate/super-image/` in the session workspace. Side-by-side mode returns the candidates. Fusion requires verification to be enabled, an available vision model, and at least two candidates.

### Development and feedback

Run `npm install` followed by `npm test` for prompt, settings, and backend regression tests. The tests use mock services and require no real API key or local ComfyUI instance. When reporting an issue, include the DSH version, plugin version, backend type, and error details with sensitive information removed. The package metadata declares the MIT license.

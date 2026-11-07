# dsh-super-image

[简体中文](#简体中文) · [English](#english) · [下载 / Downloads](https://github.com/Byton-Patrica/dsh-super-image/releases)

## 简体中文

为 DeepSeek Harness (DSH) 提供双后端图像生成。插件并行请求两个独立配置的后端，按需求逐项比较候选图，并在配置和后端能力允许时生成融合图。每个后端可独立使用 OpenAI Images 兼容 API 或 ComfyUI。

### 安装

需要支持 DSH 插件的 Web profile，以及 Node.js 22.19 或更高版本。从 GitHub 安装到名为 `web` 的 profile：

```powershell
dsh plugin --profile web add github:Byton-Patrica/dsh-super-image
```

将 `web` 换成你的 profile 名称。也可以从 [v0.1.3 发布页](https://github.com/Byton-Patrica/dsh-super-image/releases/tag/v0.1.3) 下载 `.tgz` 安装包。安装后完整重启 DSH，再进入「设置 → Super Image」。

### 配置和使用

1. 配置后端 A、B。API 后端填写地址、模型和凭据。密钥存入 DSH 凭据服务，默认引用名为 `SUPER_IMAGE_A_API_KEY` 和 `SUPER_IMAGE_B_API_KEY`。
2. ComfyUI 后端填写服务地址，并选择 API 格式的工作流。详见 [ComfyUI 配置指南](docs/comfyui-contract.md#简体中文)。
3. 在聊天框输入 `/super-image 一张雨后夜市的街景，暖色灯光，横向构图`。也可通过工具 `super_image` 调用。

原图和生成的融合图保存在当前会话工作区的 `generate/super-image/`。如果一个后端失败，插件可返回另一个后端的结果。要只比较候选图，可关闭融合或选择并排模式。

### 开发与反馈

运行 `node --test test/prompts.test.mjs` 执行提示词单元测试。提交问题时请附上 DSH 版本、插件版本、后端类型和脱敏后的错误信息。包元数据声明使用 MIT 许可证。

## English

Dual-backend image generation for DeepSeek Harness (DSH). The plugin calls two independently configured backends in parallel, compares candidates against the requested requirements, and can produce a fused image when the settings and backend capabilities allow it. Each backend can use an OpenAI Images-compatible API or ComfyUI.

### Installation

Use a DSH Web profile with plugin support and Node.js 22.19 or later. To install from GitHub into a profile named `web`:

```powershell
dsh plugin --profile web add github:Byton-Patrica/dsh-super-image
```

Replace `web` with your profile name. The `.tgz` package is also available on the [v0.1.3 release page](https://github.com/Byton-Patrica/dsh-super-image/releases/tag/v0.1.3). After installing, fully restart DSH and open **Settings → Super Image**.

### Configuration and usage

1. Configure backends A and B. For API backends, enter the endpoint, model, and credentials. Store keys in the DSH credential service. The default references are `SUPER_IMAGE_A_API_KEY` and `SUPER_IMAGE_B_API_KEY`.
2. For ComfyUI backends, enter the server URL and select an API-format workflow. See the [ComfyUI setup guide](docs/comfyui-contract.md#english).
3. Enter `/super-image A night market after rain, warm lighting, landscape composition` in chat. The plugin also exposes the `super_image` tool.

The plugin saves the original images and any fused output under `generate/super-image/` in the session workspace. If one backend fails, the plugin can return the other backend's result. To compare candidates only, disable fusion or choose side-by-side mode.

### Development and feedback

Run `node --test test/prompts.test.mjs` to execute the prompt unit tests. When reporting an issue, include the DSH version, plugin version, backend type, and error details with sensitive information removed. The package metadata declares the MIT license.

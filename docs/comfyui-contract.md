# ComfyUI 配置指南 / ComfyUI Setup Guide

## 简体中文

1. 启动 ComfyUI，并在「设置 → Super Image」中将一个后端设为 ComfyUI。默认服务地址为 `http://127.0.0.1:8188`。
2. 在 ComfyUI 导出 **API 格式**工作流，将其保存到该服务实例的工作流目录。在插件里选择工作流，也可在高级设置中填写本地工作流路径。
3. 确认工作流所需的模型和节点已安装。如自动识别失败，在高级设置中手动填写提示词、负面提示词、种子、尺寸和输出节点。
4. 建议先保留工作流的原生尺寸。需要覆盖时，可填写类似 `832x1216` 的值。

若工作流列表为空，检查 ComfyUI 是否运行，以及工作流是否保存在当前连接的实例中。普通界面导出的 JSON 含有 `nodes` 和 `links`，请重新导出 API 格式。Windows 上使用自动启动时，可通过环境变量 `DSH_COMFY_START_SCRIPT` 指定启动脚本。

## English

1. Start ComfyUI and set one backend to ComfyUI in **Settings → Super Image**. The default server URL is `http://127.0.0.1:8188`.
2. Export an **API-format** workflow from ComfyUI and save it to that server instance's workflow directory. Select it in the plugin or set a local workflow path in the advanced settings.
3. Make sure the models and nodes required by the workflow are installed. If detection fails, set the prompt, negative prompt, seed, size, and output nodes manually in the advanced settings.
4. Start with the workflow's native dimensions. Enter a value such as `832x1216` to override them.

If the workflow list is empty, check that ComfyUI is running and that the workflow is saved in the instance you connected to. A regular UI export contains `nodes` and `links`. Export it again in API format. For automatic startup on Windows, set `DSH_COMFY_START_SCRIPT` to your startup script.

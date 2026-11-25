# 版本记录 / Changelog

## v0.2.0

**简体中文**

- 后端可独立启停，也可在保存前检查配置。刷新工作流和启动 ComfyUI 会保留未保存的更改。
- 批量请求部分失败时保留已生成的候选图。工具预览所有可用图片，重复运行使用不同文件名。
- ComfyUI 按设置下载指定节点的输出。并排模式直接返回候选图，视觉比对表会保留待确认的需求。

**English**

- Enable or disable each backend and check its configuration before saving. Refreshing workflows or starting ComfyUI preserves unsaved edits.
- Partial batches keep successful images. The tool previews every available image, and each run uses different file names.
- ComfyUI downloads from the selected output node. Side-by-side mode returns the candidates directly, and the comparison table keeps requirements that still need review.

## v0.1.3

**简体中文** · 首次在 GitHub 发布。支持两个独立图像后端、按需求比较候选图，以及可选的融合输出。

**English** · Initial GitHub release. Supports two independently configured image backends, requirement-based candidate comparison, and optional fused output.

[下载安装包 / Download the package](https://github.com/Byton-Patrica/dsh-super-image/releases/tag/v0.1.3)

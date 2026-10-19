# 句读 · 英文阅读批注

保留完整文章段落，用实线标主句主干、虚线标从句内部成分，以内嵌括号和中文标签标出从句与补充结构的边界及归属。

## 使用

- 通过「编辑 / 粘贴原文」替换文章，空行分隔段落。
- 「主句主干」与「从句 / 补充」可以分别隐藏。
- 自带用户提供文章的七句精读。新文章保留原文排版，不会伪造自动语法分析。
- 将新文章交给 AI 分析，再通过「导入标注」导入 JSON；界面提供可复制的分析格式。
- 导出 JSON 保存原文及标注，打印可保存为 PDF。
- 文章保存在当前浏览器 localStorage；没有在线 AI 请求或 API 密钥。

## 开发

纯静态网页，没有依赖安装或构建步骤。在本目录运行：

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory dist
```

浏览器打开 http://127.0.0.1:4173 。

`dist/examples.js` 保存七句精读；`dist/annotations.js` 保存从句边界与内嵌标注渲染；`dist/engine.js` 处理分句及导入校验；`dist/app.js` 处理文章、排版和浏览器保存。

精读 JSON 结构为 `{version:1, documentText, analyses}`。`documentText` 保留原始段落；每个分析包含 `sentence`、完整拼接原文的 `fragments`、`details`、`tree`、`steps`、`translation`。可选 `clauses` 指定 `text`、`label`、`relation`、`kind`（clause 或 phrase）及内部 `parts`。所有导入文本只作为数据渲染。

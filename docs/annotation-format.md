# 标注输入输出约定

输入是英文纯文本，保留标题和空行。输出使用紧凑的 v2 JSON：

```json
{
  "version": 2,
  "documentText": "Birds eat seeds.",
  "analyses": [{
    "sentence": "Birds eat seeds.",
    "main": [
      {"text": "Birds", "role": "subject"},
      {"text": "eat", "role": "predicate"},
      {"text": "seeds", "role": "object"}
    ],
    "clauses": []
  }]
}
```

- `documentText`：第一批包含完整原文，后续批次省略。它与当前文章相同时合并标注，不同时载入新文章。
- `sentence`：一句完整原文。分句须与网页保持一致；不要把从句或分号两侧拆成单独句子。
- `main`：主句成分。`role` 为 `subject`、`predicate`、`object` 或 `complement`；固定的中文成分名称由网页补上。可选 `label`（可省略或为 `null`）保留“形式主语”“表语”“宾语补足语”等更具体的判断。main 各片段不重叠。
- `clauses`：每项有 `text`、`kind`、`label`、`relation`、`parts`。`kind` 为含限定谓语的 `clause` 或动名词、不定式、分词、介词短语及同位补充等 `phrase`；`label` 必须保留具体语法名称，`relation` 说明修饰谁或充当什么；`parts` 与 main 使用相同片段格式，表示该结构自己的主干。
- `text`：必须与父级原文逐字一致。同一片段重复时可加 `occurrence`，从 0 开始，按完整单词边界计数；默认 0。main 与 clauses 在 sentence 中定位，parts 在该条 clause.text 中定位。
- 新标注不要求 `translation`、`summary`；导入旧结果时仍兼容这些字段。不需要 GPT 输出旧版的 fragments、details、tree 或 steps。

这是用于学习长难句的标注格式，精简字段不能省掉语法判断。例如 `Reading books` 可标为“动名词短语”，关系是“作 helps 的主语”；`to improve her English` 可标为“不定式·目的状语”，关系是“修饰 reads，说明阅读目的”。目的、原因、条件、让步、时间、方式、结果等状语功能都应按具体句意区分，不能仅显示一个泛化的“短语”标签。具体片段可以同时充当主句成分，并在 `clauses` 中展开自己的内部结构。

项目根目录的 [`标注格式示例.json`](../标注格式示例.json) 提供含定语从句、宾语从句的完整可导入示例。v1 导出文件仍然兼容。无效结果会显示错误并保留现有文章，不会自动修补或猜测原文。所有导入内容只作为数据解析并转义显示。


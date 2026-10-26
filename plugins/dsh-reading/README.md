# dsh-reading · 按词表出阅读理解

给 `dsh-wordbook` 用的出题服务。短文字数按词数动态拉长，并要求**每个目标词至少出现一次**（原形或常见变形都算）。

## 接口

`POST /dsh-reading/api/make`

```json
{
  "words": [{"term": "generate", "meaning": "产生"}],
  "count": 3,
  "difficulty": "高中"
}
```

返回 `{ok:true, reading:{title, passage, questions, words, wordCount, raw?}}`。

- 词少（<40）时正方 `count` 默认 5；词多时调用方会传 3，避免输出被截断。
- 短文长度 `max(220, 词数 × 8)`，上限 900 词。
- JSON 解析失败时返回 `raw:true` + 原始文本，前端会再降题重试一次。
- 只生成题目，不写回任何词表或墨墨。

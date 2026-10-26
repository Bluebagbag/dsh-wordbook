# dsh-wordbook

DSH 客户端 + 宿主半边：左侧栏「背单词」面板。

## 功能

- 词卷贴左，滚动查看；每个词显示序号、拼写、音标、复习状态，中文释义默认遮住，点一下显示。
- 录入支持 `apple 苹果`、`look for 寻找`、`abandon`；只写英文会自动查释义/音标。
- 本地艾宾浩斯排期：10 分钟 → 1 小时 → 1 天 → 2 天 → 4 天 → 7 天 → 15 天 → 30 天 → 60 天 → 90 天。
- 墨墨今日任务（可选，只读）：显示真实进度、学习时长、易忘词；按 `is_new` / `STICKING` / `study_count` / `WELL_FAMILIAR` 自动分「词义」和「整句」模式。
- 聊天式教练：先回忆/猜，一次 1~2 个词，答错先指错再让改，支持英译中默写，不给中文选项。
- 阅读理解：优先用墨墨今日全部单词，短文长度随词数增长，词多时自动减少题目以保证全覆盖。

## 依赖

- `dsh-maimemo`：墨墨只读桥（可选）
- `dsh-reading`：长词表阅读题生成
- DSH 当前默认模型（`ctx.llm`）

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | 宿主半边：本地存储、`/chat`、`/lookup`、`/reading` |
| `client.js` | 客户端半边：侧栏图标、主面板、词卷、聊天、阅读题 |
| `test/smoke.mjs` | 纯逻辑测试 |
| `test/render.mjs` | 最小 React 替身渲染测试 |

## 数据

- `localStorage["dsh-wordbook:state:v1"]`
- `$DSH_HOME/wordbook/state.json`

## 测试

```bash
node test/smoke.mjs
node test/render.mjs
```

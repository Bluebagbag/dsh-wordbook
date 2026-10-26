# 背单词 · DSH 插件

给 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai) Web 界面用的背单词插件：

- 左侧栏「背单词」入口，词卷贴着面板左边，像卷轴一样可滚动；
- 自己录入单词，中文释义和音标自动补；
- 艾宾浩斯复习排期 + 每日任务；
- 聊天式词汇教练：先让你回忆/猜，一次只练 1~2 个词，答错先指出错在哪；
- 一键出阅读理解题，**可以用墨墨今日的全部单词**写短文（词多时自动拉长短文 / 减少题目）；
- 可选接入墨墨背单词开放 API，**只读**读取今日任务、学习进度、阶段标签，不修改你的学习内容。

> 这不是墨墨或 DeepSeek 官方项目，是个人自用插件整理出来的。墨墨开放 API 目前是公测，接口可能变。

## 三个插件

| 目录 | 作用 |
| --- | --- |
| `plugins/dsh-wordbook` | 主插件：侧栏词卷、本地词表、聊天、阅读题；客户端 + 宿主 |
| `plugins/dsh-maimemo` | 墨墨开放 API 的**只读**桥：今日任务、进度、学习记录、自定义释义/例句 |
| `plugins/dsh-reading` | 按词数动态拉长的阅读题生成服务，保证长词表也能全覆盖 |

## 安装

前置：已经装好 DSH，并有一个 profile（默认 `~/.dsh/profiles/web`）。

```bash
git clone <你的仓库地址> dsh-wordbook
cd dsh-wordbook
bash install.sh
```

`install.sh` 会做四件事（可重复执行）：

1. 把三个插件链接到 profile 的 `node_modules/`；
2. 在 profile 的 `package.json` 里补上 `link:` 依赖；
3. 在 `cordis.patch.yml` 末尾追加三个 Loader 行（已存在就跳过）；
4. 在 `$DSH_HOME/maimemo/config.json` 生成一个空 token 模板（已存在则不覆盖，权限 600）。

装完 **刷新一次网页**；宿主半边由 patch 热加载，客户端半边要刷新页面进入 boot manifest。

## 配置墨墨（可选）

不接墨墨也能用本地词表和艾宾浩斯。

1. 墨墨 App：我的 → 更多设置 → 实验功能 → 开放 API，复制 token；
   或网页登录 `https://open.maimemo.com/open/api/v1/tokens/openapi`（网页 token 7 天有效）。
2. 写入 `$DSH_HOME/maimemo/config.json`：

```json
{
  "baseUrl": "https://open.maimemo.com/open/api/v1",
  "token": "你的 token"
}
```

3. 刷新页面，词卷顶部会出现「墨墨今日」。

## 只读保证

墨墨桥只调用这些接口：

- `study/get_study_progress`
- `study/get_today_items`
- `study/query_study_records`
- `vocabulary/query`
- `interpretations`（读取）
- `phrases`（读取）

**没有** `add_words`、`advance_study`、创建/修改助记、释义、例句、云词本等任何写接口。聊天调用模型时也不传工具，模型只能返回文本，无法真的改任何东西。

## 数据放在哪

| 位置 | 内容 |
| --- | --- |
| 浏览器 `localStorage["dsh-wordbook:state:v1"]` | 本地词表、聊天、当前阅读题 |
| `$DSH_HOME/wordbook/state.json` | 同一份快照，作为备份 |
| `$DSH_HOME/maimemo/config.json` | 墨墨 token（600 权限，不进仓库） |

## 开发 / 测试

```bash
node plugins/dsh-wordbook/test/smoke.mjs
node plugins/dsh-wordbook/test/render.mjs
```

- `smoke.mjs`：词条解析、状态规整、艾宾浩斯升阶/遗忘、墨墨阶段判定；
- `render.mjs`：用最小 React 替身跑一遍面板渲染，检查词卷、今日任务、释义默认遮住等。

## 已知限制

- 墨墨学习数据是公测接口，偶尔 503；面板会提示，点 ↻ 重试即可。
- 墨墨 `interpretations` / `phrases` 只返回**你账号自己创建过**的内容，不含内置词典；没有内容时插件会用 AI 释义/造句兜底。
- 阅读题由 AI 生成，偶尔会有不严谨的地方。
- 不做账号体系、多端同步；数据保存在本机。

## License

MIT

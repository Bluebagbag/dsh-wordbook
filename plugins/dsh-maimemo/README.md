# dsh-maimemo · 墨墨开放 API 只读桥

把墨墨背单词开放 API 包成宿主侧的同源只读接口，供 `dsh-wordbook` 调用。

## 铁律：只读

**不调用任何写接口。** 不 `add_words`、不 `advance_study`、不创建/修改释义、助记、例句、云词本。所有请求都是：

- `POST /study/get_study_progress`
- `POST /study/get_today_items`
- `POST /study/query_study_records`
- `POST /vocabulary/query`
- `GET /interpretations?voc_id=`
- `GET /phrases?voc_id=`

AI 只负责出题和讲解，不会改动你在墨墨里的学习内容或进度。

## Token

放在宿主侧，不进前端：

```
$DSH_HOME/maimemo/config.json（权限 600）
{
  "baseUrl": "https://open.maimemo.com/open/api/v1",
  "token": "你的 token"
}
```

网页登录拿到的 token 只有 7 天；App 里「我的 → 更多设置 → 实验功能 → 开放 API」拿到的更稳。

## 接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/dsh-maimemo/api/status` | 是否配置 token、缓存状态 |
| POST | `/dsh-maimemo/api/today` | 今日进度 + 今日单词 + study_count/tags/模式 |
| POST | `/dsh-maimemo/api/lookup` | 拼写 → voc_id、账号自定义释义/例句 |

`/today` 返回的每个词带 `mode`：

- `word`：新词、STICKING 易忘，或学习次数 < 4 → 只问句中目标词的意思；
- `sentence`：WELL_FAMILIAR 或学习次数 ≥ 4 → 让整句翻译。

## 限速与缓存

- 墨墨限速 20 次/10 秒，桥内所有请求串行排队，间隔 550ms。
- 今日任务缓存 25 秒；词条查询缓存 6 小时。
- `interpretations` / `phrases` 只返回**你账号自己创建过**的内容，没创建过就是空数组；前端会退回 AI 词典，不会把空结果当成“没有释义”。

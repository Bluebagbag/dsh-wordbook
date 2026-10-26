/**
 * dsh-wordbook — 客户端半边
 * ════════════════════════════════════════════════════════════════════════
 * 左侧栏一个「背单词」入口 + 一个主面板：
 *   · 词表：自己录入（一行一个，支持「word 释义」），保存在本机；
 *   · 对话：把词表带给模型，聊天式讲解、造句、测验；
 *   · 阅读理解：一键让模型用这些词写短文 + 单选题，点选项当场判对错。
 *
 * 颜色全部走 DSH 主题 token，浅色/深色都跟手。
 */

window.__ModuleLoader__.load({
  id: 'dsh-wordbook',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const API = '/dsh-wordbook/api';
    const MM_API = '/dsh-maimemo/api';
    const LS_KEY = 'dsh-wordbook:state:v1';
    const EMPTY_STATE = { version: 1, words: [], chat: [], reading: null, updatedAt: 0 };
    const DIFFICULTIES = ['初中', '高中', '四级', '六级', '考研'];
    const SIDE_KEY = 'dsh-wordbook:side:v1';

    // 宿主旧版本没有 /lookup 时，用聊天接口也能查词典；这段规则同时给旧宿主补上「带练式」提问。
    const COACH_RULES = `【这一轮请严格按「词汇教练」的方式回答，别当词典】
1. 先让我回忆或猜，再揭晓。我直接问意思时，也先给一个例句让我猜，或只给提示；我说「不知道/直接说」再讲。
2. 一次只练 1~2 个词：核心义一句话 → 生活化例句+翻译 → 记忆钩子（词根/联想/对比）→ 一个 10 秒小检查（英译中默写或英文填空，不要中文选项）。
3. 我答错时，指出错在哪，再给正确说法，并让我马上改说一遍。
4. 出题分阶段，默认是「生词模式」：给一个含目标词的英文句子，然后只问我「句子里 X 是什么意思」，让我填这个词的中文；不要让我翻译整句，也不要给中文选项或中文提示。
5. 只有我明确说这个词已经背熟了，或者任务里标了「整句翻译」，才切换到「熟词模式」：还是只给英文句子，但让我把整句翻成中文。没有标注就按生词模式来。
6. 同一个词在不同句子里中文可能不同，按语境判断我的答案贴不贴合；意思对就给过，再补更准的说法。无论哪种模式都别一次报出答案。
7. 我说「开始复习/测我」时，从词表抽词一次一题，答完再下一题；错词隔几题再考。
8. 中文为主，200 字以内，别灌水，别每次都用同一种开场白。

我的消息：`;

    // ── 1. 数据：解析 / 规整 / 本地存取 ────────────────────────────────

    function cleanText(value, max) {
      return String(value ?? '').trim().slice(0, max);
    }

    // 艾宾浩斯复习阶梯（分钟）：5 分钟 → 30 分钟 → 12 小时 → 1/2/4/7/15/30/60 天。
    const REVIEW_INTERVALS = [10, 60, 24 * 60, 2 * 24 * 60, 4 * 24 * 60, 7 * 24 * 60, 15 * 24 * 60, 30 * 24 * 60, 60 * 24 * 60, 90 * 24 * 60];
    const DAY_MS = 24 * 60 * 60 * 1000;

    function startOfDay(now = Date.now()) {
      const date = new Date(now);
      date.setHours(0, 0, 0, 0);
      return date.getTime();
    }

    function endOfDay(now = Date.now()) {
      const date = new Date(now);
      date.setHours(23, 59, 59, 999);
      return date.getTime();
    }

    /** 旧数据没有 review 时，按创建时间补一条：5 分钟后进入第一次复习。 */
    function normalizeReview(raw, createdAt) {
      const created = Number(createdAt) || Date.now();
      const stageNumber = Number(raw && raw.stage);
      const stage = Number.isFinite(stageNumber) ? Math.max(0, Math.min(REVIEW_INTERVALS.length - 1, Math.floor(stageNumber))) : 0;
      const dueAt = Number(raw && raw.dueAt) || created + REVIEW_INTERVALS[0] * 60000;
      return {
        stage,
        dueAt,
        lastAt: Number(raw && raw.lastAt) || 0,
        lapses: Math.max(0, Number(raw && raw.lapses) || 0),
        reviews: Math.max(0, Number(raw && raw.reviews) || 0),
      };
    }

    /** 记住 → 进入下一阶；忘了 → 回到第一阶重来。 */
    function rateReview(review, remembered, now = Date.now()) {
      const current = review || {};
      const reviews = (Number(current.reviews) || 0) + 1;
      if (remembered) {
        const stage = Math.min((Number(current.stage) || 0) + 1, REVIEW_INTERVALS.length - 1);
        return { stage, lastAt: now, dueAt: now + REVIEW_INTERVALS[stage] * 60000, lapses: Number(current.lapses) || 0, reviews };
      }
      return { stage: 0, lastAt: now, dueAt: now + REVIEW_INTERVALS[0] * 60000, lapses: (Number(current.lapses) || 0) + 1, reviews };
    }

    function isDueToday(word, now = Date.now()) {
      const dueAt = Number(word && word.review && word.review.dueAt);
      return Number.isFinite(dueAt) && dueAt <= endOfDay(now);
    }

    function isDueNow(word, now = Date.now()) {
      const dueAt = Number(word && word.review && word.review.dueAt);
      return Number.isFinite(dueAt) && dueAt <= now;
    }

    /**
     * 词是否已经「背熟」：成功复习到第 4 阶（大约第 3~4 天），或者已经在词表里待满 7 天。
     * 熟词才做整句翻译；生词只问句中目标词的意思。
     */
    function isMature(word, now = Date.now()) {
      const stage = Number(word && word.review && word.review.stage) || 0;
      const created = Number(word && word.createdAt) || now;
      return stage >= 4 || now - created >= 7 * DAY_MS;
    }

    function dueLabel(word, now = Date.now()) {
      const dueAt = Number(word && word.review && word.review.dueAt);
      if (!Number.isFinite(dueAt)) return '待排期';
      const diff = dueAt - now;
      if (diff <= 0) return '现在复习';
      if (diff < 60 * 60 * 1000) return Math.max(1, Math.ceil(diff / 60000)) + ' 分钟后';
      if (diff < DAY_MS) return Math.ceil(diff / (60 * 60 * 1000)) + ' 小时后';
      return Math.ceil(diff / DAY_MS) + ' 天后';
    }

    function normalizeWords(input) {
      if (!Array.isArray(input)) return [];
      const out = [];
      const seen = new Set();
      for (const item of input) {
        const term = cleanText(item && typeof item === 'object' ? item.term ?? item.word : item, 120);
        const meaning = cleanText(item && typeof item === 'object' ? item.meaning : '', 300);
        if (!term) continue;
        const key = term.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          id: String(item && typeof item === 'object' && item.id ? item.id : 'w-' + key.replace(/[^a-z0-9]+/g, '-') + '-' + out.length),
          term,
          meaning,
          phonetic: cleanText(item && typeof item === 'object' ? item.phonetic : '', 80),
          pos: cleanText(item && typeof item === 'object' ? item.pos : '', 20),
          createdAt: Number(item && typeof item === 'object' ? item.createdAt : 0) || Date.now(),
          review: normalizeReview(item && typeof item === 'object' ? item.review : null, Number(item && typeof item === 'object' ? item.createdAt : 0) || Date.now()),
        });
      }
      return out.slice(0, 500);
    }

    function normalizeState(raw) {
      if (!raw || typeof raw !== 'object') return { ...EMPTY_STATE };
      const chat = (Array.isArray(raw.chat) ? raw.chat : [])
        .filter((message) => message && typeof message === 'object' && (message.role === 'user' || message.role === 'assistant') && String(message.content ?? '').trim())
        .slice(-200)
        .map((message) => ({
          role: message.role,
          content: String(message.content),
          ts: Number(message.ts) || Date.now(),
        }));
      return {
        version: 1,
        words: normalizeWords(raw.words),
        chat,
        reading: raw.reading && typeof raw.reading === 'object' ? raw.reading : null,
        updatedAt: Number(raw.updatedAt) || 0,
      };
    }

    function loadLocal() {
      try {
        return normalizeState(JSON.parse(localStorage.getItem(LS_KEY) || 'null'));
      } catch {
        return { ...EMPTY_STATE };
      }
    }

    function saveLocal(state) {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(state));
      } catch {
        /* 隐私模式 / 容量满：磁盘还有一份，不打断使用 */
      }
    }

    /**
     * 一行一个单词。支持这些写法：
     *   apple 苹果     apple - 苹果     apple: 苹果     apple\t苹果
     * 只有英文没有释义也收。
     */
    function parseWordInput(text) {
      const rows = String(text ?? '').split(/\r?\n/);
      const out = [];
      for (const raw of rows) {
        const line = raw.replace(/^\s*(?:[-*•]|\d+[.)、])\s+/, '').trim();
        if (!line || line.startsWith('#')) continue;
        let term = '';
        let meaning = '';
        const delimiter = line.match(/^(.+?)\s*(?:\t|\s[-—–=:：|]\s?|\s{2,})(.+)$/);
        if (delimiter) {
          term = delimiter[1];
          meaning = delimiter[2];
        } else {
          // 先按「英文部分 / 中文释义」切：这样 look forward to 期待 能整条收进来。
          const cjk = line.search(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]/);
          if (cjk > 0) {
            term = line.slice(0, cjk);
            meaning = line.slice(cjk);
          } else {
            const firstSpace = line.search(/\s/);
            if (firstSpace > 0) {
              term = line.slice(0, firstSpace);
              meaning = line.slice(firstSpace + 1);
            } else {
              term = line;
            }
          }
        }
        term = term.replace(/^["'“”]+|["'“”]+$/g, '').replace(/[\s\-—–=:：|]+$/, '').trim();
        meaning = meaning.replace(/^[-—–=:：\s]+/, '').trim();
        if (!term) continue;
        out.push({ term, meaning });
      }
      return out;
    }

    async function postJson(path, body, base = API) {
      const response = await fetch(base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) {
        const error = new Error(data.error || 'HTTP ' + response.status);
        error.status = response.status;
        throw error;
      }
      return data;
    }

    /** 把模型回答里的 **粗体** 和 `行内代码` 渲染出来，其余保持原样（换行靠 pre-wrap）。 */
    function richText(text) {
      const parts = String(text ?? '').split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g);
      return parts.map((part, index) => {
        if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
          return h('strong', { key: index }, part.slice(2, -2));
        }
        if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
          return h('code', { key: index }, part.slice(1, -1));
        }
        return part;
      });
    }

    // ── 2. 图标 ───────────────────────────────────────────────────────

    function BookIcon({ size = 16 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', { d: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15.5H6.5A2.5 2.5 0 0 0 4 21z' }),
        h('path', { d: 'M4 18.5A2.5 2.5 0 0 1 6.5 16H19' }),
        h('path', { d: 'M8 7h7M8 10.5h5' }),
      );
    }

    function SparkIcon({ size = 16 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', { d: 'M12 3l1.6 5.4L19 10l-5.4 1.6L12 17l-1.6-5.4L5 10l5.4-1.6z' }),
        h('path', { d: 'M18.5 16.5l.7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7z' }),
      );
    }

    function SidebarIcon({ size = 16 }) {
      return h(BookIcon, { size });
    }

    // ── 3. 主面板 ─────────────────────────────────────────────────────

    function WordbookPanel(props) {
      const testMaimemo = props && props.__testMaimemo;
      const [state, setState] = React.useState(loadLocal);
      const [ready, setReady] = React.useState(false);
      const [tab, setTab] = React.useState('chat');
      const [draft, setDraft] = React.useState('');
      const [showAdd, setShowAdd] = React.useState(false);
      const [addText, setAddText] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [readingBusy, setReadingBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const [difficulty, setDifficulty] = React.useState('高中');
      const [answers, setAnswers] = React.useState({});
      const [showAll, setShowAll] = React.useState(false);
      const [revealed, setRevealed] = React.useState({});
      const [sideOpen, setSideOpen] = React.useState(() => {
        try {
          return localStorage.getItem(SIDE_KEY) !== '0';
        } catch {
          return true;
        }
      });
      const [lookingUp, setLookingUp] = React.useState(false);
      const [onlyDue, setOnlyDue] = React.useState(false);
      const [maimemo, setMaimemo] = React.useState(() => testMaimemo || { status: 'idle', progress: null, items: [], counts: null, error: '' });
      const [source, setSource] = React.useState(() => (testMaimemo ? 'maimemo' : 'local'));
      const [mmMeanings, setMmMeanings] = React.useState({});
      const [mmBusy, setMmBusy] = React.useState({});
      const sourceTouched = React.useRef(false);
      const mmCustomProbe = React.useRef(null);
      const lookupAttempted = React.useRef(new Set());
      const lookupBusy = React.useRef(false);

      const scrollRef = React.useRef(null);
      const composerRef = React.useRef(null);
      const stateRef = React.useRef(state);
      stateRef.current = state;

      // 先读本机磁盘快照：比 localStorage 更耐清理。取较新的一份。
      React.useEffect(() => {
        let alive = true;
        fetch(API + '/state')
          .then((response) => response.json())
          .then((data) => {
            if (!alive || !data || !data.ok || !data.state) return;
            const remote = normalizeState(data.state);
            const local = loadLocal();
            const remoteHasData = remote.words.length > 0 || remote.chat.length > 0 || remote.reading;
            if (remoteHasData && (remote.updatedAt || 0) >= (local.updatedAt || 0)) setState(remote);
          })
          .catch(() => {
            /* 宿主路由还没挂上也照常能用 localStorage */
          })
          .finally(() => {
            if (alive) setReady(true);
          });
        return () => {
          alive = false;
        };
      }, []);

      // 读墨墨今日任务（只读）。连不上就保持本地任务可用。
      React.useEffect(() => {
        loadMaimemo(false);
      }, []);

      // 每次改动：localStorage 立即写，磁盘防抖写。
      React.useEffect(() => {
        if (!ready) return undefined;
        saveLocal(state);
        const timer = setTimeout(() => {
          postJson('/state', { state }).catch(() => {});
        }, 350);
        return () => clearTimeout(timer);
      }, [state, ready]);

      React.useEffect(() => {
        try {
          localStorage.setItem(SIDE_KEY, sideOpen ? '1' : '0');
        } catch {
          /* ignore */
        }
      }, [sideOpen]);

      // 词表里缺释义/音标的词，自动查一次（模型出词典条目）。
      const wordKey = state.words.map((word) => word.term).join('\u0000');
      React.useEffect(() => {
        if (!state.words.length) return undefined;
        const pending = state.words.some(
          (word) => (!word.meaning || !word.phonetic) && !lookupAttempted.current.has(word.term.toLowerCase()),
        );
        if (!pending) return undefined;
        const timer = setTimeout(() => ensureMeanings(state.words), 250);
        return () => clearTimeout(timer);
      }, [wordKey, ready]);

      React.useEffect(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      }, [state.chat.length, busy, tab, state.reading, readingBusy]);

      /** 词条展示文本：词性 + 释义。 */
      function meaningOf(word) {
        return [word.pos, word.meaning].filter(Boolean).join(' ').trim();
      }

      /** 温和地从模型输出里抠 JSON（数组或对象）。 */
      function parseJsonLoose(text) {
        let body = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        const objAt = body.indexOf('{');
        const arrAt = body.indexOf('[');
        const arrayFirst = arrAt >= 0 && (objAt < 0 || arrAt < objAt);
        const first = arrayFirst ? arrAt : objAt;
        const last = arrayFirst ? body.lastIndexOf(']') : body.lastIndexOf('}');
        if (first >= 0 && last > first) body = body.slice(first, last + 1);
        return JSON.parse(body);
      }

      function normalizeEntries(payload) {
        const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.entries) ? payload.entries : [];
        return rows
          .filter((row) => row && typeof row === 'object' && String(row.term ?? '').trim())
          .map((row) => ({
            term: String(row.term).trim(),
            phonetic: String(row.phonetic ?? '').trim(),
            pos: String(row.pos ?? '').trim(),
            meaning: String(row.meaning ?? '').trim(),
          }));
      }

      /** 旧宿主没有 /lookup 时的兜底：走聊天接口做一次词典查询。 */
      async function lookupViaChat(terms) {
        const message = [
          '词典查询。请严格只输出一个 JSON 数组，不要任何解释或代码块：',
          '[{"term":"单词原样","phonetic":"英式音标，用斜杠包住","pos":"词性缩写","meaning":"最常见中文释义，最多3个义项"}]',
          '',
          '要查的单词：',
          terms.map((term) => '- ' + term).join('\n'),
        ].join('\n');
        const data = await postJson('/chat', { message, history: [], words: [] });
        return normalizeEntries(parseJsonLoose(data.text));
      }

      /** 给缺释义/音标的词补上词典信息。 */
      async function ensureMeanings(words) {
        if (lookupBusy.current) return;
        const need = words
          .filter((word) => (!word.meaning || !word.phonetic) && !lookupAttempted.current.has(word.term.toLowerCase()))
          .slice(0, 40);
        if (need.length === 0) return;
        for (const word of need) lookupAttempted.current.add(word.term.toLowerCase());
        lookupBusy.current = true;
        setLookingUp(true);
        try {
          let entries = [];
          try {
            const data = await postJson('/lookup', { words: need.map((word) => ({ term: word.term })) });
            entries = normalizeEntries(data.entries);
            if (entries.length === 0) throw new Error('empty');
          } catch {
            entries = await lookupViaChat(need.map((word) => word.term));
          }
          const byTerm = new Map(entries.map((entry) => [entry.term.toLowerCase(), entry]));
          if (byTerm.size === 0) return;
          setState((previous) => ({
            ...previous,
            words: previous.words.map((word) => {
              const hit = byTerm.get(word.term.toLowerCase());
              if (!hit) return word;
              return {
                ...word,
                meaning: word.meaning || hit.meaning,
                phonetic: word.phonetic || hit.phonetic,
                pos: word.pos || hit.pos,
              };
            }),
            updatedAt: Date.now(),
          }));
        } catch (err) {
          setError('查释义失败：' + (err && err.message ? err.message : String(err)));
        } finally {
          lookupBusy.current = false;
          setLookingUp(false);
          // 查询期间又加进来的词：等这次收尾后补查一轮。
          const remaining = stateRef.current.words.some(
            (word) => (!word.meaning || !word.phonetic) && !lookupAttempted.current.has(word.term.toLowerCase()),
          );
          if (remaining) setTimeout(() => ensureMeanings(stateRef.current.words), 150);
        }
      }

      /** 给一个词打分，推进/重置它的艾宾浩斯时间表。 */
      function rateWord(word, remembered) {
        const now = Date.now();
        setState((previous) => ({
          ...previous,
          words: previous.words.map((item) => (item.id === word.id ? { ...item, review: rateReview(item.review, remembered, now) } : item)),
          updatedAt: now,
        }));
        // 记住了就收起释义准备下一轮；忘了就把释义留在眼前，先看明白。
        setRevealed((previous) => ({ ...previous, [word.id]: !remembered }));
      }

      /** 读取墨墨今日任务（只读）。 */
      async function loadMaimemo(force) {
        setMaimemo((previous) => ({ ...previous, status: 'loading', error: '' }));
        try {
          const data = await postJson('/today', { force: force === true }, MM_API);
          const items = Array.isArray(data.items) ? data.items : [];
          setMaimemo({ status: 'ready', progress: data.progress || null, items, counts: data.counts || null, error: '' });
          if (!sourceTouched.current && items.length > 0) setSource('maimemo');
        } catch (err) {
          setMaimemo({ status: 'error', progress: null, items: [], counts: null, error: err && err.message ? err.message : String(err) });
        }
      }

      function switchSource(next) {
        sourceTouched.current = true;
        setSource(next);
      }

      /** 墨墨词条：先试账号里的自定义释义/例句；没有就退回 AI 词典。绝不写回墨墨。 */
      async function ensureMaimemoMeaning(spelling) {
        const key = String(spelling || '').toLowerCase();
        if (!key) return;
        if (mmMeanings[key] && mmMeanings[key].checked) return;
        if (mmBusy[key]) return;
        setMmBusy((previous) => ({ ...previous, [key]: true }));
        let text = '';
        let phonetic = '';
        let meaningSource = 'maimemo';
        let phrases = [];
        // 墨墨自定义内容和 AI 词典并行取：自定义内容通常为空，串行会让第一次点开等两轮。
        const modelPromise = lookupViaChat([spelling]).catch(() => []);
        try {
          // 同一个词只探一次自定义内容，避免每个词都多等两轮网络。
          if (mmCustomProbe.current !== false) {
            try {
              const data = await postJson('/lookup', { spellings: [spelling], phrases: true }, MM_API);
              const entry = Array.isArray(data.words) ? data.words[0] : null;
              text = (entry?.meanings || []).map((item) => item.text).filter(Boolean).join('；');
              phrases = Array.isArray(entry?.phrases) ? entry.phrases : [];
              mmCustomProbe.current = Boolean(text || phrases.length);
            } catch {
              mmCustomProbe.current = false;
            }
          }
          if (!text) {
            const entries = await modelPromise;
            const hit = entries[0];
            text = hit?.meaning || '';
            phonetic = hit?.phonetic || '';
            meaningSource = 'model';
          }
          setMmMeanings((previous) => ({ ...previous, [key]: { text, phonetic, phrases, source: meaningSource, checked: true } }));
        } catch (err) {
          setMmMeanings((previous) => ({ ...previous, [key]: { text: '', phonetic: '', phrases: [], source: 'model', checked: true, error: err && err.message ? err.message : String(err) } }));
        } finally {
          setMmBusy((previous) => ({ ...previous, [key]: false }));
        }
      }

      /** 用墨墨今日任务出题；只出题和讲解，不修改墨墨里的任何内容。 */
      function startMaimemoReview() {
        const items = maimemo.items || [];
        if (items.length === 0) {
          setError('墨墨今天没有单词数据，先确认 App 里已经生成今日任务。');
          return;
        }
        const remaining = items.filter((item) => !item.isFinished);
        const pool = (remaining.length > 0 ? remaining : items.slice()).sort((left, right) => {
          const weight = (item) => (item.sticking ? 2 : 0) + (item.firstResponse === 'FORGET' ? 1 : 0);
          return weight(right) - weight(left);
        });
        const targets = pool.slice(0, 12);
        const plan = targets
          .map((item) => {
            const key = String(item.spelling).toLowerCase();
            const cached = mmMeanings[key];
            const tag = item.sticking ? '易忘' : item.isNew ? '新词' : item.wellFamiliar ? '熟知' : '复习';
            const mode = item.mode === 'sentence' ? '整句翻译（熟词）' : '只问这个词的意思（生词）';
            let line = '- ' + item.spelling + '（' + tag + '，已学 ' + item.studyCount + ' 次，' + mode + '）';
            if (cached?.text) line += '；可用释义：' + cached.text;
            if (cached?.phrases?.length > 0) line += '；可用例句：' + cached.phrases[0].text + (cached.phrases[0].translation ? '（' + cached.phrases[0].translation + '）' : '');
            return line;
          })
          .join('\n');
        setTab('chat');
        setError('');
        send(
          '今天按墨墨的今日任务复习这些词（只读任务，不要修改墨墨里的任何内容）。请严格按每行后面的模式逐个出题：\n' +
            plan +
            '\n\n规则：\n' +
            '1. 生词模式：先给一个含这个词的英文句子，然后只问我「句子里 X 是什么意思」，让我填这个词的中文；不要让我翻译整句。\n' +
            '2. 熟词模式：给一个含这个词的英文句子，让我把整句翻成中文。\n' +
            '3. 有「可用例句」就优先用那个例句；没有就自己造一个自然、生活化的英文句子。\n' +
            '4. 一次一个，我答完再出下一题；先别报答案。不要给中文选项、选择题或中文提示。\n' +
            '5. 意思对就算过；同一个词在不同句子里中文可能不同，按语境判断，再补充更准确的说法。\n' +
            '6. 你只负责出题、讲解和批改，不要声称已经修改、添加或删除我墨墨里的任何内容。',
        );
      }

      /** 今天到期的词 → 让老师用「英译中默写」带复习。 */
      function startTodayReview() {
        const now = Date.now();
        const due = stateRef.current.words
          .filter((word) => isDueToday(word, now))
          .sort((left, right) => (left.review?.dueAt || 0) - (right.review?.dueAt || 0))
          .slice(0, 30);
        if (due.length === 0) {
          setError('今天没有到期的单词，复习完了就休息一下吧。');
          return;
        }
        const plan = due
          .map((word) => '- ' + word.term + '：' + (isMature(word, now) ? '整句翻译（熟词）' : '只问这个词的意思（生词）'))
          .join('\n');
        setTab('chat');
        setError('');
        send(
          '今天按艾宾浩斯遗忘曲线要复习这些词，请严格按每行后面的模式逐个出题：\n' +
            plan +
            '\n\n规则：\n' +
            '1. 「只问这个词的意思」：先给一个含这个词的英文句子，然后只问我「句子里 X 是什么意思」，让我填这个词的中文；不要让我翻译整句。\n' +
            '2. 「整句翻译」：给一个含这个词的英文句子，让我把整句翻成中文。\n' +
            '3. 一次一个，我答完再出下一题；先别报答案。不要给中文选项、选择题或中文提示。\n' +
            '4. 意思对就算过；同一个词在不同句子里中文可能不同，按语境判断，再补充更准确的说法。',
        );
      }

      function addWords(text) {
        const parsed = parseWordInput(text);
        if (parsed.length === 0) {
          setError('没识别到单词，一行写一个，比如「apple 苹果」。');
          return;
        }
        setState((previous) => {
          const byKey = new Map(previous.words.map((word) => [word.term.toLowerCase(), { ...word }]));
          let added = 0;
          for (const item of parsed) {
            const key = item.term.toLowerCase();
            const existing = byKey.get(key);
            if (existing) {
              if (item.meaning) existing.meaning = item.meaning;
              continue;
            }
            const createdAt = Date.now();
            byKey.set(key, {
              id: 'w-' + createdAt + '-' + added,
              term: item.term,
              meaning: item.meaning,
              phonetic: '',
              pos: '',
              createdAt,
              review: normalizeReview(null, createdAt),
            });
            added += 1;
          }
          return { ...previous, words: [...byKey.values()], updatedAt: Date.now() };
        });
        setAddText('');
        setShowAdd(false);
        setError('');
      }

      function removeWord(id) {
        setState((previous) => ({ ...previous, words: previous.words.filter((word) => word.id !== id), updatedAt: Date.now() }));
      }

      async function send(text) {
        const message = String(text ?? '').trim();
        if (!message || busy) return;
        const history = stateRef.current.chat.slice(-16);
        const words = stateRef.current.words;
        setState((previous) => ({
          ...previous,
          chat: [...previous.chat, { role: 'user', content: message, ts: Date.now() }],
          updatedAt: Date.now(),
        }));
        setDraft('');
        setBusy(true);
        setError('');
        setTab('chat');
        try {
          const data = await postJson('/chat', { message: COACH_RULES + '\n' + message, history, words });
          setState((previous) => ({
            ...previous,
            chat: [...previous.chat, { role: 'assistant', content: String(data.text || ''), ts: Date.now() }],
            updatedAt: Date.now(),
          }));
        } catch (err) {
          setError('模型没回上来：' + (err && err.message ? err.message : String(err)));
        } finally {
          setBusy(false);
        }
      }

      async function makeReading() {
        if (readingBusy) return;
        // 墨墨今日有词就优先用全量今日词；没有才退回本地词表。
        const words =
          mmItems.length > 0
            ? mmItems.map((item) => ({ term: item.spelling, meaning: mmMeanings[String(item.spelling).toLowerCase()]?.text || '' }))
            : stateRef.current.words.map((word) => ({ term: word.term, meaning: meaningOf(word) }));
        if (words.length === 0) {
          setError(mmItems.length > 0 ? '墨墨今天没有单词数据。' : '先添加一些单词，再出阅读理解题。');
          setTab('reading');
          return;
        }
        // 词多时少出几道题，保证短文能把所有词都装进去且不被截断。
        const count = words.length >= 40 ? 3 : 5;
        setTab('reading');
        setReadingBusy(true);
        setError('');
        setAnswers({});
        setShowAll(false);
        try {
          let data;
          try {
            data = await postJson('/make', { words, count, difficulty }, '/dsh-reading/api');
          } catch (err) {
            // 新的出题服务还没加载时，退回旧接口。
            if (err && err.status === 404) data = await postJson('/reading', { words, count, difficulty });
            else throw err;
          }
          // 偶尔输出被截断导致 JSON 解析失败（raw=true）：少出两道题再试一次。
          if (data?.reading?.raw && count > 3) {
            try {
              const retry = await postJson('/make', { words, count: 3, difficulty }, '/dsh-reading/api');
              if (retry?.reading && !retry.reading.raw) data = retry;
            } catch {
              /* 保留第一次的原始文本 */
            }
          }
          setState((previous) => ({ ...previous, reading: data.reading || null, updatedAt: Date.now() }));
        } catch (err) {
          setError('出题失败：' + (err && err.message ? err.message : String(err)));
        } finally {
          setReadingBusy(false);
        }
      }

      function clearChat() {
        if (state.chat.length === 0) return;
        if (typeof window !== 'undefined' && !window.confirm('清空对话记录？单词不会删。')) return;
        setState((previous) => ({ ...previous, chat: [], updatedAt: Date.now() }));
        setError('');
      }

      function pickWord(word) {
        setDraft('讲一下 "' + word.term + '"：意思、词性、常见搭配，再给两个例句和一个记忆方法。');
        setTab('chat');
        setTimeout(() => {
          const el = composerRef.current;
          if (el) {
            el.focus();
            el.setSelectionRange(el.value.length, el.value.length);
          }
        }, 30);
      }

      // ── 渲染片段 ────────────────────────────────────────────────

      const wordCount = state.words.length;
      const reading = state.reading;
      const dueWords = state.words.filter((word) => isDueToday(word));
      const dueNowCount = dueWords.filter((word) => isDueNow(word)).length;
      const reviewedToday = state.words.filter((word) => (word.review?.lastAt || 0) >= startOfDay()).length;
      const listWords = onlyDue ? dueWords : state.words;

      const mmItems = maimemo.items || [];
      const mmReady = maimemo.status === 'ready';
      const mmProgress = maimemo.progress || { finished: 0, total: 0, studyTime: 0 };
      const mmRemaining = maimemo.counts?.remaining ?? mmItems.filter((item) => !item.isFinished).length;
      const mmSticking = maimemo.counts?.sticking ?? mmItems.filter((item) => item.sticking).length;
      const mmMinutes = Math.max(0, Math.round((mmProgress.studyTime || 0) / 60000));

      const readingWords =
        mmItems.length > 0
          ? mmItems.map((item) => ({ term: item.spelling, meaning: mmMeanings[String(item.spelling).toLowerCase()]?.text || '' }))
          : state.words.map((word) => ({ term: word.term, meaning: meaningOf(word) }));
      const readingSourceLabel = mmItems.length > 0 ? '墨墨今日 ' + mmItems.length + ' 词' : '本地词表 ' + state.words.length + ' 词';
      const readingLoading = maimemo.status === 'loading' && mmItems.length === 0;

      const header = h(
        'header',
        { className: 'wb-head' },
        h(
          'div',
          { className: 'wb-head-title' },
          h('h1', null, '背单词'),
          h(
            'span',
            { className: 'wb-sub' },
            maimemo.status === 'ready'
              ? wordCount + ' 个本地词 · 墨墨今日 ' + mmProgress.finished + '/' + (mmProgress.total || mmItems.length)
              : wordCount > 0
                ? wordCount + ' 个单词 · 本地保存'
                : '还没有单词，先添加几个',
          ),
        ),
        h(
          'div',
          { className: 'wb-head-actions' },
          h(
            'button',
            { className: 'wb-btn wb-btn-primary', onClick: makeReading, disabled: readingBusy || readingWords.length === 0 || readingLoading, title: readingLoading ? '正在读取墨墨今日词…' : readingWords.length === 0 ? '先添加单词' : '用' + readingSourceLabel + '出一篇阅读理解' },
            h(SparkIcon, { size: 15 }),
            readingBusy ? '出题中…' : '出阅读理解题',
          ),
          h(
            'button',
            { className: 'wb-btn', onClick: () => setShowAdd((value) => !value), 'aria-expanded': showAdd ? 'true' : 'false' },
            showAdd ? '收起' : '＋ 添加单词',
          ),
        ),
      );

      const addArea = showAdd
        ? h(
            'section',
            { className: 'wb-add' },
            h('textarea', {
              className: 'wb-textarea',
              value: addText,
              onChange: (event) => setAddText(event.target.value),
              placeholder: '一行一个，只写单词也行，释义和音标会自动查：\napple\nlook forward to\nabandon\n\n也可以自己写「apple 苹果」「abandon - 放弃」，重复的会自动合并。',
              rows: 6,
              autoFocus: true,
            }),
            h(
              'div',
              { className: 'wb-add-foot' },
              h('span', { className: 'wb-hint' }, '按行解析；已有单词的释义会被更新'),
              h(
                'div',
                { className: 'wb-add-buttons' },
                h('button', { className: 'wb-btn', onClick: () => { setShowAdd(false); setAddText(''); } }, '取消'),
                h('button', { className: 'wb-btn wb-btn-primary', onClick: () => addWords(addText), disabled: !addText.trim() }, '保存单词'),
              ),
            ),
          )
        : null;

      function renderLocalRow(word, index) {
        const hasMeaning = Boolean(word.meaning || word.pos);
        const shown = Boolean(revealed[word.id]) || !hasMeaning;
        const text = meaningOf(word);
        const toggle = () => setRevealed((previous) => ({ ...previous, [word.id]: !previous[word.id] }));
        return h(
          'div',
          {
            className: 'wb-wrow',
            role: 'listitem',
            key: word.id,
            tabIndex: 0,
            onClick: toggle,
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                toggle();
              }
            },
          },
          h('span', { className: 'wb-wno' }, String(index + 1)),
          h(
            'div',
            { className: 'wb-wbody' },
            h('div', { className: 'wb-wword' }, word.term),
            word.phonetic ? h('div', { className: 'wb-wphon' }, '英 ' + word.phonetic) : null,
            h(
              'div',
              { className: 'wb-wstatus' + (isDueToday(word) ? ' wb-wstatus-due' : '') },
              isDueNow(word) ? '● 现在复习' : dueLabel(word),
            ),
            h(
              'div',
              { className: 'wb-wmean' + (shown ? '' : ' wb-wmean-hidden') },
              shown ? text || (lookingUp ? '查询中…' : '（暂无释义）') : lookingUp ? '查询中…' : '点击显示',
            ),
            shown
              ? h(
                  'div',
                  { className: 'wb-wrate' },
                  h(
                    'button',
                    {
                      className: 'wb-wrate-btn wb-wrate-ok',
                      onClick: (event) => {
                        event.stopPropagation();
                        rateWord(word, true);
                      },
                    },
                    '记住了',
                  ),
                  h(
                    'button',
                    {
                      className: 'wb-wrate-btn wb-wrate-no',
                      onClick: (event) => {
                        event.stopPropagation();
                        rateWord(word, false);
                      },
                    },
                    '忘了',
                  ),
                )
              : null,
          ),
          h(
            'button',
            {
              className: 'wb-wdel',
              onClick: (event) => {
                event.stopPropagation();
                removeWord(word.id);
              },
              title: '删除',
              'aria-label': '删除 ' + word.term,
            },
            '×',
          ),
        );
      }

      function renderMmRow(item, index) {
        const key = String(item.spelling).toLowerCase();
        const revealKey = 'm:' + key;
        const shown = Boolean(revealed[revealKey]);
        const mean = mmMeanings[key];
        const loading = Boolean(mmBusy[key]);
        const tag = item.sticking ? '易忘' : item.isNew ? '新词' : item.wellFamiliar ? '熟知' : '复习';
        const mode = item.mode === 'sentence' ? '整句' : '词义';
        const toggle = () => {
          if (!shown) {
            setRevealed((previous) => ({ ...previous, [revealKey]: true }));
            if (!mean?.checked && !loading) ensureMaimemoMeaning(item.spelling);
            return;
          }
          if (mean?.text) {
            setRevealed((previous) => ({ ...previous, [revealKey]: false }));
            return;
          }
          if (!loading) ensureMaimemoMeaning(item.spelling);
        };
        const meaningText = loading ? '查询中…' : mean?.text || (mean?.checked ? '没查到，点一下重试' : '点击显示');
        return h(
          'div',
          {
            className: 'wb-wrow',
            role: 'listitem',
            key: item.vocId || key,
            tabIndex: 0,
            onClick: toggle,
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                toggle();
              }
            },
          },
          h('span', { className: 'wb-wno' }, String(index + 1)),
          h(
            'div',
            { className: 'wb-wbody' },
            h('div', { className: 'wb-wword' }, item.spelling),
            h(
              'div',
              { className: 'wb-wstatus' + (item.sticking ? ' wb-wstatus-due' : '') },
              tag + ' · 已学 ' + item.studyCount + ' 次 · ' + (item.isFinished ? '今日已学' : '今日未学'),
            ),
            h(
              'div',
              { className: 'wb-wmode' + (mode === '整句' ? ' wb-wmode-sentence' : '') },
              mode,
            ),
            h(
              'div',
              { className: 'wb-wmean' + (shown && mean?.text ? '' : ' wb-wmean-hidden') },
              shown ? meaningText : loading ? '查询中…' : '点击显示',
              shown && mean?.text
                ? h('span', { className: 'wb-msrc' }, mean.source === 'maimemo' ? '墨墨' : 'AI 补')
                : null,
            ),
          ),
        );
      }

      const localTaskCard = h(
        'div',
        { className: 'wb-task' },
        h(
          'div',
          { className: 'wb-task-copy' },
          h('b', null, '本地今日任务'),
          h(
            'span',
            null,
            dueWords.length === 0
              ? '今天没有到期复习'
              : '待复习 ' + dueWords.length + ' 个' + (dueNowCount > 0 ? ' · ' + dueNowCount + ' 个已到期' : ''),
          ),
          h('em', null, '今天已练 ' + reviewedToday + ' 次'),
        ),
        h('button', { className: 'wb-task-go', onClick: startTodayReview, disabled: dueWords.length === 0, title: '用英译中默写复习到期的词' }, '开始'),
      );

      const mmTaskCard = h(
        'div',
        { className: 'wb-task' + (maimemo.status === 'error' ? ' wb-task-error' : '') },
        h(
          'div',
          { className: 'wb-task-copy' },
          h('b', null, maimemo.status === 'error' ? '墨墨读取失败' : '墨墨今日'),
          h(
            'span',
            null,
            maimemo.status === 'error'
              ? maimemo.error
              : !mmReady
                ? '正在读取今日任务…'
                : '已学 ' + mmProgress.finished + ' / ' + (mmProgress.total || mmItems.length) + ' · ' + (mmRemaining > 0 ? '还剩 ' + mmRemaining + ' 个' : '今天已完成'),
          ),
          h('em', null, mmReady ? '学习 ' + mmMinutes + ' 分钟 · 易忘 ' + mmSticking + ' 个' : maimemo.status === 'error' ? '可切到「我的词表」' : '只读，不会改动墨墨'),
        ),
        maimemo.status === 'error'
          ? h('button', { className: 'wb-task-go', onClick: () => loadMaimemo(true) }, '重试')
          : h(
              'button',
              {
                className: 'wb-task-go',
                onClick: startMaimemoReview,
                disabled: !mmReady || mmItems.length === 0,
                title: '按墨墨今日任务出英译中默写',
              },
              mmReady ? (mmRemaining > 0 ? '开始' : '再练') : '…',
            ),
      );

      const sidePanel = h(
        'aside',
        { className: 'wb-side', 'aria-label': '词卷' },
        h(
          'div',
          { className: 'wb-side-head' },
          h('span', { className: 'wb-side-title' }, '词卷', h('em', null, String(source === 'maimemo' ? mmItems.length : onlyDue ? dueWords.length : wordCount))),
          h(
            'div',
            { className: 'wb-side-tools' },
            lookingUp && source === 'local' ? h('span', { className: 'wb-side-status' }, '查释义…') : null,
            source === 'local'
              ? h(
                  'button',
                  {
                    className: 'wb-side-filter' + (onlyDue ? ' wb-side-filter-on' : ''),
                    onClick: () => setOnlyDue((value) => !value),
                    title: onlyDue ? '显示全部单词' : '只看今天该复习的',
                  },
                  '今日 ' + dueWords.length,
                )
              : h(
                  'button',
                  {
                    className: 'wb-side-icon',
                    onClick: () => loadMaimemo(true),
                    title: '刷新墨墨今日',
                    'aria-label': '刷新墨墨今日',
                    disabled: maimemo.status === 'loading',
                  },
                  '↻',
                ),
            h('button', { className: 'wb-side-icon', onClick: () => setSideOpen(false), title: '收起词卷', 'aria-label': '收起词卷' }, '‹'),
          ),
        ),
        h(
          'div',
          { className: 'wb-side-seg' },
          h(
            'button',
            { className: 'wb-side-seg-btn' + (source === 'maimemo' ? ' wb-side-seg-on' : ''), onClick: () => switchSource('maimemo') },
            '墨墨今日',
            mmReady ? h('i', null, String(mmItems.length)) : null,
          ),
          h(
            'button',
            { className: 'wb-side-seg-btn' + (source === 'local' ? ' wb-side-seg-on' : ''), onClick: () => switchSource('local') },
            '我的词表',
            h('i', null, String(wordCount)),
          ),
        ),
        source === 'maimemo' ? mmTaskCard : localTaskCard,
        h(
          'div',
          { className: 'wb-side-list', role: 'list' },
          source === 'maimemo'
            ? mmItems.length === 0
              ? h(
                  'div',
                  { className: 'wb-side-empty' },
                  maimemo.status === 'error'
                    ? '墨墨读取失败\n点右上角 ↻ 重试，或切到「我的词表」'
                    : maimemo.status === 'loading'
                      ? '正在读取墨墨今日…'
                      : '墨墨今天没有单词\n先在 App 里生成今日任务',
                )
              : mmItems.map((item, index) => renderMmRow(item, index))
            : listWords.length === 0
              ? h('div', { className: 'wb-side-empty' }, onlyDue ? '今天没有待复习的词\n点上面的「今日」可看全部' : '还没有单词\n点右上角「添加单词」')
              : listWords.map((word, index) => renderLocalRow(word, index)),
        ),
        h(
          'div',
          { className: 'wb-side-foot' },
          source === 'maimemo'
            ? h(
                'button',
                {
                  className: 'wb-side-action',
                  onClick: startMaimemoReview,
                  disabled: mmItems.length === 0,
                },
                '练墨墨 ' + Math.min(12, mmItems.length) + ' 个',
              )
            : h(
                'button',
                {
                  className: 'wb-side-action',
                  onClick: () => {
                    setTab('chat');
                    send('从词表里随机抽 5 个词考我，每个词先给一个英文句子，然后只问我句子里这个词是什么意思，不要让我整句翻译，不要给选项，一次一题。');
                  },
                },
                '考我 5 个',
              ),
        ),
      );

      const sideRail = sideOpen
        ? null
        : h(
            'button',
            { className: 'wb-side-rail', onClick: () => setSideOpen(true), title: '展开词卷', 'aria-label': '展开词卷' },
            h('span', { className: 'wb-side-rail-label' }, '词 卷'),
            h('span', { className: 'wb-side-rail-count' }, String(wordCount)),
          );

      const tabs = h(
        'div',
        { className: 'wb-tabs', role: 'tablist' },
        h('button', { className: 'wb-tab' + (tab === 'chat' ? ' wb-tab-on' : ''), role: 'tab', 'aria-selected': tab === 'chat' ? 'true' : 'false', onClick: () => setTab('chat') }, '对话讲解'),
        h(
          'button',
          { className: 'wb-tab' + (tab === 'reading' ? ' wb-tab-on' : ''), role: 'tab', 'aria-selected': tab === 'reading' ? 'true' : 'false', onClick: () => setTab('reading') },
          '阅读理解',
          readingBusy ? h('span', { className: 'wb-tab-dot' }) : null,
        ),
        tab === 'chat' && state.chat.length > 0 ? h('button', { className: 'wb-link', onClick: clearChat }, '清空对话') : null,
      );

      const errorBar = error
        ? h('div', { className: 'wb-error', role: 'alert' }, h('span', null, error), h('button', { className: 'wb-link', onClick: () => setError('') }, '知道了'))
        : null;

      let body = null;
      if (tab === 'chat') {
        body = h(
          'div',
          { className: 'wb-chat' },
          h(
            'div',
            { className: 'wb-scroll', ref: scrollRef },
            state.chat.length === 0 && !busy
              ? h(
                  'div',
                  { className: 'wb-empty' },
                  h(BookIcon, { size: 30 }),
                  h('h2', null, '把单词丢进来，剩下的交给老师'),
                  h(
                    'p',
                    null,
                    wordCount > 0
                      ? '词表里的 ' + wordCount + ' 个单词会一起发给模型。可以直接问，也可以点下面的快捷问题。'
                      : '先添加单词，或者直接聊聊怎么开始背。聊天不会自动加词，词表始终由你决定。',
                  ),
                  h(
                    'div',
                    { className: 'wb-quick' },
                    h('button', { className: 'wb-quick-btn', disabled: busy, onClick: () => send('用词表里最近添加的 5 个单词各造一个句子，并翻译。') }, '造句练习'),
                    h('button', { className: 'wb-quick-btn', disabled: busy, onClick: () => send('从词表里挑 5 个词考我，每个词先给一个英文句子，然后只问我句子里这个词是什么意思，不要让我整句翻译，不要给选项，一次一题。') }, '来个小测'),
                    h('button', { className: 'wb-quick-btn', disabled: busy, onClick: () => send('用词表里的单词编一个短小的英文故事，并附中文翻译。') }, '编个故事'),
                  ),
                )
              : state.chat.map((message, index) =>
                  h(
                    'div',
                    { className: 'wb-row wb-row-' + message.role, key: index },
                    h(
                      'div',
                      { className: 'wb-bubble ' + (message.role === 'user' ? 'wb-bubble-user' : 'wb-bubble-ai') },
                      message.role === 'assistant' ? h('div', { className: 'wb-bubble-tag' }, '老师') : null,
                      h('div', { className: 'wb-bubble-text' }, richText(message.content)),
                    ),
                  ),
                ),
            busy
              ? h(
                  'div',
                  { className: 'wb-row wb-row-assistant' },
                  h('div', { className: 'wb-bubble wb-bubble-ai wb-typing' }, h('span', null), h('span', null), h('span', null)),
                )
              : null,
          ),
          h(
            'div',
            { className: 'wb-composer' },
            h('textarea', {
              ref: composerRef,
              className: 'wb-input',
              value: draft,
              rows: 1,
              placeholder: wordCount > 0 ? '问词义、搭配、记忆法，或者让老师考考你…' : '先添加单词，或直接聊聊…',
              onChange: (event) => setDraft(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) {
                  event.preventDefault();
                  send(draft);
                }
              },
            }),
            h(
              'button',
              { className: 'wb-send', onClick: () => send(draft), disabled: busy || !draft.trim(), 'aria-label': '发送' },
              busy ? '…' : '发送',
            ),
          ),
        );
      } else if (readingBusy) {
        body = h(
          'div',
          { className: 'wb-scroll' },
          h('div', { className: 'wb-empty' }, h(SparkIcon, { size: 30 }), h('h2', null, '正在用你的词表写短文…'), h('p', null, '模型要写 180~260 词，还要出 5 道题，通常十几秒。')),
        );
      } else if (!reading) {
        body = h(
          'div',
          { className: 'wb-scroll' },
          h(
            'div',
            { className: 'wb-empty' },
            h(SparkIcon, { size: 30 }),
            h('h2', null, '还没有阅读理解题'),
            h(
              'p',
              null,
              readingWords.length > 0
                ? '会用' + readingSourceLabel + '写一篇短文：词会按要求尽量全部用上，词多时自动少出几道题。'
                : '先添加单词，或在墨墨里生成今日任务，再点「出阅读理解题」。',
            ),
            h(
              'div',
              { className: 'wb-reading-actions' },
              h(
                'label',
                { className: 'wb-difficulty' },
                '难度',
                h(
                  'select',
                  { value: difficulty, onChange: (event) => setDifficulty(event.target.value) },
                  DIFFICULTIES.map((item) => h('option', { value: item, key: item }, item)),
                ),
              ),
              h('button', { className: 'wb-btn wb-btn-primary', onClick: makeReading, disabled: readingWords.length === 0 || readingLoading }, readingLoading ? '等墨墨任务…' : '现在出一篇'),
            ),
          ),
        );
      } else {
        const correctOf = (question) => String(question.answer ?? '').trim().toUpperCase().charAt(0);
        body = h(
          'div',
          { className: 'wb-scroll' },
          h(
            'article',
            { className: 'wb-reading' },
            h(
              'div',
              { className: 'wb-reading-head' },
              h(
                'div',
                null,
                h('h2', null, reading.title || 'Reading Comprehension'),
                h(
                  'p',
                  { className: 'wb-hint' },
                  (reading.words && reading.words.length
                    ? '覆盖单词 ' +
                      reading.words.length +
                      ' 个：' +
                      (reading.words.length > 12 ? reading.words.slice(0, 12).join(' / ') + ' 等' : reading.words.join(' / '))
                    : '') + (reading.createdAt ? ' · ' + new Date(reading.createdAt).toLocaleString() : ''),
                ),
              ),
              h(
                'div',
                { className: 'wb-reading-actions' },
                reading.raw ? null : h('button', { className: 'wb-btn', onClick: () => setShowAll((value) => !value) }, showAll ? '收起答案' : '显示答案'),
                h('button', { className: 'wb-btn', onClick: makeReading, disabled: readingBusy }, '再来一篇'),
              ),
            ),
            reading.raw
              ? h('pre', { className: 'wb-passage wb-passage-raw' }, reading.passage)
              : String(reading.passage)
                  .split(/\n{2,}/)
                  .map((paragraph, index) => h('p', { className: 'wb-passage', key: index }, paragraph)),
            Array.isArray(reading.questions) && reading.questions.length > 0
              ? h(
                  'ol',
                  { className: 'wb-questions' },
                  reading.questions.map((question, qi) => {
                    const correct = correctOf(question);
                    const picked = answers[qi];
                    return h(
                      'li',
                      { className: 'wb-question', key: qi },
                      h('p', { className: 'wb-question-text' }, question.question),
                      h(
                        'div',
                        { className: 'wb-options' },
                        (question.options || []).map((option, oi) => {
                          const letter = String.fromCharCode(65 + oi);
                          const isPicked = picked === letter;
                          const isCorrect = correct === letter;
                          let cls = 'wb-option';
                          if ((showAll || picked) && isCorrect) cls += ' wb-option-correct';
                          else if (isPicked && !isCorrect) cls += ' wb-option-wrong';
                          return h(
                            'button',
                            {
                              className: cls,
                              key: oi,
                              onClick: () => setAnswers((previous) => ({ ...previous, [qi]: letter })),
                            },
                            h('span', { className: 'wb-option-letter' }, letter),
                            h('span', null, String(option).replace(/^[A-Ha-h]\s*[.、)．:：]\s*/, '')),
                          );
                        }),
                      ),
                      picked || showAll
                        ? h(
                            'div',
                            { className: 'wb-explain' },
                            h('b', null, '答案：' + correct),
                            question.explanation ? h('span', null, question.explanation) : null,
                          )
                        : null,
                    );
                  }),
                )
              : null,
            h('p', { className: 'wb-footnote' }, '短文和题目由 AI 生成，可能有个别不严谨的地方；重点看单词在语境里的意思。'),
          ),
        );
      }

      return h(
        'div',
        { className: 'wb-page' },
        h(
          'div',
          { className: 'wb-shell' },
          header,
          addArea,
          h(
            'div',
            { className: 'wb-columns' },
            sideOpen ? sidePanel : null,
            sideRail,
            h('div', { className: 'wb-maincol' }, tabs, errorBar, h('div', { className: 'wb-main' }, body)),
          ),
        ),
      );
    }

    // ── 4. 样式 ───────────────────────────────────────────────────────

    const CSS = `
      .wb-page { height:100%; min-height:0; display:flex; flex-direction:column; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font-size:14px; line-height:1.6; }
      .wb-shell { width:100%; max-width:920px; margin:0 auto; padding:22px clamp(14px,4vw,38px) 0; box-sizing:border-box; display:flex; flex-direction:column; flex:1; min-height:0; }
      .wb-head { flex:none; display:flex; align-items:flex-start; justify-content:space-between; gap:12px; flex-wrap:wrap; }
      .wb-head-title h1 { margin:0; font-size:21px; font-weight:600; line-height:1.3; }
      .wb-sub { color:var(--dsw-alias-label-tertiary); font-size:12px; }
      .wb-head-actions { display:flex; gap:8px; flex-wrap:wrap; }
      .wb-btn { display:inline-flex; align-items:center; gap:6px; border:.5px solid var(--dsw-alias-border-l3); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); border-radius:999px; padding:6px 14px; font:inherit; font-size:13px; line-height:20px; cursor:pointer; transition:background .15s,border-color .15s; }
      .wb-btn:hover:not(:disabled) { background:var(--dsw-alias-bg-layer-2); border-color:var(--dsw-alias-border-l2); }
      .wb-btn:disabled { opacity:.45; cursor:default; }
      .wb-btn-primary { background:var(--dsw-alias-brand-primary); border-color:transparent; color:#fff; }
      .wb-btn-primary:hover:not(:disabled) { background:var(--dsw-alias-brand-primary); filter:brightness(1.06); }
      .wb-link { border:0; background:0 0; color:var(--dsw-alias-label-tertiary); font:inherit; font-size:12px; cursor:pointer; padding:2px 4px; margin-left:auto; }
      .wb-link:hover { color:var(--dsw-alias-label-primary); }
      .wb-hint { color:var(--dsw-alias-label-tertiary); font-size:12px; }
      .wb-add { flex:none; margin-top:14px; border:.5px solid var(--dsw-alias-border-l3); border-radius:14px; padding:12px; background:var(--dsw-alias-bg-layer-1); }
      .wb-textarea { width:100%; box-sizing:border-box; resize:vertical; min-height:110px; max-height:220px; border:.5px solid var(--dsw-alias-border-l3); border-radius:10px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font:inherit; font-size:13px; line-height:1.7; padding:10px 12px; outline:none; }
      .wb-textarea:focus { border-color:var(--dsw-alias-brand-primary); }
      .wb-add-foot { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:8px; flex-wrap:wrap; }
      .wb-add-buttons { display:flex; gap:8px; }
      .wb-wordbar { flex:none; display:flex; flex-wrap:wrap; gap:6px; max-height:104px; overflow:auto; margin-top:14px; padding-bottom:2px; }
      .wb-wordbar-empty { max-height:none; }
      .wb-chip { display:inline-flex; align-items:center; border:.5px solid var(--dsw-alias-border-l3); background:var(--dsw-alias-bg-layer-1); border-radius:10px; max-width:100%; }
      .wb-chip-main { display:inline-flex; align-items:baseline; gap:6px; border:0; background:0 0; color:var(--dsw-alias-label-primary); font:inherit; font-size:13px; padding:4px 2px 4px 10px; cursor:pointer; max-width:230px; }
      .wb-chip-main b { font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .wb-chip-main em { font-style:normal; color:var(--dsw-alias-label-tertiary); font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .wb-chip-x { border:0; background:0 0; color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary)); font-size:15px; line-height:1; padding:4px 8px 4px 4px; cursor:pointer; border-radius:8px; }
      .wb-chip-x:hover { color:var(--dsw-alias-state-error-primary); }
      .wb-tabs { flex:none; display:flex; align-items:center; gap:18px; margin-top:12px; border-bottom:.5px solid var(--dsw-alias-border-l3); }
      .wb-tab { position:relative; border:0; background:0 0; color:var(--dsw-alias-label-tertiary); font:inherit; font-size:13px; font-weight:500; padding:8px 2px 10px; cursor:pointer; display:inline-flex; align-items:center; gap:6px; }
      .wb-tab-on { color:var(--dsw-alias-label-primary); }
      .wb-tab-on:after { content:""; position:absolute; left:0; right:0; bottom:-1px; height:2px; border-radius:2px; background:var(--dsw-alias-brand-primary); }
      .wb-tab-dot { width:6px; height:6px; border-radius:50%; background:var(--dsw-alias-brand-primary); animation:wb-pulse 1s infinite; }
      @keyframes wb-pulse { 0%,100%{opacity:.35} 50%{opacity:1} }
      .wb-error { flex:none; margin-top:10px; display:flex; align-items:center; gap:10px; background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); color:var(--dsw-alias-state-error-primary); border-radius:10px; padding:8px 12px; font-size:12px; }
      .wb-error .wb-link { color:inherit; }
      .wb-main { flex:1; min-height:0; display:flex; flex-direction:column; margin-top:8px; }
      .wb-chat { flex:1; min-height:0; display:flex; flex-direction:column; }
      .wb-scroll { flex:1; min-height:0; overflow:auto; scrollbar-gutter:stable; padding:8px 2px 12px; }
      .wb-empty { max-width:520px; margin:0 auto; text-align:center; color:var(--dsw-alias-label-tertiary); padding:40px 10px; display:flex; flex-direction:column; align-items:center; gap:6px; }
      .wb-empty h2 { margin:6px 0 2px; font-size:16px; font-weight:500; color:var(--dsw-alias-label-secondary); }
      .wb-empty p { margin:0; font-size:13px; line-height:1.7; }
      .wb-quick { display:flex; flex-wrap:wrap; justify-content:center; gap:8px; margin-top:14px; }
      .wb-quick-btn { border:.5px solid var(--dsw-alias-border-l3); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-secondary); border-radius:999px; padding:5px 13px; font:inherit; font-size:12px; cursor:pointer; }
      .wb-quick-btn:hover:not(:disabled) { color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-2); }
      .wb-quick-btn:disabled { opacity:.45; cursor:default; }
      .wb-row { display:flex; margin:10px 0; }
      .wb-row-user { justify-content:flex-end; }
      .wb-row-assistant { justify-content:flex-start; }
      .wb-bubble { max-width:86%; border-radius:14px; padding:9px 13px; font-size:14px; line-height:1.7; overflow-wrap:anywhere; }
      .wb-bubble-user { background:var(--dsw-alias-brand-primary); color:#fff; border-bottom-right-radius:4px; }
      .wb-bubble-ai { background:var(--dsw-alias-bg-layer-1); border:.5px solid var(--dsw-alias-border-l3); border-bottom-left-radius:4px; }
      .wb-bubble-tag { font-size:11px; color:var(--dsw-alias-label-tertiary); margin-bottom:2px; }
      .wb-bubble-text { white-space:pre-wrap; }
      .wb-bubble-text strong { font-weight:600; }
      .wb-bubble-text code { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:.92em; background:color-mix(in srgb, currentColor 10%, transparent); border-radius:4px; padding:1px 4px; }
      .wb-typing { display:flex; gap:5px; align-items:center; min-height:22px; }
      .wb-typing span { width:6px; height:6px; border-radius:50%; background:var(--dsw-alias-label-tertiary); animation:wb-bounce 1.1s infinite; }
      .wb-typing span:nth-child(2) { animation-delay:.15s; }
      .wb-typing span:nth-child(3) { animation-delay:.3s; }
      @keyframes wb-bounce { 0%,60%,100%{transform:translateY(0);opacity:.4} 30%{transform:translateY(-4px);opacity:1} }
      .wb-composer { flex:none; display:flex; align-items:flex-end; gap:8px; padding:10px 0 16px; border-top:.5px solid var(--dsw-alias-border-l3); background:var(--dsw-alias-bg-base); }
      .wb-input { flex:1; min-height:40px; max-height:140px; resize:none; box-sizing:border-box; border:.5px solid var(--dsw-alias-border-l2); border-radius:14px; background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); font:inherit; font-size:14px; line-height:22px; padding:9px 13px; outline:none; }
      .wb-input:focus { border-color:var(--dsw-alias-brand-primary); }
      .wb-send { flex:none; height:40px; min-width:64px; border:0; border-radius:14px; background:var(--dsw-alias-brand-primary); color:#fff; font:inherit; font-size:13px; cursor:pointer; }
      .wb-send:disabled { opacity:.4; cursor:default; }
      .wb-reading { padding-bottom:24px; }
      .wb-reading-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; flex-wrap:wrap; margin:6px 0 14px; }
      .wb-reading-head h2 { margin:0; font-size:18px; font-weight:600; line-height:1.4; }
      .wb-reading-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
      .wb-difficulty { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--dsw-alias-label-tertiary); }
      .wb-difficulty select { border:.5px solid var(--dsw-alias-border-l3); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); border-radius:8px; padding:4px 8px; font:inherit; font-size:12px; }
      .wb-passage { font-family:Georgia,"Times New Roman",serif; font-size:16px; line-height:1.85; margin:0 0 14px; overflow-wrap:anywhere; }
      .wb-passage-raw { white-space:pre-wrap; font-family:inherit; font-size:14px; }
      .wb-questions { margin:22px 0 0; padding:0; list-style:none; display:flex; flex-direction:column; gap:18px; }
      .wb-question { border-top:.5px solid var(--dsw-alias-border-l4); padding-top:16px; }
      .wb-question-text { margin:0 0 10px; font-weight:500; white-space:pre-wrap; }
      .wb-options { display:flex; flex-direction:column; gap:7px; }
      .wb-option { display:flex; align-items:flex-start; gap:9px; text-align:left; width:100%; box-sizing:border-box; border:.5px solid var(--dsw-alias-border-l3); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); border-radius:10px; padding:8px 11px; font:inherit; font-size:13.5px; line-height:1.6; cursor:pointer; }
      .wb-option:hover { background:var(--dsw-alias-bg-layer-2); }
      .wb-option-letter { flex:none; width:20px; height:20px; border-radius:50%; background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2)); display:inline-flex; align-items:center; justify-content:center; font-size:11px; font-weight:600; }
      .wb-option-correct { border-color:var(--dsw-alias-state-success-primary); background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 9%, transparent); }
      .wb-option-wrong { border-color:var(--dsw-alias-state-error-primary); background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 9%, transparent); }
      .wb-explain { margin-top:9px; display:flex; flex-direction:column; gap:2px; font-size:12.5px; color:var(--dsw-alias-label-secondary); background:var(--dsw-alias-bg-layer-1); border-radius:8px; padding:8px 11px; }
      .wb-explain b { color:var(--dsw-alias-label-primary); }
      .wb-footnote { margin:24px 0 0; color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary)); font-size:11.5px; }
      .wb-columns { flex:1; min-height:0; display:flex; gap:12px; margin-top:10px; }
      .wb-side { flex:none; width:clamp(156px,26%,236px); display:flex; flex-direction:column; min-height:0; border:.5px solid var(--dsw-alias-border-l3); border-radius:14px; background:var(--dsw-alias-bg-layer-1); overflow:hidden; }
      .wb-side-head { flex:none; display:flex; align-items:center; justify-content:space-between; gap:6px; padding:7px 8px 7px 11px; border-bottom:.5px solid var(--dsw-alias-border-l3); font-size:12px; color:var(--dsw-alias-label-secondary); }
      .wb-side-title { display:inline-flex; align-items:center; gap:6px; font-weight:500; }
      .wb-side-title em { font-style:normal; font-size:11px; color:var(--dsw-alias-label-tertiary); background:var(--dsw-alias-bg-layer-2); border-radius:999px; padding:0 6px; line-height:16px; }
      .wb-side-tools { display:flex; align-items:center; gap:4px; }
      .wb-side-status { font-size:10px; color:var(--dsw-alias-label-tertiary); white-space:nowrap; }
      .wb-side-icon { border:0; background:0 0; color:var(--dsw-alias-label-tertiary); cursor:pointer; font-size:15px; line-height:1; padding:2px 4px; border-radius:6px; }
      .wb-side-icon:hover { color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-2); }
      .wb-side-seg { flex:none; display:flex; gap:4px; margin:6px 6px 0; padding:3px; border-radius:9px; background:var(--dsw-alias-bg-layer-2); }
      .wb-side-seg-btn { flex:1; display:inline-flex; align-items:center; justify-content:center; gap:4px; border:0; background:0 0; color:var(--dsw-alias-label-tertiary); font:inherit; font-size:10.5px; line-height:18px; padding:2px 4px; border-radius:6px; cursor:pointer; white-space:nowrap; }
      .wb-side-seg-btn i { font-style:normal; font-size:9.5px; opacity:.75; }
      .wb-side-seg-on { background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); box-shadow:0 0 0 .5px var(--dsw-alias-border-l3); }
      .wb-side-filter { border:.5px solid var(--dsw-alias-border-l3); background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-tertiary); border-radius:999px; padding:1px 7px; font:inherit; font-size:10px; line-height:16px; cursor:pointer; white-space:nowrap; }
      .wb-side-filter:hover { color:var(--dsw-alias-label-primary); }
      .wb-side-filter-on { color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); }
      .wb-task { flex:none; display:flex; align-items:center; gap:8px; margin:6px 6px 2px; padding:7px 8px; border-radius:9px; background:var(--dsw-alias-bg-layer-2); }
      .wb-task-copy { flex:1; min-width:0; display:flex; flex-direction:column; gap:1px; }
      .wb-task-copy b { font-size:11.5px; font-weight:600; }
      .wb-task-copy span { font-size:10.5px; color:var(--dsw-alias-label-secondary); line-height:1.4; }
      .wb-task-copy em { font-style:normal; font-size:10px; color:var(--dsw-alias-label-tertiary); }
      .wb-task-go { flex:none; border:0; border-radius:7px; background:var(--dsw-alias-brand-primary); color:#fff; font:inherit; font-size:11px; padding:4px 8px; cursor:pointer; }
      .wb-task-go:disabled { opacity:.4; cursor:default; }
      .wb-side-list { flex:1; min-height:0; overflow:auto; overscroll-behavior:contain; scrollbar-gutter:stable; padding:4px 4px 6px; touch-action:pan-y; -webkit-overflow-scrolling:touch; }
      .wb-side-empty { padding:30px 8px; text-align:center; font-size:12px; line-height:1.6; color:var(--dsw-alias-label-tertiary); white-space:pre-line; }
      .wb-wrow { position:relative; display:flex; gap:7px; padding:8px 5px 9px; border-radius:10px; cursor:pointer; border-bottom:.5px solid var(--dsw-alias-border-l4); }
      .wb-wrow:last-child { border-bottom:0; }
      .wb-wrow:hover { background:var(--dsw-alias-bg-layer-2); }
      .wb-wno { flex:none; width:16px; text-align:center; font-size:10px; color:var(--dsw-alias-label-tertiary); padding-top:2px; font-variant-numeric:tabular-nums; }
      .wb-wbody { flex:1; min-width:0; }
      .wb-wword { font-size:13.5px; font-weight:600; line-height:1.35; overflow-wrap:anywhere; }
      .wb-wphon { font-size:10.5px; line-height:1.4; color:var(--dsw-alias-label-tertiary); margin-top:1px; overflow-wrap:anywhere; }
      .wb-wmean { margin-top:5px; min-height:25px; display:flex; align-items:center; justify-content:center; text-align:center; background:var(--dsw-alias-bg-layer-2); border-radius:6px; padding:3px 5px; font-size:11.5px; line-height:1.5; color:var(--dsw-alias-label-secondary); overflow-wrap:anywhere; }
      .wb-wmean-hidden { color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary)); font-size:11px; }
      .wb-wstatus { margin-top:2px; font-size:9.5px; line-height:1.4; color:var(--dsw-alias-label-tertiary); }
      .wb-wmode { display:inline-block; margin-top:2px; font-size:9px; line-height:14px; padding:0 5px; border-radius:999px; color:var(--dsw-alias-label-secondary); background:var(--dsw-alias-bg-layer-2); }
      .wb-wmode-sentence { color:var(--dsw-alias-brand-primary); }
      .wb-msrc { flex:none; margin-left:5px; font-size:9px; color:var(--dsw-alias-label-tertiary); background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2)); border-radius:999px; padding:0 4px; }
      .wb-task-error .wb-task-copy span { color:var(--dsw-alias-state-error-primary); display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
      .wb-wstatus-due { color:var(--dsw-alias-brand-primary); }
      .wb-wrate { display:flex; gap:4px; margin-top:4px; }
      .wb-wrate-btn { flex:1; border:.5px solid var(--dsw-alias-border-l3); background:var(--dsw-alias-bg-base); border-radius:6px; padding:3px 2px; font:inherit; font-size:10.5px; cursor:pointer; }
      .wb-wrate-ok { color:var(--dsw-alias-state-success-primary); }
      .wb-wrate-ok:hover { background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent); }
      .wb-wrate-no { color:var(--dsw-alias-state-error-primary); }
      .wb-wrate-no:hover { background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
      .wb-wdel { position:absolute; top:3px; right:2px; border:0; background:0 0; color:var(--dsw-alias-label-tertiary); font-size:13px; line-height:1; padding:2px 4px; cursor:pointer; opacity:0; border-radius:4px; }
      .wb-wrow:hover .wb-wdel, .wb-wdel:focus-visible { opacity:1; }
      .wb-wdel:hover { color:var(--dsw-alias-state-error-primary); }
      .wb-side-foot { flex:none; padding:6px; border-top:.5px solid var(--dsw-alias-border-l3); }
      .wb-side-action { width:100%; border:.5px solid var(--dsw-alias-border-l3); background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-secondary); border-radius:8px; padding:5px 6px; font:inherit; font-size:11.5px; cursor:pointer; }
      .wb-side-action:hover { color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-2); }
      .wb-side-rail { flex:none; width:34px; display:flex; flex-direction:column; align-items:center; gap:8px; padding:10px 0; border:.5px solid var(--dsw-alias-border-l3); border-radius:12px; background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-secondary); font:inherit; cursor:pointer; }
      .wb-side-rail:hover { background:var(--dsw-alias-bg-layer-2); }
      .wb-side-rail-label { writing-mode:vertical-rl; font-size:11px; letter-spacing:1px; }
      .wb-side-rail-count { font-size:10px; color:var(--dsw-alias-label-tertiary); }
      .wb-maincol { flex:1; min-width:0; min-height:0; display:flex; flex-direction:column; }
      .wb-maincol .wb-tabs { margin-top:0; }
      @media (max-width:700px) {
        .wb-side { width:clamp(132px,32%,186px); }
        .wb-wmean { font-size:11px; }
      }
      @media (max-width:560px) {
        .wb-shell { padding-top:16px; }
        .wb-columns { gap:8px; }
        .wb-head-title h1 { font-size:19px; }
        .wb-bubble { max-width:92%; }
        .wb-chip-main { max-width:180px; }
        .wb-reading-head { flex-direction:column; }
      }
    `;

    // ── 5. 注册 ───────────────────────────────────────────────────────

    function apply(ctx) {
      ctx.effect(() => {
        const existing = document.getElementById('dsh-wordbook-style');
        if (existing) return () => {};
        const style = document.createElement('style');
        style.id = 'dsh-wordbook-style';
        style.textContent = CSS;
        document.head.append(style);
        return () => {
          style.remove();
        };
      }, 'wordbook: 样式');

      // 左侧栏入口：id 与主面板的 key 必须一致，点图标才会切到本插件。
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              { name: 'sidebar.panellist', id: 'wordbook', order: 20, label: '背单词' },
              SidebarIcon,
            ),
          ),
        'wordbook: 左侧栏入口',
      );

      ctx.effect(
        () =>
          ctx.slots.inject('main', () =>
            ctx.slots.register({ name: 'main', key: 'wordbook' }, WordbookPanel),
          ),
        'wordbook: 主面板',
      );
    }

    return {
      inject: ['slots'],
      apply,
      // 单元测试用的把手（框架不认识这个字段）。
      __internals: {
        parseWordInput,
        normalizeState,
        normalizeWords,
        richText,
        WordbookPanel,
        REVIEW_INTERVALS,
        normalizeReview,
        rateReview,
        isDueToday,
        isMature,
        dueLabel,
      },
    };
  },
});

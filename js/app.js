import * as store from "./store.js";
import { createRecognizer } from "./voice.js";

const view = document.getElementById("view");
const toastEl = document.getElementById("toast");
let user = null;
let settings = null;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (toastEl.hidden = true), 2200);
}

function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}
function fmtDay(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "short" });
}
// メモの種類。news = ニュースから取得したキーワード、idea = 自分で見つけたキーワード
const SOURCES = {
  text:  { icon: "⌨️", name: "メモ" },
  voice: { icon: "🎤", name: "音声メモ" },
  idea:  { icon: "💡", name: "自分のキーワード" },
  news:  { icon: "📰", name: "ニュース" },
  diary: { icon: "📝", name: "一言感想" },
  // メモ帳用の種類（入力画面で選ぶ）
  shopping: { icon: "🛒", name: "買い物" },
  todo:     { icon: "✅", name: "やること" },
  later:    { icon: "🔍", name: "あとで調べる" },
  want:     { icon: "⭐", name: "欲しい" },
  secret:   { icon: "🔒", name: "パスワード等" },
};
// 入力画面で選べる種類（memo = 普通のメモ。音声なら voice になる）
const INPUT_KINDS = ["memo", "shopping", "todo", "later", "want", "secret"];
// 日付の絞り込み
const DATE_FILTERS = {
  all:   "すべての期間",
  today: "今日",
  yday:  "昨日",
  week:  "この1週間",
  month: "この1か月",
  day:   "日付を指定…",
};
// 閲覧画面の絞り込み
const SOURCE_FILTERS = {
  all:   { name: "すべての種類", match: () => true },
  memo:  { name: "⌨️🎤 メモ", match: (s) => s === "text" || s === "voice" },
  idea:  { name: "💡 自分のキーワード", match: (s) => s === "idea" },
  news:  { name: "📰 ニュース", match: (s) => s === "news" },
  diary: { name: "📝 一言感想", match: (s) => s === "diary" },
  notes: { name: "📒 メモ帳（買い物〜パスワード全部）",
           match: (s) => ["shopping", "todo", "later", "want", "secret"].includes(s) },
  shopping: { name: "🛒 買い物", match: (s) => s === "shopping" },
  todo:     { name: "✅ やること", match: (s) => s === "todo" },
  later:    { name: "🔍 あとで調べる", match: (s) => s === "later" },
  want:     { name: "⭐ 欲しい", match: (s) => s === "want" },
  secret:   { name: "🔒 パスワード等", match: (s) => s === "secret" },
};
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

function sourceBadge(source) {
  const s = SOURCES[source] || SOURCES.text;
  // 普通のメモはアイコンだけ、キーワード類は名前も出して見分けやすくする
  return source === "text" || source === "voice"
    ? `<span title="${s.name}">${s.icon}</span>`
    : `<span class="src src-${esc(source)}">${s.icon} ${s.name}</span>`;
}

const SECRET_MASK = "••••••••　<small>（押すと表示・コピー）</small>";
function memoHTML(m) {
  const tags = (m.tags || []).map((t) => `<span class="tag" data-tag="${esc(t)}">${esc(t)}</span>`).join("");
  // パスワード等は伏せて表示し、押すと表示・コピーできる
  const body = m.source === "secret"
    ? `<div class="body secret" data-secret="${esc(m.content)}">${SECRET_MASK}</div>`
    : `<div class="body">${esc(m.content)}</div>`;
  return `<div class="memo">
    <div class="meta">${sourceBadge(m.source)}<span>${fmtTime(m.created_at)}</span>${tags}</div>
    ${body}
  </div>`;
}

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-secret]");
  if (!el) return;
  if (el.classList.toggle("shown")) {
    el.textContent = el.dataset.secret;
    try { await navigator.clipboard.writeText(el.dataset.secret); toast("表示してコピーしました"); } catch {}
  } else {
    el.innerHTML = SECRET_MASK;
  }
});

function groupByDay(list) {
  const groups = new Map();
  for (const m of list) {
    const key = new Date(m.created_at).toDateString();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  return [...groups.values()];
}

// ---------------- 入力画面（メイン） ----------------
async function renderInput() {
  view.innerHTML = `
    <div class="card">
      <div id="kinds" class="chips kinds">${INPUT_KINDS.map((k) => {
        const s = k === "memo" ? { icon: "⌨️", name: "メモ" } : SOURCES[k];
        return `<button class="chip${k === "memo" ? " on" : ""}" data-kind="${k}">${s.icon} ${s.name}</button>`;
      }).join("")}</div>
      <textarea id="memo-text" placeholder="思いついたこと、見聞きしたこと、キーワード…"></textarea>
      <div class="row" style="margin-top:10px">
        <button id="mic" class="mic" title="音声入力">🎤</button>
        <div class="grow hint" id="mic-hint">マイクを押して話すと文字になります。Ctrl+Enter でも保存できます。</div>
        <button id="save" class="primary">追加</button>
      </div>
    </div>
    <div class="card">
      <div class="row">
        <div class="grow day" style="margin:0">💡 今日の話題キーワード</div>
        <button id="news-btn">取得</button>
      </div>
      <p class="hint" id="news-hint">昨日・今日のニュースから話題を10個提案します。気になるものを押すとメモに追加されます。</p>
      <div id="news" class="chips"></div>
    </div>
    <div class="card">
      <div class="day" style="margin-top:0">今日のメモ</div>
      <div id="today"></div>
    </div>`;

  // ---- ニュースキーワード（1日1回取得して端末に保存） ----
  const newsEl = view.querySelector("#news");
  const newsHint = view.querySelector("#news-hint");
  const newsBtn = view.querySelector("#news-btn");
  const newsKey = "mtn.news." + new Date().toDateString();
  const drawNews = (kws) => {
    newsEl.innerHTML = kws.map((k) =>
      `<button class="chip" data-word="${esc(k.word)}" title="${esc(k.note)}">${esc(k.word)}<small>${esc(k.note)}</small></button>`).join("");
  };
  try { const c = JSON.parse(localStorage.getItem(newsKey)); if (c) { drawNews(c); newsBtn.textContent = "更新"; } } catch {}
  newsBtn.onclick = async () => {
    newsBtn.disabled = true;
    newsHint.textContent = "ニュースを読んでいます…";
    try {
      const r = await store.callAI("news", {});
      drawNews(r.keywords);
      try { localStorage.setItem(newsKey, JSON.stringify(r.keywords)); } catch {}
      newsHint.textContent = `${r.count}本の見出しから選びました。押すとメモに追加されます。`;
      newsBtn.textContent = "更新";
    } catch (e) {
      newsHint.textContent = "取得できませんでした: " + e.message;
    } finally { newsBtn.disabled = false; }
  };
  newsEl.onclick = async (e) => {
    const c = e.target.closest("[data-word]");
    if (!c || c.classList.contains("on")) return;
    try {
      await store.addMemo(c.dataset.word, "news");
      c.classList.add("on");
      toast(`「${c.dataset.word}」を追加しました`);
      loadToday();
    } catch (err) { toast("保存に失敗: " + err.message); }
  };

  const ta = view.querySelector("#memo-text");
  const micBtn = view.querySelector("#mic");
  const hint = view.querySelector("#mic-hint");
  const saveBtn = view.querySelector("#save");
  let usedVoice = false;
  let kind = "memo";
  const kindsEl = view.querySelector("#kinds");
  const PLACEHOLDER = {
    memo: "思いついたこと、見聞きしたこと、キーワード…",
    shopping: "買うもの（例：牛乳、単3電池）",
    todo: "やること",
    later: "あとで調べたいこと",
    want: "欲しいもの・気になった商品",
    secret: "パスワードなど（一覧では伏せて表示。AIには送りません）",
  };
  const setKind = (k) => {
    kind = k;
    kindsEl.querySelectorAll("[data-kind]").forEach((b) => b.classList.toggle("on", b.dataset.kind === k));
    ta.placeholder = PLACEHOLDER[k];
  };
  kindsEl.onclick = (e) => { const b = e.target.closest("[data-kind]"); if (b) { setKind(b.dataset.kind); ta.focus(); } };

  const rec = createRecognizer({
    onText: (finalText, interim) => {
      if (finalText) {
        ta.value = (ta.value ? ta.value.replace(/\s*$/, "") + " " : "") + finalText;
        usedVoice = true;
      }
      hint.textContent = interim ? `…${interim}` : "聞き取り中…（もう一度押すと停止）";
    },
    onState: (on) => {
      micBtn.classList.toggle("rec", on);
      if (!on) hint.textContent = "マイクを押して話すと文字になります。";
    },
    onError: (msg) => toast(msg),
  });
  if (!rec) {
    micBtn.disabled = true;
    hint.textContent = "このブラウザは音声入力に未対応です（Chrome / Edge を使ってください）。";
  }
  micBtn.onclick = () => rec && rec.toggle();

  async function save() {
    const text = ta.value.trim();
    if (!text) return;
    saveBtn.disabled = true;
    try {
      rec?.stop();
      const source = kind === "memo" ? (usedVoice ? "voice" : "text") : kind;
      const memo = await store.addMemo(text, source);
      ta.value = "";
      usedVoice = false;
      toast(`${SOURCES[source].icon} 追加しました`);
      setKind("memo");
      loadToday();
      // バックグラウンドでタグ付け（失敗しても無視。パスワード等はAIに送らない）
      if (store.isCloud && settings?.auto_tag && source !== "secret") {
        store.callAI("tag", { memo_id: memo.id }).then(loadToday).catch(() => {});
      }
    } catch (e) {
      toast("保存に失敗しました: " + e.message);
    } finally {
      saveBtn.disabled = false;
      ta.focus();
    }
  }
  saveBtn.onclick = save;
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
  });

  async function loadToday() {
    const el = view.querySelector("#today");
    if (!el) return;
    const all = await store.listMemos({ limit: 200 });
    const today = new Date().toDateString();
    const list = all.filter((m) => new Date(m.created_at).toDateString() === today);
    el.innerHTML = list.length ? list.map(memoHTML).join("") : `<div class="empty">まだありません</div>`;
  }
  loadToday();
  ta.focus();
}

// ---------------- 閲覧画面 ----------------
async function renderList() {
  view.innerHTML = `
    <div class="card">
      <div class="row">
        <input id="q" class="grow" placeholder="キーワードで絞り込み">
        <select id="sort" style="width:auto">
          <option value="date">日付順</option>
          <option value="cat">分類別</option>
          <option value="tag">タグ別</option>
        </select>
      </div>
      <div class="row" style="margin-top:10px">
        <select id="src" class="grow">
          ${Object.entries(SOURCE_FILTERS).map(([v, f]) => `<option value="${v}">${f.name}</option>`).join("")}
        </select>
        <select id="when" style="width:auto">
          ${Object.entries(DATE_FILTERS).map(([v, n]) => `<option value="${v}">${n}</option>`).join("")}
        </select>
      </div>
      <input id="day" type="date" style="margin-top:10px" hidden>
      <div class="row" id="cat-row" style="margin-top:10px" hidden>
        <div class="grow hint" id="cat-hint"></div>
        <button id="recat">分類を更新（AI）</button>
      </div>
      <p class="hint">タグを押すと、同じタグのメモ（似たメモ）に絞り込めます。</p>
    </div>
    <div id="list"></div>`;
  let all = await store.listMemos();
  const q = view.querySelector("#q");
  const sort = view.querySelector("#sort");
  const listEl = view.querySelector("#list");
  const catRow = view.querySelector("#cat-row");
  const catHint = view.querySelector("#cat-hint");
  const recat = view.querySelector("#recat");
  const srcSel = view.querySelector("#src");
  try { sort.value = localStorage.getItem("mtn.sort") || "date"; } catch {}
  try { srcSel.value = localStorage.getItem("mtn.src") || "all"; } catch {}
  srcSel.onchange = () => { try { localStorage.setItem("mtn.src", srcSel.value); } catch {} draw(); };
  const whenSel = view.querySelector("#when");
  const dayIn = view.querySelector("#day");
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  dayIn.value = ymd(new Date());
  whenSel.onchange = () => { dayIn.hidden = whenSel.value !== "day"; draw(); };
  dayIn.onchange = draw;
  // 日付の範囲 [from, to)
  function dateRange() {
    const t0 = startOfDay(new Date()), DAY = 864e5;
    switch (whenSel.value) {
      case "today": return [t0, new Date(+t0 + DAY)];
      case "yday":  return [new Date(+t0 - DAY), t0];
      case "week":  return [new Date(+t0 - 6 * DAY), null];
      case "month": return [new Date(+t0 - 29 * DAY), null];
      case "day": {
        if (!dayIn.value) return [null, null];
        const [y, mo, d] = dayIn.value.split("-").map(Number);
        const f = new Date(y, mo - 1, d);
        return [f, new Date(y, mo - 1, d + 1)];
      }
      default: return [null, null];
    }
  }

  listEl.onclick = (e) => {
    const t = e.target.closest("[data-tag]");
    if (!t) return;
    q.value = t.dataset.tag;
    draw();
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  recat.onclick = async () => {
    recat.disabled = true;
    catHint.textContent = "AI が分類しています…（数十秒かかることがあります）";
    try {
      const r = await store.callAI("categorize", {});
      settings.categories = r.categories;
      all = await store.listMemos();
      toast(`分類しました${r.tagged ? `（${r.tagged}件にタグ付け）` : ""}`);
      draw();
    } catch (e) {
      catHint.textContent = "失敗しました: " + e.message;
    } finally { recat.disabled = false; }
  };

  function groupBy(list, keysOf) {
    const map = new Map();
    for (const m of list) for (const k of keysOf(m)) {
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(m);
    }
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
  }
  const section = (title, ms) =>
    `<div class="day">${title}（${ms.length}件）</div><div class="card">${ms.map(memoHTML).join("")}</div>`;

  function draw() {
    const kw = q.value.trim().toLowerCase();
    const srcMatch = (SOURCE_FILTERS[srcSel.value] || SOURCE_FILTERS.all).match;
    const [from, to] = dateRange();
    const list = all.filter((m) => srcMatch(m.source || "text") &&
      (!from || new Date(m.created_at) >= from) && (!to || new Date(m.created_at) < to) && (!kw ||
      m.content.toLowerCase().includes(kw) || (m.tags || []).some((t) => t.toLowerCase().includes(kw))));
    if (!list.length) { listEl.innerHTML = `<div class="empty">メモがありません</div>`; return; }

    catRow.hidden = sort.value !== "cat";
    if (sort.value === "date") {
      listEl.innerHTML = groupByDay(list).map((g) => section(fmtDay(g[0].created_at), g)).join("");
    } else if (sort.value === "tag") {
      listEl.innerHTML = groupBy(list, (m) => (m.tags?.length ? m.tags : ["未分類"]))
        .map(([t, ms]) => section("#" + esc(t), ms)).join("");
    } else {
      const cats = settings?.categories || {};
      const tagToCat = new Map();
      for (const [c, tags] of Object.entries(cats)) for (const t of tags) tagToCat.set(t, c);
      if (!store.isCloud) catHint.textContent = "分類はクラウド設定後に使えます";
      else if (!tagToCat.size) catHint.textContent = "まだ分類がありません。「分類を更新」を押してください。";
      else catHint.textContent = `${Object.keys(cats).length}個の分類。新しいメモが増えたら更新してください。`;
      listEl.innerHTML = groupBy(list, (m) => {
        const cs = [...new Set((m.tags || []).map((t) => tagToCat.get(t)).filter(Boolean))];
        return cs.length ? cs : ["その他"];
      }).map(([c, ms]) => section(esc(c), ms)).join("");
    }
  }
  q.oninput = draw;
  sort.onchange = () => { try { localStorage.setItem("mtn.sort", sort.value); } catch {} draw(); };
  draw();
}

// ---------------- 編集・削除画面 ----------------
async function renderManage() {
  view.innerHTML = `<p class="hint">メモの修正・削除はここで行います。</p><div id="list"></div>`;
  const listEl = view.querySelector("#list");
  const all = await store.listMemos();
  if (!all.length) { listEl.innerHTML = `<div class="empty">メモがありません</div>`; return; }

  listEl.innerHTML = all.map((m) => `
    <div class="card" data-id="${m.id}">
      <div class="hint">${fmtDay(m.created_at)} ${fmtTime(m.created_at)}</div>
      <textarea class="c" style="min-height:70px">${esc(m.content)}</textarea>
      <label>タグ（カンマ区切り）</label>
      <input class="t" value="${esc((m.tags || []).join(", "))}">
      <label>種類</label>
      <select class="s">${Object.entries(SOURCES).map(([v, s]) =>
        `<option value="${v}" ${v === (m.source || "text") ? "selected" : ""}>${s.icon} ${s.name}</option>`).join("")}</select>
      <div class="row" style="margin-top:10px;justify-content:flex-end">
        <button class="danger del">削除</button>
        <button class="primary upd">保存</button>
      </div>
    </div>`).join("");

  listEl.onclick = async (e) => {
    const card = e.target.closest("[data-id]");
    if (!card) return;
    const id = card.dataset.id;
    try {
      if (e.target.classList.contains("upd")) {
        const content = card.querySelector(".c").value.trim();
        const tags = card.querySelector(".t").value.split(/[,、]/).map((s) => s.trim()).filter(Boolean);
        const source = card.querySelector(".s").value;
        await store.updateMemo(id, { content, tags, source });
        toast("保存しました");
      } else if (e.target.classList.contains("del")) {
        if (!confirm("このメモを削除しますか？")) return;
        await store.deleteMemo(id);
        card.remove();
        toast("削除しました");
      }
    } catch (err) {
      toast("失敗しました: " + err.message);
    }
  };
}

// ---------------- 思い出し画面 ----------------
async function renderRecall() {
  view.innerHTML = `
    <div class="card">
      <div class="row"><div class="grow day" style="margin:0">過去のメモから</div><button id="shuffle">🔀 別のメモ</button></div>
      <div id="past"></div>
    </div>
    <div class="card">
      <div class="day" style="margin-top:0">連想キーワード</div>
      <div class="row">
        <button id="assoc-recent" class="primary">最近1週間から連想</button>
        <button id="assoc-past">上のメモから連想</button>
      </div>
      <p id="theme" class="hint"></p>
      <div id="chips" class="chips"></div>
    </div>
    <div class="card">
      <div class="day" style="margin-top:0">今日の一言感想（日報用）</div>
      <div class="row">
        <input id="kw" class="grow" placeholder="キーワード（上のチップを押すと入ります）">
        <button id="make" class="primary">作る</button>
      </div>
      <div id="result" class="oneliner" hidden></div>
      <div class="row" id="result-actions" style="margin-top:8px;justify-content:flex-end" hidden>
        <button id="copy">コピー</button>
        <button id="save-line" class="primary">メモに保存</button>
      </div>
      <div class="row" style="margin-top:8px">
        <button id="kw-memo">キーワードをメモに追加</button>
      </div>
    </div>`;

  const $ = (s) => view.querySelector(s);
  const all = await store.listMemos();
  const today = new Date().toDateString();
  const past = all.filter((m) => new Date(m.created_at).toDateString() !== today && !["diary", "secret"].includes(m.source));
  let picked = [];

  function shuffle() {
    const pool = past.length ? past : all;
    picked = [...pool].sort(() => Math.random() - 0.5).slice(0, 3);
    $("#past").innerHTML = picked.length
      ? picked.map((m) => memoHTML(m).replace('<div class="meta">', `<div class="meta"><span>${fmtDay(m.created_at)}</span>`)).join("")
      : `<div class="empty">まだメモがありません</div>`;
  }
  shuffle();
  $("#shuffle").onclick = shuffle;

  async function associate(ids) {
    $("#theme").textContent = "連想しています…";
    $("#chips").innerHTML = "";
    try {
      const r = await store.callAI("associate", ids ? { memo_ids: ids } : {});
      $("#theme").textContent = r.theme ? `テーマ：${r.theme}` : (r.keywords.length ? "" : "メモが足りません");
      $("#chips").innerHTML = r.keywords.map((k) => `<button class="chip" data-kw="${esc(k)}">${esc(k)}</button>`).join("");
    } catch (e) {
      $("#theme").textContent = "失敗しました: " + e.message;
    }
  }
  $("#assoc-recent").onclick = () => associate(null);
  $("#assoc-past").onclick = () => picked.length && associate(picked.map((m) => m.id));
  $("#chips").onclick = (e) => {
    const c = e.target.closest("[data-kw]");
    if (!c) return;
    view.querySelectorAll(".chip").forEach((x) => x.classList.toggle("on", x === c));
    $("#kw").value = c.dataset.kw;
  };

  $("#make").onclick = async () => {
    const keyword = $("#kw").value.trim();
    if (!keyword) { toast("キーワードを入れてください"); return; }
    $("#make").disabled = true;
    $("#result").hidden = false;
    $("#result").textContent = "作成中…";
    $("#result-actions").hidden = true;
    try {
      const r = await store.callAI("oneliner", { keyword });
      $("#result").textContent = r.line;
      $("#result-actions").hidden = !r.line;
    } catch (e) {
      $("#result").textContent = "失敗しました: " + e.message;
    } finally { $("#make").disabled = false; }
  };
  $("#copy").onclick = async () => {
    try { await navigator.clipboard.writeText($("#result").textContent); toast("コピーしました"); }
    catch { toast("コピーできませんでした"); }
  };
  $("#save-line").onclick = async () => {
    try { await store.addMemo($("#result").textContent, "diary"); toast("メモに保存しました"); }
    catch (e) { toast("保存に失敗: " + e.message); }
  };
  $("#kw-memo").onclick = async () => {
    const keyword = $("#kw").value.trim();
    if (!keyword) return;
    try { await store.addMemo(keyword, "idea"); toast("キーワードを追加しました"); }
    catch (e) { toast("保存に失敗: " + e.message); }
  };
}

// ---------------- 台本作成画面 ----------------
const LENGTH_LABEL = { "10s": "10秒", "30s": "30秒", "1m": "1分", "5m": "5分", long: "長尺（15分）", custom: "秒数を指定…" };
const lengthLabel = (k) => {
  if (LENGTH_LABEL[k]) return LENGTH_LABEL[k];
  const sec = Number(String(k).replace(/s$/, ""));
  if (!sec) return "";
  return sec >= 60 ? `${Math.floor(sec / 60)}分${sec % 60 ? (sec % 60) + "秒" : ""}` : `${sec}秒`;
};
const STYLE_LABEL = { chat: "雑談トーク", video: "動画シナリオ", short: "ショート動画", duo: "二人の掛け合い" };

async function renderScript() {
  const opts = (o) => Object.entries(o).map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
  view.innerHTML = `
    <div class="card">
      <div class="day" style="margin-top:0">🎬 台本を作る</div>
      <label>キーワード（カンマ区切り。下の候補を押しても入ります）</label>
      <input id="kws" placeholder="例：猫, 雨の日, AI">
      <div id="cands" class="chips" style="margin-top:8px"></div>
      <div class="row" style="margin-top:4px">
        <div class="grow"><label>長さ</label><select id="len">${opts(LENGTH_LABEL)}</select>
          <input id="sec" type="number" min="5" max="3600" step="5" placeholder="秒数（例：45）" style="margin-top:6px" hidden></div>
        <div class="grow"><label>種類</label><select id="style">${opts(STYLE_LABEL)}</select></div>
      </div>
      <label>補足・要望（任意）</label>
      <input id="note" placeholder="例：猫キャラ目線で、明るく">
      <div class="row" style="margin-top:12px;justify-content:flex-end">
        <span class="grow hint" id="gen-hint"></span>
        <button id="gen" class="primary">作成</button>
      </div>
    </div>
    <div id="out"></div>
    <div class="day">これまでの台本</div>
    <div id="history"></div>`;

  const $ = (s) => view.querySelector(s);
  try {
    $("#len").value = localStorage.getItem("mtn.len") || "1m";
    $("#style").value = localStorage.getItem("mtn.style") || "chat";
    $("#sec").value = localStorage.getItem("mtn.sec") || "45";
  } catch {}
  if (!$("#len").value) $("#len").value = "1m";
  const syncSec = () => { $("#sec").hidden = $("#len").value !== "custom"; };
  $("#len").onchange = syncSec;
  syncSec();

  // 候補：最近のキーワードメモ（💡）と、よく使うタグ
  const memos = await store.listMemos({ limit: 300 });
  const ideas = memos.filter((m) => m.source === "idea" || m.source === "news").slice(0, 10).map((m) => m.content);
  const tagCount = new Map();
  for (const m of memos) for (const t of m.tags || []) tagCount.set(t, (tagCount.get(t) || 0) + 1);
  const topTags = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([t]) => t);
  const cands = [...new Set([...ideas, ...topTags])].slice(0, 18);
  $("#cands").innerHTML = cands.map((k) => `<button class="chip" data-kw="${esc(k)}">${esc(k)}</button>`).join("");
  const currentKws = () => $("#kws").value.split(/[,、]/).map((s) => s.trim()).filter(Boolean);
  $("#cands").onclick = (e) => {
    const c = e.target.closest("[data-kw]");
    if (!c) return;
    const list = currentKws();
    const i = list.indexOf(c.dataset.kw);
    if (i >= 0) list.splice(i, 1); else list.push(c.dataset.kw);
    $("#kws").value = list.join(", ");
    c.classList.toggle("on", i < 0);
  };

  const scriptHTML = (s, open) => `
    <details class="card" data-id="${s.id || ""}" ${open ? "open" : ""}>
      <summary>
        <strong>${esc(s.title)}</strong>
        <div class="hint">${lengthLabel(s.length)}・${STYLE_LABEL[s.style] || ""}・${esc((s.keywords || []).join("、"))}${s.created_at ? "・" + fmtDay(s.created_at) : ""}</div>
      </summary>
      <div class="script-body">${esc(s.body)}</div>
      <div class="row" style="margin-top:10px;justify-content:flex-end">
        ${s.id ? `<button class="danger del">削除</button>` : ""}
        <button class="copy">コピー</button>
      </div>
    </details>`;

  async function loadHistory() {
    try {
      const list = await store.listScripts();
      $("#history").innerHTML = list.length ? list.map((s) => scriptHTML(s, false)).join("") : `<div class="empty">まだありません</div>`;
    } catch (e) {
      $("#history").innerHTML = `<div class="empty">読み込めません: ${esc(e.message)}</div>`;
    }
  }
  loadHistory();

  view.onclick = async (e) => {
    const card = e.target.closest("details");
    if (!card) return;
    if (e.target.classList.contains("copy")) {
      const text = card.querySelector("strong").textContent + "\n\n" + card.querySelector(".script-body").textContent;
      try { await navigator.clipboard.writeText(text); toast("コピーしました"); } catch { toast("コピーできませんでした"); }
    } else if (e.target.classList.contains("del")) {
      if (!confirm("この台本を削除しますか？")) return;
      try { await store.deleteScript(card.dataset.id); card.remove(); toast("削除しました"); }
      catch (err) { toast("削除に失敗: " + err.message); }
    }
  };

  $("#gen").onclick = async () => {
    const keywords = currentKws();
    if (!keywords.length) { toast("キーワードを入れてください"); return; }
    let length = $("#len").value;
    const style = $("#style").value;
    try { localStorage.setItem("mtn.len", length); localStorage.setItem("mtn.style", style); } catch {}
    if (length === "custom") {
      const sec = Math.round(Number($("#sec").value));
      if (!(sec >= 5 && sec <= 3600)) { toast("秒数は5〜3600で入れてください"); return; }
      try { localStorage.setItem("mtn.sec", String(sec)); } catch {}
      length = `${sec}s`;
    }
    $("#gen").disabled = true;
    $("#gen-hint").textContent = length === "long" || length === "5m" || parseInt(length) > 120 ? "作成中…（1分ほどかかります）" : "作成中…";
    try {
      const s = await store.callAI("script", { keywords, length, style, note: $("#note").value.trim() });
      $("#out").innerHTML = scriptHTML(s, true);
      $("#gen-hint").textContent = s.warning || "";
      loadHistory();
    } catch (e) {
      $("#gen-hint").textContent = "失敗しました: " + e.message;
    } finally { $("#gen").disabled = false; }
  };
}

// ---------------- 設定画面 ----------------
async function renderSettings() {
  const s = settings;
  const p = s.ai_provider;
  view.innerHTML = `
    <div class="card">
      <div class="day" style="margin-top:0">保存先</div>
      <div>${store.isCloud ? `クラウド（Supabase）: ${esc(user?.email || "")}` : "ローカル（この端末のみ）— js/config.js に Supabase を設定するとクラウド同期になります"}</div>
      ${store.isCloud ? `<button id="logout" style="margin-top:10px">ログアウト</button>` : ""}
    </div>
    <div class="card">
      <div class="day" style="margin-top:0">AI の設定</div>
      <label>使用する AI</label>
      <select id="provider">
        <option value="claude">Claude（Anthropic）</option>
        <option value="gemini">Gemini（Google）</option>
        <option value="openai">OpenAI（GPT / Codex）</option>
      </select>
      <label>軽い処理用モデル（タグ付け・キーワード・一言感想）</label>
      <input id="light">
      <label>重い処理用モデル（台本作成）</label>
      <input id="heavy">
      <label style="display:flex;gap:8px;align-items:center">
        <input id="autotag" type="checkbox" style="width:auto"> メモ追加時に自動でタグ付けする
      </label>
      <p class="hint">APIキーはアプリには保存しません。Supabase の Edge Function の「Secrets」に登録します（README 参照）。</p>
      <button id="save-settings" class="primary">設定を保存</button>
      <button id="test-ai" style="margin-left:8px">AI 接続テスト</button>
    </div>`;

  const prov = view.querySelector("#provider");
  const light = view.querySelector("#light");
  const heavy = view.querySelector("#heavy");
  const auto = view.querySelector("#autotag");
  prov.value = p;
  auto.checked = s.auto_tag;
  const fill = () => {
    const m = s.models[prov.value] || {};
    light.value = m.light || "";
    heavy.value = m.heavy || "";
  };
  fill();
  prov.onchange = fill;
  light.oninput = () => (s.models[prov.value] = { ...s.models[prov.value], light: light.value.trim() });
  heavy.oninput = () => (s.models[prov.value] = { ...s.models[prov.value], heavy: heavy.value.trim() });

  view.querySelector("#save-settings").onclick = async () => {
    s.ai_provider = prov.value;
    s.auto_tag = auto.checked;
    try { await store.saveSettings(s); toast("保存しました"); }
    catch (e) { toast("保存に失敗: " + e.message); }
  };
  view.querySelector("#test-ai").onclick = async () => {
    try {
      const r = await store.callAI("ping", {});
      toast(`OK: ${r.provider} / ${r.model} → ${r.text}`);
    } catch (e) { toast("接続できません: " + e.message); }
  };
  view.querySelector("#logout")?.addEventListener("click", async () => {
    await store.signOut(); location.reload();
  });
}

// ---------------- ログイン画面 ----------------
function renderLogin() {
  view.innerHTML = `
    <div class="card">
      <div class="day" style="margin-top:0">ログイン</div>
      <p>メールアドレスにログイン用リンクを送ります。</p>
      <input id="email" type="email" placeholder="you@example.com" autocomplete="email">
      <button id="send" class="primary" style="margin-top:10px">ログインリンクを送る</button>
      <p id="login-msg" class="hint"></p>
    </div>`;
  const msg = view.querySelector("#login-msg");
  view.querySelector("#send").onclick = async () => {
    const email = view.querySelector("#email").value.trim();
    if (!email) return;
    msg.textContent = "送信中…";
    try {
      await store.signIn(email);
      msg.textContent = "ログイン用のメールを送りました。届いたリンクをこのブラウザで開いてください。";
    } catch (e) {
      const m = e.message || "";
      msg.textContent =
        /signup|not allowed/i.test(m) ? "このメールアドレスは登録されていません。登録済みのアドレスを入力してください。" :
        /rate limit|seconds/i.test(m) ? "送信回数の上限に達しました。しばらく待ってからもう一度お試しください。" :
        "送信に失敗しました: " + m;
    }
  };
}

// ---------------- ルーター ----------------
const routes = {
  "/": renderInput, "/list": renderList, "/recall": renderRecall, "/script": renderScript,
  "/manage": renderManage, "/settings": renderSettings,
};

async function route() {
  if (store.isCloud && !user) { renderLogin(); return; }
  const path = location.hash.replace(/^#/, "") || "/";
  document.querySelectorAll(".tabbar a").forEach((a) => a.classList.toggle("active", a.dataset.route === path));
  try { await (routes[path] || renderInput)(); }
  catch (e) { view.innerHTML = `<div class="card">エラー: ${esc(e.message)}</div>`; }
}

async function start() {
  document.getElementById("mode-badge").textContent = store.isCloud ? "☁️ クラウド" : "💾 ローカル";
  try {
    ({ user } = await store.init());
    if (user) settings = await store.getSettings();
  } catch (e) {
    view.innerHTML = `<div class="card">接続エラー: ${esc(e.message)}</div>`;
    return;
  }
  window.addEventListener("hashchange", route);
  route();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}
start();

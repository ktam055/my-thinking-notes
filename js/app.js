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
const SOURCE_LABEL = { text: "⌨️", voice: "🎤", idea: "💡" };

function memoHTML(m) {
  const tags = (m.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
  return `<div class="memo">
    <div class="meta"><span>${SOURCE_LABEL[m.source] || ""} ${fmtTime(m.created_at)}</span>${tags}</div>
    <div class="body">${esc(m.content)}</div>
  </div>`;
}

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
      <textarea id="memo-text" placeholder="思いついたこと、見聞きしたこと、キーワード…"></textarea>
      <div class="row" style="margin-top:10px">
        <button id="mic" class="mic" title="音声入力">🎤</button>
        <div class="grow hint" id="mic-hint">マイクを押して話すと文字になります。Ctrl+Enter でも保存できます。</div>
        <button id="save" class="primary">追加</button>
      </div>
    </div>
    <div class="card">
      <div class="day" style="margin-top:0">今日のメモ</div>
      <div id="today"></div>
    </div>`;

  const ta = view.querySelector("#memo-text");
  const micBtn = view.querySelector("#mic");
  const hint = view.querySelector("#mic-hint");
  const saveBtn = view.querySelector("#save");
  let usedVoice = false;

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
      const memo = await store.addMemo(text, usedVoice ? "voice" : "text");
      ta.value = "";
      usedVoice = false;
      toast("追加しました");
      loadToday();
      // バックグラウンドでタグ付け（失敗しても無視）
      if (store.isCloud && settings?.auto_tag) {
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
          <option value="tag">タグ別</option>
        </select>
      </div>
    </div>
    <div id="list"></div>`;
  const all = await store.listMemos();
  const q = view.querySelector("#q");
  const sort = view.querySelector("#sort");
  const listEl = view.querySelector("#list");

  function draw() {
    const kw = q.value.trim().toLowerCase();
    const list = kw
      ? all.filter((m) => m.content.toLowerCase().includes(kw) || (m.tags || []).some((t) => t.toLowerCase().includes(kw)))
      : all;
    if (!list.length) { listEl.innerHTML = `<div class="empty">メモがありません</div>`; return; }

    if (sort.value === "date") {
      listEl.innerHTML = groupByDay(list).map((g) =>
        `<div class="day">${fmtDay(g[0].created_at)}（${g.length}件）</div><div class="card">${g.map(memoHTML).join("")}</div>`
      ).join("");
    } else {
      const byTag = new Map();
      for (const m of list) {
        const tags = m.tags?.length ? m.tags : ["未分類"];
        for (const t of tags) {
          if (!byTag.has(t)) byTag.set(t, []);
          byTag.get(t).push(m);
        }
      }
      const entries = [...byTag.entries()].sort((a, b) => b[1].length - a[1].length);
      listEl.innerHTML = entries.map(([t, ms]) =>
        `<div class="day">#${esc(t)}（${ms.length}件）</div><div class="card">${ms.map(memoHTML).join("")}</div>`
      ).join("");
    }
  }
  q.oninput = draw;
  sort.onchange = draw;
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
        await store.updateMemo(id, { content, tags });
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
    </div>`;
  view.querySelector("#send").onclick = async () => {
    const email = view.querySelector("#email").value.trim();
    if (!email) return;
    try { await store.signIn(email); toast("メールを確認してください"); }
    catch (e) { toast("送信に失敗: " + e.message); }
  };
}

// ---------------- ルーター ----------------
const routes = { "/": renderInput, "/list": renderList, "/manage": renderManage, "/settings": renderSettings };

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

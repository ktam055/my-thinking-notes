// データ保存層。Supabase が設定されていればクラウド、なければ localStorage を使う。
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const LOCAL_KEY = "mtn.memos";
const LOCAL_SETTINGS_KEY = "mtn.settings";

export const DEFAULT_SETTINGS = {
  ai_provider: "claude",
  models: {
    claude: { light: "claude-haiku-5-5", heavy: "claude-sonnet-5-5" },
    gemini: { light: "", heavy: "" },
    openai: { light: "", heavy: "" },
  },
  auto_tag: true,
};

let supabase = null;
export const isCloud = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

export async function init() {
  if (!isCloud) return { user: { id: "local" } };
  const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm");
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, detectSessionInUrl: true },
  });
  const { data } = await supabase.auth.getSession();
  return { user: data.session?.user ?? null };
}

export async function signIn(email) {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    // 新規登録は停止しているので、既存ユーザーのログインだけを行う
    options: { emailRedirectTo: location.origin + location.pathname, shouldCreateUser: false },
  });
  if (error) throw error;
}

export async function signOut() {
  if (supabase) await supabase.auth.signOut();
}

// ---------- memos ----------
function readLocal() {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY)) || []; } catch { return []; }
}
function writeLocal(list) {
  localStorage.setItem(LOCAL_KEY, JSON.stringify(list));
}

export async function addMemo(content, source = "text", extra = {}) {
  const memo = { content, source, tags: [], ...extra };
  if (!isCloud) {
    const now = new Date().toISOString();
    const row = { id: crypto.randomUUID(), ...memo, created_at: now, updated_at: now };
    writeLocal([row, ...readLocal()]);
    return row;
  }
  const { data, error } = await supabase.from("memos").insert(memo).select().single();
  if (error) throw error;
  return data;
}

export async function listMemos({ limit = 500 } = {}) {
  if (!isCloud) return readLocal().slice(0, limit);
  const { data, error } = await supabase
    .from("memos").select("*").order("created_at", { ascending: false }).limit(limit);
  if (error) throw error;
  return data;
}

export async function updateMemo(id, patch) {
  if (!isCloud) {
    const list = readLocal().map((m) =>
      m.id === id ? { ...m, ...patch, updated_at: new Date().toISOString() } : m);
    writeLocal(list);
    return;
  }
  const { error } = await supabase.from("memos").update(patch).eq("id", id);
  if (error) throw error;
}

export async function deleteMemo(id, imagePath) {
  if (!isCloud) { writeLocal(readLocal().filter((m) => m.id !== id)); return; }
  const { error } = await supabase.from("memos").delete().eq("id", id);
  if (error) throw error;
  if (imagePath) await supabase.storage.from(IMAGE_BUCKET).remove([imagePath]).catch(() => {});
}

// ---------- 画像 ----------
const IMAGE_BUCKET = "memo-images";
// ローカルモードでは画像を data URL のまま memo に入れる
export async function uploadImage(blob) {
  if (!isCloud) {
    return await new Promise((ok, ng) => {
      const r = new FileReader();
      r.onload = () => ok(r.result); r.onerror = ng; r.readAsDataURL(blob);
    });
  }
  const { data: u } = await supabase.auth.getUser();
  const path = `${u.user.id}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.jpg`;
  const { error } = await supabase.storage.from(IMAGE_BUCKET).upload(path, blob, { contentType: "image/jpeg" });
  if (error) throw error;
  return path;
}
const urlCache = new Map();
export async function imageURL(path) {
  if (!path) return "";
  if (path.startsWith("data:")) return path;
  const hit = urlCache.get(path);
  if (hit && hit.exp > Date.now()) return hit.url;
  const { data, error } = await supabase.storage.from(IMAGE_BUCKET).createSignedUrl(path, 3600);
  if (error) throw error;
  urlCache.set(path, { url: data.signedUrl, exp: Date.now() + 50 * 60e3 });
  return data.signedUrl;
}

// ---------- settings ----------
function mergeSettings(s) {
  return {
    ...DEFAULT_SETTINGS, ...s,
    models: { ...DEFAULT_SETTINGS.models, ...(s?.models || {}) },
  };
}

export async function getSettings() {
  if (!isCloud) {
    try { return mergeSettings(JSON.parse(localStorage.getItem(LOCAL_SETTINGS_KEY))); }
    catch { return mergeSettings(null); }
  }
  const { data } = await supabase.from("settings").select("*").maybeSingle();
  return mergeSettings(data);
}

export async function saveSettings(s) {
  if (!isCloud) { localStorage.setItem(LOCAL_SETTINGS_KEY, JSON.stringify(s)); return; }
  const { data: u } = await supabase.auth.getUser();
  const { error } = await supabase.from("settings")
    .upsert({ user_id: u.user.id, ai_provider: s.ai_provider, models: s.models, auto_tag: s.auto_tag });
  if (error) throw error;
}

// ---------- scripts（台本・クラウドのみ） ----------
export async function listScripts() {
  if (!isCloud) return [];
  const { data, error } = await supabase.from("scripts").select("*").order("created_at", { ascending: false }).limit(50);
  if (error) throw error;
  return data;
}
export async function deleteScript(id) {
  const { error } = await supabase.from("scripts").delete().eq("id", id);
  if (error) throw error;
}

// ---------- AI (Supabase Edge Function "ai") ----------
// クラウドモードでのみ動作。失敗してもメモ保存には影響させない。
export async function callAI(task, payload) {
  if (!isCloud) throw new Error("AI機能はクラウド設定後に使えます");
  const { data, error } = await supabase.functions.invoke("ai", { body: { task, ...payload } });
  if (error) {
    // サーバーが返したエラー文を取り出して表示する
    let msg = error.message;
    try {
      const body = await error.context?.json();
      if (body?.error) msg = body.error;
    } catch { /* 本文なし */ }
    throw new Error(msg);
  }
  return data;
}

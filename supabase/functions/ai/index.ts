// Supabase Edge Function "ai"
// アプリから呼ばれる AI 処理の入口。使う AI（Claude / Gemini / OpenAI）は設定画面で切り替え。
// APIキーは Supabase の Secrets に登録する:
//   ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY（使うものだけでOK）
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import Anthropic from "npm:@anthropic-ai/sdk";

type Provider = "claude" | "gemini" | "openai";
type Tier = "light" | "heavy";

const DEFAULT_MODELS: Record<Provider, Record<Tier, string>> = {
  claude: { light: "claude-haiku-5-5", heavy: "claude-sonnet-5-5" },
  gemini: { light: "", heavy: "" },
  openai: { light: "", heavy: "" },
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// ---------------- 各社 API の呼び出し（ここだけ差し替えれば別の AI に対応できる） ----------------
type Effort = "low" | "medium" | "high";
interface GenImage { mediaType: string; data: string } // data = base64
interface GenArgs { model: string; system: string; prompt: string; maxTokens: number; effort?: Effort; image?: GenImage }

async function callClaude({ model, system, prompt, maxTokens, effort, image }: GenArgs): Promise<string> {
  const client = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });
  const params = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{
      role: "user" as const,
      content: image
        ? [
            { type: "image" as const, source: { type: "base64" as const, media_type: image.mediaType as "image/jpeg", data: image.data } },
            { type: "text" as const, text: prompt },
          ]
        : prompt,
    }],
    // 考える深さ。軽い処理は low で速く・安く
    output_config: { effort: effort ?? "low" },
  };
  // Haiku 以外では、安全判定で断られたときに自動で別モデルへ切り替える fallbacks を使う
  const res = model.startsWith("claude-haiku")
    ? await client.messages.create(params)
    : await client.beta.messages.create({
        ...params,
        betas: ["server-side-fallback-2026-07-01"],
        // @ts-ignore: 新しいパラメータのため型定義が追いついていない場合がある
        fallbacks: "default",
      });
  if (res.stop_reason === "refusal") throw new Error("AI が回答を辞退しました");
  return res.content.filter((b: { type: string }) => b.type === "text")
    .map((b: { type: string; text?: string }) => b.text ?? "").join("");
}

async function callGemini({ model, system, prompt, maxTokens, image }: GenArgs): Promise<string> {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new Error("GEMINI_API_KEY が未設定です");
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [
        ...(image ? [{ inlineData: { mimeType: image.mediaType, data: image.data } }] : []),
        { text: prompt },
      ] }],
      generationConfig: { maxOutputTokens: maxTokens },
    }),
  });
  if (!r.ok) throw new Error(`Gemini error ${r.status}: ${await r.text()}`);
  const d = await r.json();
  return (d.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
}

async function callOpenAI({ model, system, prompt, maxTokens, image }: GenArgs): Promise<string> {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) throw new Error("OPENAI_API_KEY が未設定です");
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      max_completion_tokens: maxTokens,
      messages: [{ role: "system", content: system }, {
        role: "user",
        content: image
          ? [{ type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.data}` } }, { type: "text", text: prompt }]
          : prompt,
      }],
    }),
  });
  if (!r.ok) throw new Error(`OpenAI error ${r.status}: ${await r.text()}`);
  const d = await r.json();
  return d.choices?.[0]?.message?.content ?? "";
}

const PROVIDERS: Record<Provider, (a: GenArgs) => Promise<string>> = {
  claude: callClaude,
  gemini: callGemini,
  openai: callOpenAI,
};

// ---------------- 共通処理 ----------------
function parseJsonArray(text: string): string[] {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    return Array.isArray(arr) ? arr.map(String).map((s) => s.trim()).filter(Boolean) : [];
  } catch { return []; }
}

function parseJsonObject(text: string): Record<string, unknown> {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return {};
  try {
    const o = JSON.parse(m[0]);
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch { return {}; }
}

const strList = (v: unknown, max: number) =>
  (Array.isArray(v) ? v : []).map(String).map((s) => s.trim()).filter(Boolean).slice(0, max);

const todayRangeJST = () => {
  const now = new Date(Date.now() + 9 * 3600e3);
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 9 * 3600e3);
  return start.toISOString();
};

// ---------------- 台本の長さ・種類 ----------------
const LENGTHS = {
  "10s": { label: "10秒", chars: 40, maxTokens: 2000, effort: "low" as Effort },
  "30s": { label: "30秒", chars: 150, maxTokens: 3000, effort: "low" as Effort },
  "1m": { label: "1分", chars: 300, maxTokens: 4000, effort: "low" as Effort },
  "5m": { label: "5分", chars: 1500, maxTokens: 10000, effort: "medium" as Effort },
  "long": { label: "15分程度の長尺", chars: 4500, maxTokens: 20000, effort: "medium" as Effort },
};
// 秒数指定（例 "45s"）。話す速さは1秒あたり約5文字
function lengthOf(key: unknown) {
  const preset = LENGTHS[key as keyof typeof LENGTHS];
  if (preset) return preset;
  const m = String(key ?? "").match(/^(\d{1,4})s$/);
  if (!m) return LENGTHS["1m"];
  const sec = Math.min(Math.max(Number(m[1]), 5), 3600);
  const chars = sec * 5;
  const label = sec >= 60 ? `${Math.floor(sec / 60)}分${sec % 60 ? (sec % 60) + "秒" : ""}` : `${sec}秒`;
  return {
    label, chars,
    maxTokens: Math.min(Math.max(2000, chars * 4), 30000),
    effort: (sec > 120 ? "medium" : "low") as Effort,
  };
}
const STYLES = {
  chat: "一人で話す雑談トークの台本（話し言葉、話題の転換や小ネタを入れる）",
  video: "動画のシナリオ（シーンごとに【映像】と【ナレーション】を書き分ける）",
  short: "ショート動画の台本（冒頭1秒で引きつけ、テンポ重視、最後にひと言オチ）",
  duo: "二人の掛け合い雑談の台本（A: / B: の形式）",
};

// ---------------- ニュース取得（RSS の見出しのみ使用） ----------------
// 1つが取れなくても他で補えるよう複数を使う
const NEWS_FEEDS = [
  "https://www3.nhk.or.jp/rss/news/cat0.xml",
  "https://news.google.com/rss?hl=ja&gl=JP&ceid=JP:ja",
  "https://news.yahoo.co.jp/rss/topics/top-picks.xml",
  "https://news.yahoo.co.jp/rss/topics/domestic.xml",
  "https://news.yahoo.co.jp/rss/topics/it.xml",
  "https://news.yahoo.co.jp/rss/topics/entertainment.xml",
];

const feedErrors: string[] = [];

async function fetchFeed(url: string): Promise<string> {
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; MyThinkingNotes/1.0)", Accept: "application/rss+xml, application/xml, text/xml" },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`${new URL(url).hostname} ${r.status}`);
  return r.text();
}

async function fetchNewsTitles(): Promise<string[]> {
  const since = Date.now() - 48 * 3600e3; // 昨日と今日
  feedErrors.length = 0;
  const results = await Promise.allSettled(NEWS_FEEDS.map(fetchFeed));
  const titles = new Set<string>();
  for (const r of results) {
    if (r.status !== "fulfilled") { feedErrors.push(String((r.reason as Error)?.message ?? r.reason)); continue; }
    for (const item of r.value.match(/<item[\s\S]*?<\/item>/g) ?? []) {
      const t = item.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1];
      const d = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1];
      if (!t) continue;
      if (d && Date.parse(d) < since) continue;
      titles.add(t.replace(/\s+-\s+[^-]+$/, "").replace(/&amp;/g, "&").trim()); // Google の「- 媒体名」を除く
    }
  }
  return [...titles].slice(0, 120);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    // ログイン中のユーザーとしてDBに接続（自分のデータしか触れない）
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "ログインが必要です" }, 401);

    const body = await req.json();
    const { data: s } = await supabase.from("settings").select("*").maybeSingle();
    const provider: Provider = (s?.ai_provider as Provider) || "claude";
    const models = { ...DEFAULT_MODELS[provider], ...(s?.models?.[provider] ?? {}) };
    const generate = (tier: Tier, system: string, prompt: string, maxTokens: number, effort?: Effort, image?: GenImage) => {
      const model = models[tier];
      if (!model) throw new Error(`${provider} の ${tier} モデル名が未設定です（設定画面で入力）`);
      return PROVIDERS[provider]({ model, system, prompt, maxTokens, effort, image }).then((text) => ({ model, text }));
    };

    switch (body.task) {
      case "ping": {
        const { model, text } = await generate("light", "短く答えてください。", "「接続OK」とだけ返してください。", 50);
        return json({ provider, model, text: text.trim() });
      }

      case "tag": {
        const { data: memo } = await supabase.from("memos").select("*").eq("id", body.memo_id).single();
        if (!memo) return json({ error: "メモが見つかりません" }, 404);
        if (memo.source === "secret") return json({ tags: [] });

        // 既存タグを渡して、表記ゆれを減らす
        const { data: recent } = await supabase.from("memos").select("tags")
          .order("created_at", { ascending: false }).limit(300);
        const existing = [...new Set((recent ?? []).flatMap((r: { tags: string[] }) => r.tags))].slice(0, 100);

        const system =
          "あなたは個人メモの分類係です。メモ内容を表す短い日本語タグを1〜3個選びます。" +
          "既存タグに合うものがあれば優先して使い、なければ新しく作ります。" +
          'JSON配列だけを出力してください。例: ["AI","動画制作"]';
        const prompt = `既存タグ: ${JSON.stringify(existing)}\n\nメモ:\n${memo.content}`;
        const { text } = await generate("light", system, prompt, 300);
        const tags = parseJsonArray(text).slice(0, 3);
        if (tags.length) await supabase.from("memos").update({ tags }).eq("id", memo.id);
        return json({ tags });
      }

      // 思い出し：メモから連想キーワードを出す
      case "associate": {
        let q = supabase.from("memos").select("id, content, tags, created_at").neq("source", "secret");
        if (Array.isArray(body.memo_ids) && body.memo_ids.length) q = q.in("id", body.memo_ids);
        else q = q.gte("created_at", new Date(Date.now() - 7 * 86400e3).toISOString());
        const { data: memos } = await q.order("created_at", { ascending: false }).limit(30);
        if (!memos?.length) return json({ theme: "", keywords: [] });

        const system =
          "あなたは発想を広げる相棒です。ユーザーのメモ群を読み、共通するテーマを一言でまとめ、" +
          "そこから連想される日本語キーワードを10個出します。メモに書かれた語をそのまま繰り返すだけでなく、" +
          "少し視点をずらした語も混ぜてください。" +
          '出力はJSONのみ: {"theme":"…","keywords":["…", …]}';
        const prompt = memos.map((m: { content: string }) => `- ${m.content}`).join("\n");
        const { text } = await generate("light", system, prompt, 800);
        const o = parseJsonObject(text);
        return json({ theme: String(o.theme ?? ""), keywords: strList(o.keywords, 10) });
      }

      // 日報の一言感想（1行）
      case "oneliner": {
        const keyword = String(body.keyword ?? "").trim();
        if (!keyword) return json({ error: "キーワードがありません" }, 400);
        const { data: today } = await supabase.from("memos").select("content").neq("source", "secret")
          .gte("created_at", todayRangeJST()).order("created_at").limit(20);
        const system =
          "あなたはユーザー本人の代わりに日報の「今日の感想」を一言で書きます。" +
          "一人称・自然な話し言葉で、40文字前後の1行だけを出力してください。前置きや引用符は不要です。";
        const prompt = `キーワード: ${keyword}\n\n今日のメモ（参考）:\n` +
          ((today ?? []).map((m: { content: string }) => `- ${m.content}`).join("\n") || "（なし）");
        const { text } = await generate("light", system, prompt, 300);
        const line = text.split("\n").map((s) => s.trim()).find(Boolean) ?? "";
        return json({ line: line.replace(/^["「]|["」]$/g, "") });
      }

      // 分類：未タグのメモにタグを付け、タグをカテゴリにまとめて保存
      case "categorize": {
        const { data: untagged } = await supabase.from("memos").select("id, content").neq("source", "secret")
          .eq("tags", "{}").order("created_at", { ascending: false }).limit(30);
        let tagged = 0;
        if (untagged?.length) {
          const system =
            "各メモに内容を表す短い日本語タグを1〜3個付けます。" +
            '出力はJSONのみ: {"<id>":["タグ",…], …}';
          const prompt = untagged.map((m: { id: string; content: string }) => `${m.id}: ${m.content}`).join("\n");
          const { text } = await generate("light", system, prompt, 3000);
          const o = parseJsonObject(text);
          for (const m of untagged) {
            const tags = strList(o[m.id], 3);
            if (tags.length) { await supabase.from("memos").update({ tags }).eq("id", m.id); tagged++; }
          }
        }

        const { data: rows } = await supabase.from("memos").select("tags").limit(2000);
        const count = new Map<string, number>();
        for (const r of rows ?? []) for (const t of r.tags as string[]) count.set(t, (count.get(t) ?? 0) + 1);
        const tags = [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 300).map(([t, n]) => `${t}(${n})`);
        if (!tags.length) return json({ tagged, categories: {} });

        const system =
          "タグの一覧を、意味の近いもの同士で5〜10個のカテゴリにまとめます。カテゴリ名は短い日本語。" +
          "すべてのタグをどれか1つのカテゴリに入れてください。括弧内は件数です（出力には含めない）。" +
          '出力はJSONのみ: {"カテゴリ名":["タグ",…], …}';
        const { text } = await generate("light", system, tags.join(", "), 4000);
        const o = parseJsonObject(text);
        const categories: Record<string, string[]> = {};
        for (const [k, v] of Object.entries(o)) { const l = strList(v, 300); if (l.length) categories[k] = l; }
        await supabase.from("settings").upsert({ user_id: user.id, categories });
        return json({ tagged, categories });
      }

      // アイデア出し：昨日・今日のニュースから話題のキーワード10個
      case "news": {
        const titles = await fetchNewsTitles();
        if (!titles.length) {
          return json({ error: "ニュースを取得できませんでした（" + (feedErrors.join(", ") || "見出し0件") + "）" }, 502);
        }
        const system =
          "ニュースの見出し一覧から、いま話題になっているキーワードを10個選びます。" +
          "同じ話題は1つにまとめ、ジャンルが偏らないようにしてください。各キーワードに15文字以内の短い説明(note)、" +
          "元になった代表的な見出し1つをそのまま(headline)、何が起きたかを見出しから分かる範囲で40〜80文字にまとめた概要(summary)を付けます。" +
          "見出しに無い事実は付け足さないでください。" +
          '出力はJSONのみ: {"keywords":[{"word":"…","note":"…","headline":"…","summary":"…"}, …]}';
        const { text } = await generate("light", system, titles.join("\n"), 4000);
        const o = parseJsonObject(text);
        const keywords = (Array.isArray(o.keywords) ? o.keywords : [])
          .map((k: { word?: unknown; note?: unknown; headline?: unknown; summary?: unknown }) => ({
            word: String(k?.word ?? "").trim(), note: String(k?.note ?? "").trim(),
            headline: String(k?.headline ?? "").trim(), summary: String(k?.summary ?? "").trim(),
          }))
          .filter((k: { word: string }) => k.word).slice(0, 10);
        return json({ keywords, count: titles.length });
      }

      // 台本作成
      case "script": {
        const keywords = strList(body.keywords, 10);
        if (!keywords.length) return json({ error: "キーワードを選んでください" }, 400);
        const len = lengthOf(body.length);
        const style = STYLES[body.style as keyof typeof STYLES] ?? STYLES.chat;
        const system =
          "あなたは YouTube などの動画や配信の構成作家です。ユーザーのキーワードから、" +
          `${style}を書きます。長さは${len.label}（日本語でおよそ${len.chars}文字）。` +
          "1行目に「タイトル：」で始まるタイトルを書き、その後に本文を書きます。" +
          "前置きや「以下が台本です」などの説明は書かないでください。";
        const prompt = `キーワード: ${keywords.join("、")}` + (body.note ? `\n補足・要望: ${String(body.note)}` : "");
        const { model, text } = await generate("heavy", system, prompt, len.maxTokens, len.effort);

        const lines = text.trim().split("\n");
        const m = lines[0]?.match(/^タイトル[：:]\s*(.+)$/);
        const title = m ? m[1].trim() : keywords.join("・");
        const content = (m ? lines.slice(1) : lines).join("\n").trim();
        const { data: saved, error } = await supabase.from("scripts").insert({
          keywords, length: body.length ?? "1m", style: body.style ?? "chat", title, body: content, model,
        }).select().single();
        if (error) return json({ title, body: content, model, warning: "保存できませんでした: " + error.message });
        return json(saved);
      }

      // 画像メモの文字を読み取り、本文とタグに入れる
      case "ocr": {
        const { data: memo } = await supabase.from("memos").select("*").eq("id", body.memo_id).single();
        if (!memo?.image_path) return json({ error: "画像メモが見つかりません" }, 404);
        if (memo.source === "secret") return json({ text: "", tags: [] });
        const { data: file, error: dlErr } = await supabase.storage.from("memo-images").download(memo.image_path);
        if (dlErr || !file) return json({ error: "画像を読み込めません: " + (dlErr?.message ?? "") }, 500);
        const bytes = new Uint8Array(await file.arrayBuffer());
        let bin = "";
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        const image = { mediaType: file.type || "image/jpeg", data: btoa(bin) };

        const system =
          "画像に写っている文字をそのまま書き起こします。改行や並びはできるだけ保ちます。" +
          "文字が無い・読めない画像なら、代わりに何が写っているか（物・場所・状況）を「【写真】」で始めて1〜2文で説明します。" +
          "場所や物の推測ができる場合は「〜のようです」と書きます。" +
          "文字も写っているものも判別できない場合は「【判別不明な画像】」と書き、分かる範囲で色や雰囲気を一言添えます。" +
          "最後の行に「タグ: 」に続けて、内容を表す短いタグを1〜3個、読点区切りで書きます。前置きは書かないでください。";
        const { text } = await generate("light", system, "この画像の文字を書き起こしてください。", 4000, "low", image);
        const lines = text.trim().split("\n");
        const last = lines[lines.length - 1] ?? "";
        const tm = last.match(/^タグ[：:]\s*(.+)$/);
        const tags = tm ? tm[1].split(/[、,，]/).map((t) => t.trim()).filter(Boolean).slice(0, 3) : [];
        const extracted = (tm ? lines.slice(0, -1) : lines).join("\n").trim();

        const typed = String(memo.content ?? "").trim();
        const content = typed ? `${typed}\n\n${extracted}` : (extracted || "【判別不明な画像】");
        await supabase.from("memos").update({
          content, tags: [...new Set([...(memo.tags ?? []), ...tags])],
        }).eq("id", memo.id);
        return json({ text: extracted, tags });
      }

      default:
        return json({ error: `未対応の処理: ${body.task}` }, 400);
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});

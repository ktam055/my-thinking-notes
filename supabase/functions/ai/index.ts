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
interface GenArgs { model: string; system: string; prompt: string; maxTokens: number }

async function callClaude({ model, system, prompt, maxTokens }: GenArgs): Promise<string> {
  const client = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });
  const params = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user" as const, content: prompt }],
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

async function callGemini({ model, system, prompt, maxTokens }: GenArgs): Promise<string> {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new Error("GEMINI_API_KEY が未設定です");
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens },
    }),
  });
  if (!r.ok) throw new Error(`Gemini error ${r.status}: ${await r.text()}`);
  const d = await r.json();
  return (d.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
}

async function callOpenAI({ model, system, prompt, maxTokens }: GenArgs): Promise<string> {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) throw new Error("OPENAI_API_KEY が未設定です");
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      max_completion_tokens: maxTokens,
      messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
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
    const generate = (tier: Tier, system: string, prompt: string, maxTokens: number) => {
      const model = models[tier];
      if (!model) throw new Error(`${provider} の ${tier} モデル名が未設定です（設定画面で入力）`);
      return PROVIDERS[provider]({ model, system, prompt, maxTokens }).then((text) => ({ model, text }));
    };

    switch (body.task) {
      case "ping": {
        const { model, text } = await generate("light", "短く答えてください。", "「接続OK」とだけ返してください。", 50);
        return json({ provider, model, text: text.trim() });
      }

      case "tag": {
        const { data: memo } = await supabase.from("memos").select("*").eq("id", body.memo_id).single();
        if (!memo) return json({ error: "メモが見つかりません" }, 404);

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
        let q = supabase.from("memos").select("id, content, tags, created_at");
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
        const { data: today } = await supabase.from("memos").select("content")
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
        const { data: untagged } = await supabase.from("memos").select("id, content")
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

      default:
        return json({ error: `未対応の処理: ${body.task}` }, 400);
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});

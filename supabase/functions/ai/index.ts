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

      default:
        return json({ error: `未対応の処理: ${body.task}` }, 400);
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});

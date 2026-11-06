# My Thinking Notes

思いついたことを手間なく貯めていく、Windows / Android 両対応のメモアプリ（PWA）。

## できること
- テキスト・音声でメモを追加（メイン画面は追加のみ）、自動タグ付け
- 昨日・今日のニュースから話題キーワードを10個提案、押すとメモに追加
- 日付順・分類別・タグ別で閲覧、タグを押して似たメモに絞り込み
- 思い出し：過去メモ表示、連想キーワード、日報用の一言感想
- 台本作成：10秒 / 1分 / 5分 / 長尺 × 雑談・動画シナリオ・ショート・掛け合い
- 編集・削除は「編集」タブ、AI の切り替え（Claude / Gemini / OpenAI）は「設定」タブ

## ファイル構成
| ファイル | 役割 |
|---|---|
| `index.html`, `css/`, `js/` | アプリ本体（ビルド不要） |
| `js/config.js` | Supabase の接続情報（空ならローカル保存モード） |
| `supabase/schema.sql` | DB のテーブル定義 |
| `supabase/functions/ai/index.ts` | AI 処理（APIキーはここだけで使う） |

## パソコンで試す（ローカルモード）
```
py -m http.server 5173
```
ブラウザで http://localhost:5173 を開く。データはそのブラウザ内だけに保存されます。

## クラウド同期の設定手順

### 1. Supabase（DB）
1. https://supabase.com で無料アカウントを作り、New project を作成（Region は Tokyo）。
2. 左メニュー **SQL Editor** → `supabase/schema.sql` の中身を貼り付けて Run。
3. **Project Settings → API** の `Project URL` と `anon public` キーを `js/config.js` に貼る。
4. **Authentication → URL Configuration** の Site URL / Redirect URLs に、公開先の URL（手順3）を登録。

### 2. Claude API キー
1. https://console.anthropic.com でアカウント作成 → Billing でクレジット購入（$5〜）。上限額も設定しておく。
2. API Keys でキーを発行。
3. Supabase の **Edge Functions → Secrets** に `ANTHROPIC_API_KEY` として登録。

### 3. AI 処理（Edge Function）を配置
Supabase の **Edge Functions → Deploy a new function → Via Editor** で、
関数名 `ai` を作り、`supabase/functions/ai/index.ts` の中身を貼り付けて Deploy。

### 4. 公開（スマホから使うため。HTTPS が必要）
おすすめは GitHub Pages か Cloudflare Pages（どちらも無料）。このフォルダの中身をそのまま公開するだけです。

### 5. スマホ・PC にインストール
公開 URL を Chrome（Android）/ Edge・Chrome（Windows）で開き、メニューの「ホーム画面に追加」/「アプリをインストール」。

## 別の AI に切り替える
1. 使う AI の API キーを Secrets に追加：Gemini は `GEMINI_API_KEY`、OpenAI は `OPENAI_API_KEY`。
2. アプリの「設定」で使用する AI を選び、モデル名を入力して保存。
3. 「AI 接続テスト」で確認。

新しい AI を足すときは `supabase/functions/ai/index.ts` の `PROVIDERS` に呼び出し関数を 1 つ追加します。

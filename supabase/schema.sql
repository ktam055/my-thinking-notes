-- Supabase の SQL Editor に貼り付けて 1 回実行してください。

-- メモ本体
create table if not exists public.memos (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  content     text not null,
  source      text not null default 'text',   -- text / voice / idea
  tags        text[] not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists memos_user_created on public.memos (user_id, created_at desc);
create index if not exists memos_tags on public.memos using gin (tags);

-- 更新日時を自動で更新
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
drop trigger if exists memos_touch on public.memos;
create trigger memos_touch before update on public.memos
  for each row execute function public.touch_updated_at();

-- ユーザー設定（使う AI とモデル名）
create table if not exists public.settings (
  user_id     uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  ai_provider text not null default 'claude',  -- claude / gemini / openai
  models      jsonb not null default '{}'::jsonb,
  auto_tag    boolean not null default true,
  categories  jsonb not null default '{}'::jsonb, -- {"分類名": ["タグ", ...]}
  updated_at  timestamptz not null default now()
);
-- 第2段階で追加（既にテーブルがある場合用）
alter table public.settings add column if not exists categories jsonb not null default '{}'::jsonb;

-- 自分のデータだけ読み書きできるようにする
alter table public.memos    enable row level security;
alter table public.settings enable row level security;

drop policy if exists "own memos" on public.memos;
create policy "own memos" on public.memos
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own settings" on public.settings;
create policy "own settings" on public.settings
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

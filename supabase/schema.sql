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

-- 第3段階：作成した台本
create table if not exists public.scripts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  keywords    text[] not null default '{}',
  length      text not null,   -- 10s / 1m / 5m / long
  style       text not null,   -- chat / video / short / duo
  title       text not null default '',
  body        text not null default '',
  model       text,
  created_at  timestamptz not null default now()
);
create index if not exists scripts_user_created on public.scripts (user_id, created_at desc);
alter table public.scripts enable row level security;
drop policy if exists "own scripts" on public.scripts;
create policy "own scripts" on public.scripts
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ===== 画像メモ（2026-11 追加） =====
alter table public.memos add column if not exists image_path text;
insert into storage.buckets (id, name, public) values ('memo-images', 'memo-images', false)
  on conflict (id) do nothing;
drop policy if exists "own images read" on storage.objects;
drop policy if exists "own images write" on storage.objects;
drop policy if exists "own images delete" on storage.objects;
create policy "own images read" on storage.objects for select
  using (bucket_id = 'memo-images' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own images write" on storage.objects for insert
  with check (bucket_id = 'memo-images' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own images delete" on storage.objects for delete
  using (bucket_id = 'memo-images' and (storage.foldername(name))[1] = auth.uid()::text);
notify pgrst, 'reload schema';

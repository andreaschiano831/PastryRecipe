-- ═══════════════════════════════════════════════════════════════
--  BIBLIOTECA del Ricettario: ebook (EPUB e PDF) da sfogliare nell'app
--  Supabase → SQL Editor → New query → incolla tutto → Run.
--  Si può rieseguire senza perdere dati.
-- ═══════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

-- libri
create table if not exists public.library_books (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  author      text,
  kind        text not null check (kind in ('epub','pdf')),
  file_path   text not null,
  cover_path  text,
  size_bytes  bigint,
  pages       int,
  created_at  timestamptz not null default now()
);

-- dove sono arrivato (uno per libro, condiviso tra i dispositivi)
create table if not exists public.library_progress (
  book_id     uuid primary key references public.library_books(id) on delete cascade,
  location    text,
  percent     real not null default 0,
  settings    jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- segnalibri, evidenziazioni e note
create table if not exists public.library_marks (
  id          uuid primary key default gen_random_uuid(),
  book_id     uuid not null references public.library_books(id) on delete cascade,
  kind        text not null check (kind in ('bookmark','highlight')),
  location    text not null,
  label       text,
  text        text,
  note        text,
  color       text default 'yellow',
  created_at  timestamptz not null default now()
);
create index if not exists library_marks_book_idx on public.library_marks(book_id);

-- L'app usa la stessa chiave pubblica (anon) della tabella ricette
alter table public.library_books    enable row level security;
alter table public.library_progress enable row level security;
alter table public.library_marks    enable row level security;

drop policy if exists lb_all on public.library_books;
drop policy if exists lp_all on public.library_progress;
drop policy if exists lm_all on public.library_marks;
create policy lb_all on public.library_books    for all to anon, authenticated using (true) with check (true);
create policy lp_all on public.library_progress for all to anon, authenticated using (true) with check (true);
create policy lm_all on public.library_marks    for all to anon, authenticated using (true) with check (true);

grant select, insert, update, delete on public.library_books, public.library_progress, public.library_marks to anon, authenticated;

-- archivio dei file (privato: si apre solo dall'app)
insert into storage.buckets (id, name, public, file_size_limit)
values ('library', 'library', false, 52428800)
on conflict (id) do nothing;

drop policy if exists library_read   on storage.objects;
drop policy if exists library_insert on storage.objects;
drop policy if exists library_update on storage.objects;
drop policy if exists library_delete on storage.objects;
create policy library_read   on storage.objects for select to anon, authenticated using (bucket_id = 'library');
create policy library_insert on storage.objects for insert to anon, authenticated with check (bucket_id = 'library');
create policy library_update on storage.objects for update to anon, authenticated using (bucket_id = 'library');
create policy library_delete on storage.objects for delete to anon, authenticated using (bucket_id = 'library');

notify pgrst, 'reload schema';
-- ═══ Fine biblioteca: se vedi questa riga hai copiato tutto ═══

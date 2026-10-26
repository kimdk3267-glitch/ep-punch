-- EP Punch: Supabase schema
-- Supabase 대시보드 > SQL Editor 에 이 파일 전체를 붙여 넣고 Run 하세요. 여러 번 실행해도 안전합니다.

-- ---------------------------------------------------------------
-- 1. 사용자 프로필 (가입 → 관리자 승인)
-- ---------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  name        text not null default '',
  company     text not null default '',
  role        text not null default 'member' check (role in ('member','admin')),
  approved    boolean not null default false,
  created_at  timestamptz not null default now()
);

create or replace function public.is_approved() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select approved from profiles where id = auth.uid()), false);
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'admin' and approved from profiles where id = auth.uid()), false);
$$;

-- 가입 시 프로필 자동 생성. 첫 번째 가입자는 자동으로 승인된 관리자가 됩니다.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare first_user boolean;
begin
  select not exists(select 1 from profiles) into first_user;
  insert into profiles (id, email, name, company, role, approved)
  values (new.id, new.email,
          coalesce(new.raw_user_meta_data->>'name', ''),
          coalesce(new.raw_user_meta_data->>'company', ''),
          case when first_user then 'admin' else 'member' end,
          first_user)
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- 본인이 approved / role 을 바꾸지 못하게 막음 (관리자만 변경)
create or replace function public.guard_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (new.approved is distinct from old.approved or new.role is distinct from old.role)
     and not public.is_admin() then
    raise exception '승인/권한은 관리자만 변경할 수 있습니다';
  end if;
  return new;
end $$;
drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard before update on public.profiles
  for each row execute function public.guard_profile();

alter table public.profiles enable row level security;
drop policy if exists "profiles read" on public.profiles;
create policy "profiles read" on public.profiles for select
  using (id = auth.uid() or public.is_approved());
drop policy if exists "profiles update self" on public.profiles;
create policy "profiles update self" on public.profiles for update
  using (id = auth.uid() or public.is_admin());

-- ---------------------------------------------------------------
-- 2. 시스템
-- ---------------------------------------------------------------
create table if not exists public.systems (
  id         text primary key,
  name       text not null,
  sort       int not null default 0,
  created_at timestamptz not null default now()
);
alter table public.systems enable row level security;
drop policy if exists "systems read" on public.systems;
create policy "systems read" on public.systems for select using (public.is_approved());
drop policy if exists "systems admin write" on public.systems;
create policy "systems admin write" on public.systems for all
  using (public.is_admin()) with check (public.is_admin());

insert into public.systems (id, name, sort) values
  ('EP-01','GT core 11MB',1),
  ('EP-02','Lube/lifting & hydraulic oil 11MBV/MBX',2),
  ('EP-03','Air intake 11MBL',3),
  ('EP-04','Enclosures & diffuser 11MBH/MKH, 11MBR',4),
  ('EP-05','Generator 11MK',5),
  ('EP-06','Gen. terminal, SEE, SFC 11BAA/MKC/MBJ',6),
  ('EP-07','PCC & DC system 11UBA/BTA/BJL',7),
  ('EP-08','T3000 DCS & field I&C 11CYR/CJP',8),
  ('EP-09','Fire protection, E-stop & fire water',9),
  ('EP-10','Fuel gas system (permanent FG line)',10),
  ('EP-11','Power receiving GSUT11/UAT11/GCB11/IPB11/INTEGRA',11),
  ('EP-12','CCW & Fin Fan Cooler (permanent)',12),
  ('EP-13','Bypass stack & dampers (HRSG #11)',13),
  ('EP-14','Permanent utilities: IA/N2, demi, hot water',14)
on conflict (id) do nothing;

-- ---------------------------------------------------------------
-- 3. Punch (잔여작업)
-- ---------------------------------------------------------------
create table if not exists public.punches (
  id            bigint generated always as identity primary key,
  system_id     text not null references public.systems(id) on update cascade,
  seq           int,
  title         text not null,
  description   text not null default '',
  discipline    text not null default '',       -- 원인 공종
  location      text not null default '',       -- 위치 / KKS
  grade         text not null default 'B' check (grade in ('A','B','C')),
  status        text not null default '미착수' check (status in ('미착수','진행 중','완료')),
  progress      int  not null default 0 check (progress between 0 and 100),
  vendor        text not null default '',
  assignee      text not null default '',
  target_date   date,
  forecast_date date,
  done_date     date,
  impact_level  text not null default '없음' check (impact_level in ('없음','낮음','보통','높음')),
  upstream      text[] not null default '{}',   -- 이 작업이 기다리는 선행 공종
  downstream    text[] not null default '{}',   -- 이 작업 때문에 영향받는 후행 공종
  delay_days    int,
  impact_note   text not null default '',
  depends_on    bigint[] not null default '{}', -- 먼저 끝나야 하는 Punch id
  created_by    uuid default auth.uid() references public.profiles(id),
  created_at    timestamptz not null default now(),
  updated_by    uuid references public.profiles(id),
  updated_at    timestamptz not null default now(),
  unique (system_id, seq)
);

create or replace function public.punch_before_write() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.system_id is distinct from old.system_id then
    perform pg_advisory_xact_lock(hashtext(new.system_id));
    select coalesce(max(seq), 0) + 1 into new.seq from punches where system_id = new.system_id;
  end if;
  if tg_op = 'INSERT' then new.created_by := coalesce(new.created_by, auth.uid()); end if;
  new.updated_by := auth.uid();
  new.updated_at := now();
  if new.status = '완료' then
    new.progress := 100;
    new.done_date := coalesce(new.done_date, current_date);
  else
    new.done_date := null;
  end if;
  return new;
end $$;
drop trigger if exists punches_before_write on public.punches;
create trigger punches_before_write before insert or update on public.punches
  for each row execute function public.punch_before_write();

alter table public.punches enable row level security;
drop policy if exists "punches read" on public.punches;
create policy "punches read" on public.punches for select using (public.is_approved());
drop policy if exists "punches insert" on public.punches;
create policy "punches insert" on public.punches for insert with check (public.is_approved());
drop policy if exists "punches update" on public.punches;
create policy "punches update" on public.punches for update using (public.is_approved());
drop policy if exists "punches delete" on public.punches;
create policy "punches delete" on public.punches for delete
  using (public.is_admin() or created_by = auth.uid());

-- ---------------------------------------------------------------
-- 4. 진행 기록 (사진 포함 타임라인)
-- ---------------------------------------------------------------
create table if not exists public.punch_updates (
  id          bigint generated always as identity primary key,
  punch_id    bigint not null references public.punches(id) on delete cascade,
  note        text not null default '',
  status      text check (status in ('미착수','진행 중','완료')),
  progress    int check (progress between 0 and 100),
  created_by  uuid default auth.uid() references public.profiles(id),
  created_at  timestamptz not null default now()
);
alter table public.punch_updates enable row level security;
drop policy if exists "updates read" on public.punch_updates;
create policy "updates read" on public.punch_updates for select using (public.is_approved());
drop policy if exists "updates insert" on public.punch_updates;
create policy "updates insert" on public.punch_updates for insert with check (public.is_approved());
drop policy if exists "updates delete" on public.punch_updates;
create policy "updates delete" on public.punch_updates for delete
  using (public.is_admin() or created_by = auth.uid());

-- ---------------------------------------------------------------
-- 5. 사진
-- ---------------------------------------------------------------
create table if not exists public.photos (
  id          bigint generated always as identity primary key,
  punch_id    bigint not null references public.punches(id) on delete cascade,
  update_id   bigint references public.punch_updates(id) on delete set null,
  path        text not null,
  created_by  uuid default auth.uid() references public.profiles(id),
  created_at  timestamptz not null default now()
);
alter table public.photos enable row level security;
drop policy if exists "photos read" on public.photos;
create policy "photos read" on public.photos for select using (public.is_approved());
drop policy if exists "photos insert" on public.photos;
create policy "photos insert" on public.photos for insert with check (public.is_approved());
drop policy if exists "photos delete" on public.photos;
create policy "photos delete" on public.photos for delete
  using (public.is_admin() or created_by = auth.uid());

insert into storage.buckets (id, name, public)
values ('punch-photos', 'punch-photos', false)
on conflict (id) do nothing;

drop policy if exists "punch photos read" on storage.objects;
create policy "punch photos read" on storage.objects for select
  using (bucket_id = 'punch-photos' and public.is_approved());
drop policy if exists "punch photos upload" on storage.objects;
create policy "punch photos upload" on storage.objects for insert
  with check (bucket_id = 'punch-photos' and public.is_approved());
drop policy if exists "punch photos delete" on storage.objects;
create policy "punch photos delete" on storage.objects for delete
  using (bucket_id = 'punch-photos' and (owner = auth.uid() or public.is_admin()));

-- ---------------------------------------------------------------
-- 6. 실시간 갱신 (다른 사람이 입력하면 화면에 바로 반영)
-- ---------------------------------------------------------------
do $$ begin
  begin alter publication supabase_realtime add table public.punches; exception when others then null; end;
  begin alter publication supabase_realtime add table public.punch_updates; exception when others then null; end;
end $$;

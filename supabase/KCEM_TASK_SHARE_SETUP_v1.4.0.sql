-- ============================================================
-- KCEM Operations - 업무공유 v1.4.0
-- 기존 공용 PIN 세션을 그대로 사용하여 업무공유를 읽고/쓰기합니다.
-- 매출 테이블 및 매출 권한은 변경하지 않습니다.
-- ============================================================

begin;

create extension if not exists pgcrypto;

create table if not exists public.kcem_team_members (
    member_id uuid primary key default gen_random_uuid(),
    member_name text not null,
    is_active boolean not null default true,
    sort_order integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint kcem_team_members_name_not_blank check (length(btrim(member_name)) > 0)
);

create unique index if not exists uq_kcem_team_members_name_ci
    on public.kcem_team_members (lower(btrim(member_name)));

create table if not exists public.kcem_tasks (
    task_id uuid primary key default gen_random_uuid(),
    category text not null default '기타',
    title text not null,
    description text,
    quantity integer,
    requested_by uuid not null references public.kcem_team_members(member_id),
    assigned_to uuid not null references public.kcem_team_members(member_id),
    status text not null default 'REQUESTED',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    completed_at timestamptz,
    deleted_at timestamptz,
    constraint kcem_tasks_title_not_blank check (length(btrim(title)) > 0),
    constraint kcem_tasks_quantity_positive check (quantity is null or quantity > 0),
    constraint kcem_tasks_status_check check (status in ('REQUESTED','IN_PROGRESS','DONE'))
);

create index if not exists idx_kcem_tasks_status on public.kcem_tasks(status) where deleted_at is null;
create index if not exists idx_kcem_tasks_assigned on public.kcem_tasks(assigned_to) where deleted_at is null;
create index if not exists idx_kcem_tasks_created on public.kcem_tasks(created_at desc) where deleted_at is null;

create table if not exists public.kcem_task_history (
    history_id bigint generated always as identity primary key,
    task_id uuid not null references public.kcem_tasks(task_id),
    actor_member_id uuid references public.kcem_team_members(member_id),
    action text not null,
    detail text,
    created_at timestamptz not null default now()
);

create index if not exists idx_kcem_task_history_task on public.kcem_task_history(task_id, created_at desc);

-- 직접 API 접근은 금지하고 아래 SECURITY DEFINER RPC로만 접근
revoke all on table public.kcem_team_members from public, anon, authenticated;
revoke all on table public.kcem_tasks from public, anon, authenticated;
revoke all on table public.kcem_task_history from public, anon, authenticated;

alter table public.kcem_team_members enable row level security;
alter table public.kcem_tasks enable row level security;
alter table public.kcem_task_history enable row level security;

-- 공용 PIN 세션 검증용 내부 함수
create or replace function public.kcem_require_public_session(p_token text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    v_token_hash text;
begin
    if coalesce(p_token, '') = '' then
        raise exception '공용 인증이 필요합니다.';
    end if;

    delete from public.kcem_public_sessions as s
    where s.expires_at <= now();

    v_token_hash := encode(digest(p_token, 'sha256'), 'hex');

    if not exists (
        select 1
        from public.kcem_public_sessions as s
        where s.token_hash = v_token_hash
          and s.expires_at > now()
    ) then
        raise exception '공용 인증이 만료되었습니다. PIN을 다시 입력하세요.';
    end if;

    update public.kcem_public_sessions as s
    set last_used_at = now()
    where s.token_hash = v_token_hash;
end;
$$;

revoke all on function public.kcem_require_public_session(text) from public, anon, authenticated;

-- 팀원 목록
create or replace function public.kcem_tasks_members(
    p_token text,
    p_include_inactive boolean default false
)
returns table(
    member_id uuid,
    member_name text,
    is_active boolean,
    sort_order integer
)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
    perform public.kcem_require_public_session(p_token);

    return query
    select m.member_id, m.member_name, m.is_active, m.sort_order
    from public.kcem_team_members as m
    where p_include_inactive or m.is_active
    order by m.is_active desc, m.sort_order asc, m.created_at asc;
end;
$$;

-- 팀원 추가
create or replace function public.kcem_tasks_member_create(p_token text, p_name text)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    v_name text := btrim(coalesce(p_name,''));
    v_id uuid;
    v_sort integer;
begin
    perform public.kcem_require_public_session(p_token);
    if length(v_name) < 1 or length(v_name) > 40 then
        raise exception '팀원 이름은 1~40자로 입력하세요.';
    end if;
    if exists (select 1 from public.kcem_team_members m where lower(btrim(m.member_name)) = lower(v_name)) then
        raise exception '같은 이름의 팀원이 이미 있습니다.';
    end if;
    select coalesce(max(m.sort_order),0) + 10 into v_sort from public.kcem_team_members m;
    insert into public.kcem_team_members(member_name, sort_order)
    values (v_name, v_sort)
    returning member_id into v_id;
    return v_id;
end;
$$;

-- 팀원 이름 수정
create or replace function public.kcem_tasks_member_rename(p_token text, p_member_id uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_name text := btrim(coalesce(p_name,''));
begin
    perform public.kcem_require_public_session(p_token);
    if length(v_name) < 1 or length(v_name) > 40 then raise exception '팀원 이름을 확인하세요.'; end if;
    if exists (select 1 from public.kcem_team_members m where lower(btrim(m.member_name))=lower(v_name) and m.member_id<>p_member_id) then
        raise exception '같은 이름의 팀원이 이미 있습니다.';
    end if;
    update public.kcem_team_members as m
    set member_name=v_name, updated_at=now()
    where m.member_id=p_member_id;
    if not found then raise exception '팀원을 찾을 수 없습니다.'; end if;
end;
$$;

-- 팀원 삭제(비활성)/복원
create or replace function public.kcem_tasks_member_set_active(p_token text, p_member_id uuid, p_is_active boolean)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_active_count integer;
begin
    perform public.kcem_require_public_session(p_token);
    if not p_is_active then
        select count(*) into v_active_count from public.kcem_team_members m where m.is_active;
        if v_active_count <= 1 and exists (select 1 from public.kcem_team_members m where m.member_id=p_member_id and m.is_active) then
            raise exception '최소 1명의 활성 팀원은 유지해야 합니다.';
        end if;
    end if;
    update public.kcem_team_members as m
    set is_active=p_is_active, updated_at=now()
    where m.member_id=p_member_id;
    if not found then raise exception '팀원을 찾을 수 없습니다.'; end if;
end;
$$;

-- 업무 목록
create or replace function public.kcem_tasks_list(p_token text)
returns table(
    task_id uuid,
    category text,
    title text,
    description text,
    quantity integer,
    requested_by uuid,
    requested_name text,
    assigned_to uuid,
    assigned_name text,
    status text,
    created_at timestamptz,
    updated_at timestamptz,
    completed_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
    perform public.kcem_require_public_session(p_token);
    return query
    select
        t.task_id, t.category, t.title, t.description, t.quantity,
        t.requested_by, rq.member_name,
        t.assigned_to, asg.member_name,
        t.status, t.created_at, t.updated_at, t.completed_at
    from public.kcem_tasks as t
    join public.kcem_team_members as rq on rq.member_id=t.requested_by
    join public.kcem_team_members as asg on asg.member_id=t.assigned_to
    where t.deleted_at is null
    order by
        case t.status when 'IN_PROGRESS' then 1 when 'REQUESTED' then 2 else 3 end,
        t.updated_at desc,
        t.created_at desc;
end;
$$;

-- 업무 등록
create or replace function public.kcem_tasks_create(
    p_token text,
    p_category text,
    p_title text,
    p_description text,
    p_quantity integer,
    p_requested_by uuid,
    p_assigned_to uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    v_id uuid;
    v_title text := btrim(coalesce(p_title,''));
    v_category text := btrim(coalesce(nullif(p_category,''),'기타'));
begin
    perform public.kcem_require_public_session(p_token);
    if length(v_title)<1 or length(v_title)>160 then raise exception '업무 내용을 1~160자로 입력하세요.'; end if;
    if p_quantity is not null and p_quantity<1 then raise exception '수량은 1 이상이어야 합니다.'; end if;
    if not exists(select 1 from public.kcem_team_members m where m.member_id=p_requested_by and m.is_active) then raise exception '현재 작성자를 확인하세요.'; end if;
    if not exists(select 1 from public.kcem_team_members m where m.member_id=p_assigned_to and m.is_active) then raise exception '담당자를 확인하세요.'; end if;

    insert into public.kcem_tasks(category,title,description,quantity,requested_by,assigned_to)
    values(v_category,v_title,nullif(btrim(coalesce(p_description,'')),''),p_quantity,p_requested_by,p_assigned_to)
    returning task_id into v_id;

    insert into public.kcem_task_history(task_id,actor_member_id,action,detail)
    values(v_id,p_requested_by,'CREATE','업무 등록');
    return v_id;
end;
$$;

-- 업무 수정
create or replace function public.kcem_tasks_update(
    p_token text,
    p_task_id uuid,
    p_category text,
    p_title text,
    p_description text,
    p_quantity integer,
    p_requested_by uuid,
    p_assigned_to uuid,
    p_status text,
    p_actor_member_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    v_title text := btrim(coalesce(p_title,''));
    v_status text := upper(btrim(coalesce(p_status,'')));
begin
    perform public.kcem_require_public_session(p_token);
    if length(v_title)<1 or length(v_title)>160 then raise exception '업무 내용을 확인하세요.'; end if;
    if p_quantity is not null and p_quantity<1 then raise exception '수량은 1 이상이어야 합니다.'; end if;
    if v_status not in ('REQUESTED','IN_PROGRESS','DONE') then raise exception '업무 상태가 올바르지 않습니다.'; end if;
    if not exists(select 1 from public.kcem_team_members m where m.member_id=p_actor_member_id and m.is_active) then raise exception '현재 작성자를 확인하세요.'; end if;
    if not exists(select 1 from public.kcem_team_members m where m.member_id=p_requested_by) then raise exception '요청자를 확인하세요.'; end if;
    if not exists(select 1 from public.kcem_team_members m where m.member_id=p_assigned_to) then raise exception '담당자를 확인하세요.'; end if;

    update public.kcem_tasks as t
    set category=btrim(coalesce(nullif(p_category,''),'기타')),
        title=v_title,
        description=nullif(btrim(coalesce(p_description,'')),''),
        quantity=p_quantity,
        requested_by=p_requested_by,
        assigned_to=p_assigned_to,
        status=v_status,
        updated_at=now(),
        completed_at=case when v_status='DONE' then coalesce(t.completed_at,now()) else null end
    where t.task_id=p_task_id and t.deleted_at is null;
    if not found then raise exception '업무를 찾을 수 없습니다.'; end if;

    insert into public.kcem_task_history(task_id,actor_member_id,action,detail)
    values(p_task_id,p_actor_member_id,'EDIT','업무 내용 수정');
end;
$$;

-- 상태 변경
create or replace function public.kcem_tasks_set_status(
    p_token text,
    p_task_id uuid,
    p_status text,
    p_actor_member_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    v_status text := upper(btrim(coalesce(p_status,'')));
    v_old text;
begin
    perform public.kcem_require_public_session(p_token);
    if v_status not in ('REQUESTED','IN_PROGRESS','DONE') then raise exception '업무 상태가 올바르지 않습니다.'; end if;
    if not exists(select 1 from public.kcem_team_members m where m.member_id=p_actor_member_id and m.is_active) then raise exception '현재 작성자를 확인하세요.'; end if;

    select t.status into v_old from public.kcem_tasks t where t.task_id=p_task_id and t.deleted_at is null;
    if v_old is null then raise exception '업무를 찾을 수 없습니다.'; end if;

    update public.kcem_tasks as t
    set status=v_status, updated_at=now(),
        completed_at=case when v_status='DONE' then coalesce(t.completed_at,now()) else null end
    where t.task_id=p_task_id and t.deleted_at is null;

    insert into public.kcem_task_history(task_id,actor_member_id,action,detail)
    values(p_task_id,p_actor_member_id,'STATUS',v_old || ' -> ' || v_status);
end;
$$;

-- 업무 삭제: 실제 행 삭제가 아니라 숨김 처리
create or replace function public.kcem_tasks_delete(
    p_token text,
    p_task_id uuid,
    p_actor_member_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
    perform public.kcem_require_public_session(p_token);
    if not exists(select 1 from public.kcem_team_members m where m.member_id=p_actor_member_id and m.is_active) then raise exception '현재 작성자를 확인하세요.'; end if;

    update public.kcem_tasks as t
    set deleted_at=now(), updated_at=now()
    where t.task_id=p_task_id and t.deleted_at is null;
    if not found then raise exception '업무를 찾을 수 없습니다.'; end if;

    insert into public.kcem_task_history(task_id,actor_member_id,action,detail)
    values(p_task_id,p_actor_member_id,'DELETE','업무 삭제(숨김)');
end;
$$;

-- 실행 권한: 공용 PIN 세션을 가진 브라우저만 함수 내부 검증을 통과함
revoke all on function public.kcem_tasks_members(text,boolean) from public;
revoke all on function public.kcem_tasks_member_create(text,text) from public;
revoke all on function public.kcem_tasks_member_rename(text,uuid,text) from public;
revoke all on function public.kcem_tasks_member_set_active(text,uuid,boolean) from public;
revoke all on function public.kcem_tasks_list(text) from public;
revoke all on function public.kcem_tasks_create(text,text,text,text,integer,uuid,uuid) from public;
revoke all on function public.kcem_tasks_update(text,uuid,text,text,text,integer,uuid,uuid,text,uuid) from public;
revoke all on function public.kcem_tasks_set_status(text,uuid,text,uuid) from public;
revoke all on function public.kcem_tasks_delete(text,uuid,uuid) from public;

grant execute on function public.kcem_tasks_members(text,boolean) to anon, authenticated;
grant execute on function public.kcem_tasks_member_create(text,text) to anon, authenticated;
grant execute on function public.kcem_tasks_member_rename(text,uuid,text) to anon, authenticated;
grant execute on function public.kcem_tasks_member_set_active(text,uuid,boolean) to anon, authenticated;
grant execute on function public.kcem_tasks_list(text) to anon, authenticated;
grant execute on function public.kcem_tasks_create(text,text,text,text,integer,uuid,uuid) to anon, authenticated;
grant execute on function public.kcem_tasks_update(text,uuid,text,text,text,integer,uuid,uuid,text,uuid) to anon, authenticated;
grant execute on function public.kcem_tasks_set_status(text,uuid,text,uuid) to anon, authenticated;
grant execute on function public.kcem_tasks_delete(text,uuid,uuid) to anon, authenticated;

notify pgrst, 'reload schema';
commit;

-- 확인
select 'kcem_team_members' as table_name, count(*) as rows from public.kcem_team_members
union all
select 'kcem_tasks', count(*) from public.kcem_tasks where deleted_at is null;

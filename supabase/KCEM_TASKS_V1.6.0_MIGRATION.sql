-- ============================================================
-- 한국공예체험박물관 EUM
-- 업무공유 v1.6.0 마이그레이션
--
-- 기존 v1.4.0 업무 테이블을 유지하면서
-- 자연어 구조화 / 완료요청일 / 태그 / 승인흐름을 추가합니다.
-- ============================================================

begin;

alter table public.kcem_tasks
    add column if not exists raw_text text,
    add column if not exists color text,
    add column if not exists tags text[] not null default '{}'::text[],
    add column if not exists quantity_condition text not null default 'EXACT',
    add column if not exists due_date date,
    add column if not exists started_at timestamptz,
    add column if not exists approved_at timestamptz;

alter table public.kcem_tasks
    drop constraint if exists kcem_tasks_status_check;

alter table public.kcem_tasks
    add constraint kcem_tasks_status_check
    check (status in ('REQUESTED','IN_PROGRESS','DONE','APPROVED'));

alter table public.kcem_tasks
    drop constraint if exists kcem_tasks_quantity_condition_check;

alter table public.kcem_tasks
    add constraint kcem_tasks_quantity_condition_check
    check (quantity_condition in ('EXACT','AT_LEAST','AT_MOST'));

create index if not exists idx_kcem_tasks_due_date
    on public.kcem_tasks(due_date)
    where deleted_at is null;

create index if not exists idx_kcem_tasks_approved
    on public.kcem_tasks(approved_at desc)
    where deleted_at is null and approved_at is not null;

create index if not exists idx_kcem_tasks_tags
    on public.kcem_tasks using gin(tags);

-- ------------------------------------------------------------
-- V2 목록
-- ------------------------------------------------------------
create or replace function public.kcem_tasks_list_v2(p_token text)
returns table(
    task_id uuid,
    category text,
    title text,
    raw_text text,
    description text,
    color text,
    tags text[],
    quantity integer,
    quantity_condition text,
    due_date date,
    requested_by uuid,
    requested_name text,
    assigned_to uuid,
    assigned_name text,
    status text,
    created_at timestamptz,
    updated_at timestamptz,
    started_at timestamptz,
    completed_at timestamptz,
    approved_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
    perform public.kcem_require_public_session(p_token);

    return query
    select
        t.task_id,
        t.category,
        t.title,
        t.raw_text,
        t.description,
        t.color,
        coalesce(t.tags, '{}'::text[]),
        t.quantity,
        t.quantity_condition,
        t.due_date,
        t.requested_by,
        rq.member_name,
        t.assigned_to,
        asg.member_name,
        t.status,
        t.created_at,
        t.updated_at,
        t.started_at,
        t.completed_at,
        t.approved_at
    from public.kcem_tasks as t
    join public.kcem_team_members as rq
      on rq.member_id = t.requested_by
    join public.kcem_team_members as asg
      on asg.member_id = t.assigned_to
    where t.deleted_at is null
    order by t.updated_at desc, t.created_at desc;
end;
$$;

-- ------------------------------------------------------------
-- V2 등록
-- 작성자 개념은 UI에서 사용하지 않으므로
-- 기존 DB 호환을 위해 requested_by = assigned_to 로 기록합니다.
-- ------------------------------------------------------------
create or replace function public.kcem_tasks_create_v2(
    p_token text,
    p_category text,
    p_title text,
    p_raw_text text,
    p_description text,
    p_color text,
    p_tags text[],
    p_quantity integer,
    p_quantity_condition text,
    p_due_date date,
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
    v_condition text := upper(btrim(coalesce(nullif(p_quantity_condition,''),'EXACT')));
begin
    perform public.kcem_require_public_session(p_token);

    if length(v_title) < 1 or length(v_title) > 160 then
        raise exception '업무 이름을 1~160자로 입력하세요.';
    end if;

    if p_quantity is not null and p_quantity < 1 then
        raise exception '수량은 1 이상이어야 합니다.';
    end if;

    if v_condition not in ('EXACT','AT_LEAST','AT_MOST') then
        raise exception '수량 조건을 확인하세요.';
    end if;

    if not exists (
        select 1
        from public.kcem_team_members m
        where m.member_id = p_assigned_to
          and m.is_active
    ) then
        raise exception '담당자를 확인하세요.';
    end if;

    insert into public.kcem_tasks(
        category,
        title,
        raw_text,
        description,
        color,
        tags,
        quantity,
        quantity_condition,
        due_date,
        requested_by,
        assigned_to,
        status
    )
    values(
        v_category,
        v_title,
        nullif(btrim(coalesce(p_raw_text,'')),''),
        nullif(btrim(coalesce(p_description,'')),''),
        nullif(btrim(coalesce(p_color,'')),''),
        coalesce(p_tags, '{}'::text[]),
        p_quantity,
        v_condition,
        p_due_date,
        p_assigned_to,
        p_assigned_to,
        'REQUESTED'
    )
    returning task_id into v_id;

    insert into public.kcem_task_history(
        task_id,
        actor_member_id,
        action,
        detail
    )
    values(
        v_id,
        p_assigned_to,
        'CREATE_V2',
        '업무 요청 등록'
    );

    return v_id;
end;
$$;

-- ------------------------------------------------------------
-- V2 속성 수정
-- ------------------------------------------------------------
create or replace function public.kcem_tasks_update_v2(
    p_token text,
    p_task_id uuid,
    p_category text,
    p_title text,
    p_description text,
    p_color text,
    p_tags text[],
    p_quantity integer,
    p_quantity_condition text,
    p_due_date date,
    p_assigned_to uuid,
    p_actor_member_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    v_title text := btrim(coalesce(p_title,''));
    v_category text := btrim(coalesce(nullif(p_category,''),'기타'));
    v_condition text := upper(btrim(coalesce(nullif(p_quantity_condition,''),'EXACT')));
begin
    perform public.kcem_require_public_session(p_token);

    if length(v_title) < 1 or length(v_title) > 160 then
        raise exception '업무 이름을 확인하세요.';
    end if;

    if p_quantity is not null and p_quantity < 1 then
        raise exception '수량은 1 이상이어야 합니다.';
    end if;

    if v_condition not in ('EXACT','AT_LEAST','AT_MOST') then
        raise exception '수량 조건을 확인하세요.';
    end if;

    if not exists (
        select 1 from public.kcem_team_members m
        where m.member_id = p_assigned_to
    ) then
        raise exception '담당자를 확인하세요.';
    end if;

    if not exists (
        select 1 from public.kcem_team_members m
        where m.member_id = p_actor_member_id
    ) then
        raise exception '작업자를 확인하세요.';
    end if;

    update public.kcem_tasks as t
    set
        category = v_category,
        title = v_title,
        description = nullif(btrim(coalesce(p_description,'')),''),
        color = nullif(btrim(coalesce(p_color,'')),''),
        tags = coalesce(p_tags, '{}'::text[]),
        quantity = p_quantity,
        quantity_condition = v_condition,
        due_date = p_due_date,
        assigned_to = p_assigned_to,
        updated_at = now()
    where t.task_id = p_task_id
      and t.deleted_at is null;

    if not found then
        raise exception '업무를 찾을 수 없습니다.';
    end if;

    insert into public.kcem_task_history(
        task_id,
        actor_member_id,
        action,
        detail
    )
    values(
        p_task_id,
        p_actor_member_id,
        'EDIT_V2',
        '업무 속성 수정'
    );
end;
$$;

-- ------------------------------------------------------------
-- 드래그 상태 이동
-- REQUESTED -> 요청
-- IN_PROGRESS -> 시작일 자동 기록
-- DONE -> 완료일 자동 기록 / 승인대기
-- APPROVED 상태에서 다시 열 수도 있음
-- ------------------------------------------------------------
create or replace function public.kcem_tasks_move_v2(
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

    if v_status not in ('REQUESTED','IN_PROGRESS','DONE') then
        raise exception '이동할 업무 상태를 확인하세요.';
    end if;

    select t.status
      into v_old
    from public.kcem_tasks t
    where t.task_id = p_task_id
      and t.deleted_at is null;

    if v_old is null then
        raise exception '업무를 찾을 수 없습니다.';
    end if;

    update public.kcem_tasks as t
    set
        status = v_status,
        updated_at = now(),
        started_at = case
            when v_status = 'IN_PROGRESS' then coalesce(t.started_at, now())
            when v_status = 'REQUESTED' then null
            else t.started_at
        end,
        completed_at = case
            when v_status = 'DONE' then now()
            else null
        end,
        approved_at = null
    where t.task_id = p_task_id
      and t.deleted_at is null;

    insert into public.kcem_task_history(
        task_id,
        actor_member_id,
        action,
        detail
    )
    values(
        p_task_id,
        p_actor_member_id,
        'MOVE_V2',
        v_old || ' -> ' || v_status
    );
end;
$$;

-- ------------------------------------------------------------
-- 완료 승인
-- 승인 후 7일간 사람별 보드에 회색으로 남는 것은
-- 웹에서 approved_at 기준으로 처리합니다.
-- ------------------------------------------------------------
create or replace function public.kcem_tasks_approve_v2(
    p_token text,
    p_task_id uuid,
    p_actor_member_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    v_status text;
begin
    perform public.kcem_require_public_session(p_token);

    select t.status
      into v_status
    from public.kcem_tasks t
    where t.task_id = p_task_id
      and t.deleted_at is null;

    if v_status is null then
        raise exception '업무를 찾을 수 없습니다.';
    end if;

    if v_status <> 'DONE' then
        raise exception '완료 상태의 업무만 승인할 수 있습니다.';
    end if;

    update public.kcem_tasks as t
    set
        status = 'APPROVED',
        approved_at = now(),
        completed_at = coalesce(t.completed_at, now()),
        updated_at = now()
    where t.task_id = p_task_id
      and t.deleted_at is null;

    insert into public.kcem_task_history(
        task_id,
        actor_member_id,
        action,
        detail
    )
    values(
        p_task_id,
        p_actor_member_id,
        'APPROVE_V2',
        '완료 승인'
    );
end;
$$;

revoke all on function public.kcem_tasks_list_v2(text) from public;
revoke all on function public.kcem_tasks_create_v2(
    text,text,text,text,text,text,text[],integer,text,date,uuid
) from public;
revoke all on function public.kcem_tasks_update_v2(
    text,uuid,text,text,text,text,text[],integer,text,date,uuid,uuid
) from public;
revoke all on function public.kcem_tasks_move_v2(
    text,uuid,text,uuid
) from public;
revoke all on function public.kcem_tasks_approve_v2(
    text,uuid,uuid
) from public;

grant execute on function public.kcem_tasks_list_v2(text)
to anon, authenticated;

grant execute on function public.kcem_tasks_create_v2(
    text,text,text,text,text,text,text[],integer,text,date,uuid
) to anon, authenticated;

grant execute on function public.kcem_tasks_update_v2(
    text,uuid,text,text,text,text,text[],integer,text,date,uuid,uuid
) to anon, authenticated;

grant execute on function public.kcem_tasks_move_v2(
    text,uuid,text,uuid
) to anon, authenticated;

grant execute on function public.kcem_tasks_approve_v2(
    text,uuid,uuid
) to anon, authenticated;

notify pgrst, 'reload schema';

commit;

-- 확인
select
    count(*) as task_count,
    count(*) filter (where due_date is not null) as with_due_date,
    count(*) filter (where status = 'APPROVED') as approved_count
from public.kcem_tasks
where deleted_at is null;

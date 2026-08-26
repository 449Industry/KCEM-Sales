-- ============================================================
-- KCEM Museum Sales - Public PIN Read Access v1.0.0
--
-- 목적
--   GitHub Pages -> Supabase RPC -> kcem_sales
--
-- 보안 원칙
--   1) anon 사용자는 kcem_sales 테이블을 직접 SELECT 할 수 없음
--   2) 웹 소스에는 PIN을 저장하지 않음
--   3) PIN은 bcrypt 해시로 DB에 저장
--   4) PIN 성공 시 30일짜리 랜덤 조회 토큰 발급
--   5) DB에는 토큰 원문 대신 SHA-256 해시만 저장
--   6) 웹은 조회만 가능. INSERT/UPDATE/DELETE RPC는 제공하지 않음
-- ============================================================

begin;

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- 1. PIN 설정
-- ------------------------------------------------------------
create table if not exists public.kcem_public_pin_config (
    config_id smallint primary key default 1
        check (config_id = 1),

    pin_hash text not null,

    changed_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 2. 승인된 브라우저 세션
-- ------------------------------------------------------------
create table if not exists public.kcem_public_sessions (
    token_hash text primary key,

    device_hash text not null,

    created_at timestamptz not null default now(),

    expires_at timestamptz not null,

    last_used_at timestamptz not null default now()
);

create index if not exists idx_kcem_public_sessions_expires
    on public.kcem_public_sessions(expires_at);

create index if not exists idx_kcem_public_sessions_device
    on public.kcem_public_sessions(device_hash);

-- ------------------------------------------------------------
-- 3. 간단한 PIN 오입력 제한
-- 동일 브라우저 device id 기준 5회 실패 -> 15분 잠금
-- ------------------------------------------------------------
create table if not exists public.kcem_public_login_attempts (
    device_hash text primary key,

    failed_count integer not null default 0,

    locked_until timestamptz,

    updated_at timestamptz not null default now()
);

-- 이 세 테이블은 API에서 직접 읽거나 쓸 수 없게 잠금
revoke all on table public.kcem_public_pin_config
    from public, anon, authenticated;

revoke all on table public.kcem_public_sessions
    from public, anon, authenticated;

revoke all on table public.kcem_public_login_attempts
    from public, anon, authenticated;

alter table public.kcem_public_pin_config enable row level security;
alter table public.kcem_public_sessions enable row level security;
alter table public.kcem_public_login_attempts enable row level security;

-- KCEM 매출 원본도 anon 직접 접근은 계속 금지
revoke all on table public.kcem_sales from anon;

-- ------------------------------------------------------------
-- 4. PIN 변경 함수
-- SQL Editor에서만 사용.
-- 웹/anon/authenticated에는 EXECUTE 권한을 주지 않음.
--
-- 사용:
--   select public.kcem_set_public_pin('12345678');
-- ------------------------------------------------------------
create or replace function public.kcem_set_public_pin(p_pin text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    v_pin text := btrim(coalesce(p_pin, ''));
begin
    if length(v_pin) < 6 or length(v_pin) > 32 then
        raise exception 'PIN은 6~32자로 설정하세요.';
    end if;

    insert into public.kcem_public_pin_config(
        config_id,
        pin_hash,
        changed_at
    )
    values (
        1,
        crypt(v_pin, gen_salt('bf', 12)),
        now()
    )
    on conflict (config_id)
    do update set
        pin_hash = excluded.pin_hash,
        changed_at = now();

    -- PIN 변경 시 기존 브라우저 인증은 전부 해제
    delete from public.kcem_public_sessions;
    delete from public.kcem_public_login_attempts;
end;
$$;

revoke all on function public.kcem_set_public_pin(text)
    from public, anon, authenticated;

-- ------------------------------------------------------------
-- 5. PIN 로그인
-- 성공 시 30일짜리 랜덤 조회 토큰 반환
-- ------------------------------------------------------------
create or replace function public.kcem_public_login(
    p_pin text,
    p_device_id text
)
returns table(
    access_token text,
    expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    v_pin_hash text;
    v_device_hash text;
    v_failed integer := 0;
    v_locked timestamptz;
    v_token text;
    v_expires timestamptz;
begin
    -- 만료 세션 정리
    delete from public.kcem_public_sessions as s
    where s.expires_at <= now();

    v_device_hash :=
        encode(
            digest(
                coalesce(nullif(p_device_id, ''), 'unknown-device') || '|kcem',
                'sha256'
            ),
            'hex'
        );

    select a.failed_count, a.locked_until
    into v_failed, v_locked
    from public.kcem_public_login_attempts a
    where a.device_hash = v_device_hash;

    if v_locked is not null and v_locked > now() then
        raise exception 'PIN 입력이 여러 번 실패했습니다. 잠시 후 다시 시도하세요.';
    end if;

    select c.pin_hash
    into v_pin_hash
    from public.kcem_public_pin_config c
    where c.config_id = 1;

    if v_pin_hash is null then
        raise exception '조회 PIN이 아직 설정되지 않았습니다.';
    end if;

    if crypt(coalesce(p_pin, ''), v_pin_hash) <> v_pin_hash then
        perform pg_sleep(0.35);

        v_failed := coalesce(v_failed, 0) + 1;

        insert into public.kcem_public_login_attempts(
            device_hash,
            failed_count,
            locked_until,
            updated_at
        )
        values (
            v_device_hash,
            v_failed,
            case
                when v_failed >= 5
                    then now() + interval '15 minutes'
                else null
            end,
            now()
        )
        on conflict (device_hash)
        do update set
            failed_count = excluded.failed_count,
            locked_until = excluded.locked_until,
            updated_at = now();

        raise exception 'PIN이 올바르지 않습니다.';
    end if;

    delete from public.kcem_public_login_attempts
    where device_hash = v_device_hash;

    -- 같은 브라우저에서 새 로그인 시 예전 세션 제거
    delete from public.kcem_public_sessions
    where device_hash = v_device_hash;

    v_token := encode(gen_random_bytes(32), 'hex');
    v_expires := now() + interval '30 days';

    insert into public.kcem_public_sessions(
        token_hash,
        device_hash,
        expires_at
    )
    values (
        encode(digest(v_token, 'sha256'), 'hex'),
        v_device_hash,
        v_expires
    );

    return query
    select v_token, v_expires;
end;
$$;

revoke all on function public.kcem_public_login(text, text)
    from public;

grant execute on function public.kcem_public_login(text, text)
    to anon, authenticated;

-- ------------------------------------------------------------
-- 6. 조회 전용 RPC
-- 한 연도의 거래를 건별로 반환
-- ------------------------------------------------------------
create or replace function public.kcem_public_sales(
    p_token text,
    p_year integer
)
returns table(
    transaction_key text,
    sale_date date,
    sale_time time without time zone,
    item_name text,
    payment_method text,
    amount bigint,
    quantity integer,
    comment text,
    source text
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    v_token_hash text;
begin
    if p_year < 2000 or p_year > 2100 then
        raise exception '조회 연도가 올바르지 않습니다.';
    end if;

    if coalesce(p_token, '') = '' then
        raise exception '조회 인증이 필요합니다.';
    end if;

    delete from public.kcem_public_sessions
    where expires_at <= now();

    v_token_hash :=
        encode(digest(p_token, 'sha256'), 'hex');

    if not exists (
        select 1
        from public.kcem_public_sessions s
        where s.token_hash = v_token_hash
          and s.expires_at > now()
    ) then
        raise exception '조회 인증이 만료되었습니다. PIN을 다시 입력하세요.';
    end if;

    update public.kcem_public_sessions
    set last_used_at = now()
    where token_hash = v_token_hash;

    return query
    select
        s.transaction_key,
        s.sale_date,
        s.sale_time,
        s.item_name,
        s.payment_method,
        s.amount,
        s.quantity,
        s.comment,
        s.source
    from public.kcem_sales s
    where s.sale_date >= make_date(p_year, 1, 1)
      and s.sale_date <  make_date(p_year + 1, 1, 1)
    order by
        s.sale_date desc,
        s.sale_time desc,
        s.created_at desc;
end;
$$;

revoke all on function public.kcem_public_sales(text, integer)
    from public;

grant execute on function public.kcem_public_sales(text, integer)
    to anon, authenticated;

-- ------------------------------------------------------------
-- 7. 이 기기 인증 해제
-- ------------------------------------------------------------
create or replace function public.kcem_public_logout(p_token text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
    if coalesce(p_token, '') <> '' then
        delete from public.kcem_public_sessions
        where token_hash =
            encode(digest(p_token, 'sha256'), 'hex');
    end if;
end;
$$;

revoke all on function public.kcem_public_logout(text)
    from public;

grant execute on function public.kcem_public_logout(text)
    to anon, authenticated;

commit;

-- ============================================================
-- 실행 후 PIN을 별도로 설정하세요.
-- 숫자만 사용한다면 8자리 이상 권장.
--
-- 예:
-- select public.kcem_set_public_pin('12345678');
--
-- 아래 확인 결과가 false면 아직 PIN 미설정 상태입니다.
-- ============================================================
select exists (
    select 1
    from public.kcem_public_pin_config
    where config_id = 1
) as pin_configured;

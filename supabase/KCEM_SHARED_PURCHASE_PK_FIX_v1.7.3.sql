-- ============================================================
-- KCEM EUM v1.7.3
-- shared_purchase_requests Primary Key 자동 감지 수정
--
-- 새 테이블 생성 없음
-- shared_purchase_requests ALTER 없음
-- RLS 변경 없음
-- 기존 v1.7.2 RPC를 실제 PK 자동 감지 방식으로 교체
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 실제 Primary Key 컬럼명을 PostgreSQL catalog에서 직접 찾음
-- ID 컬럼 이름을 더 이상 추측하지 않음
-- ------------------------------------------------------------
create or replace function public.kcem_shared_purchase_id_column()
returns text
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
    v_col text;
begin
    select a.attname
      into v_col
    from pg_catalog.pg_index i
    join pg_catalog.pg_class t
      on t.oid = i.indrelid
    join pg_catalog.pg_namespace n
      on n.oid = t.relnamespace
    cross join lateral unnest(i.indkey) with ordinality as k(attnum, ord)
    join pg_catalog.pg_attribute a
      on a.attrelid = t.oid
     and a.attnum = k.attnum
    where n.nspname = 'public'
      and t.relname = 'shared_purchase_requests'
      and i.indisprimary
    order by k.ord
    limit 1;

    -- PK가 없는 비정상/레거시 테이블도 최대한 대응
    if v_col is null then
        select c.column_name
          into v_col
        from information_schema.columns c
        where c.table_schema = 'public'
          and c.table_name = 'shared_purchase_requests'
          and c.is_identity = 'YES'
        order by c.ordinal_position
        limit 1;
    end if;

    if v_col is null then
        select c.column_name
          into v_col
        from information_schema.columns c
        where c.table_schema = 'public'
          and c.table_name = 'shared_purchase_requests'
          and c.column_name = any(array[
              'request_key',
              'purchase_request_key',
              'shared_request_key',
              'purchase_key',
              'id',
              'request_id',
              'purchase_request_id',
              'purchase_id',
              'shared_purchase_id',
              'uuid'
          ])
        order by array_position(
            array[
              'request_key',
              'purchase_request_key',
              'shared_request_key',
              'purchase_key',
              'id',
              'request_id',
              'purchase_request_id',
              'purchase_id',
              'shared_purchase_id',
              'uuid'
            ],
            c.column_name
        )
        limit 1;
    end if;

    return v_col;
end;
$$;

revoke all on function public.kcem_shared_purchase_id_column()
from public, anon, authenticated;

-- ------------------------------------------------------------
-- 목록 RPC 교체
-- ------------------------------------------------------------
create or replace function public.kcem_shared_purchase_list(
    p_token text
)
returns setof jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    v_id text;
    v_source text;
    v_status text;
    v_priority text;
    v_date text;
    v_content text;
    v_quantity text;
    v_amount text;
    v_memo text;
    v_created text;
    v_updated text;
    v_completed text;
begin
    perform public.kcem_require_public_session(p_token);

    v_id := public.kcem_shared_purchase_id_column();

    v_source := public.kcem_shared_purchase_find_column(
        array['source_site','site','source','origin_site','request_site']
    );
    v_status := public.kcem_shared_purchase_find_column(
        array['status','request_status','purchase_status']
    );
    v_priority := public.kcem_shared_purchase_find_column(
        array['priority','priority_level','urgency','priority_no']
    );
    v_date := public.kcem_shared_purchase_find_column(
        array['request_date','requested_date','request_day','requested_at','request_at','date_requested','request_dt','date']
    );
    v_content := public.kcem_shared_purchase_find_column(
        array[
          'item_name','request_text','request_content','item_request',
          'item','title','content','request_item','description',
          'item_text','request_name','purchase_item','purchase_content',
          'item_content','request_description','request_detail',
          'request_details','item_description','product_name','product','name'
        ]
    );
    v_quantity := public.kcem_shared_purchase_find_column(
        array['quantity','qty','request_quantity','quantity_text','qty_text','request_qty','count','amount_qty']
    );
    v_amount := public.kcem_shared_purchase_find_column(
        array[
          'expected_amount','estimated_amount','expected_price','estimated_price',
          'estimate_amount','estimate_price','estimated_cost','expected_cost',
          'cost','price','budget','amount'
        ]
    );
    v_memo := public.kcem_shared_purchase_find_column(
        array['memo','note','notes','comment','comments','remarks','remark','detail_memo','request_memo','memo_text']
    );
    v_created := public.kcem_shared_purchase_find_column(
        array['created_at','created_on','inserted_at','created']
    );
    v_updated := public.kcem_shared_purchase_find_column(
        array['updated_at','local_updated_at','modified_at','updated']
    );
    v_completed := public.kcem_shared_purchase_find_column(
        array['completed_at','purchased_at','done_at','finished_at']
    );

    if v_id is null then
        raise exception 'shared_purchase_requests Primary Key를 찾을 수 없습니다.';
    end if;
    if v_source is null then
        raise exception 'shared_purchase_requests source_site 컬럼을 찾을 수 없습니다.';
    end if;
    if v_status is null then
        raise exception 'shared_purchase_requests status 컬럼을 찾을 수 없습니다.';
    end if;
    if v_content is null then
        raise exception 'shared_purchase_requests 품목/요청내용 컬럼을 찾을 수 없습니다.';
    end if;

    return query
    select jsonb_build_object(
        'id',              to_jsonb(t) ->> v_id,
        'source_site',     coalesce(to_jsonb(t) ->> v_source, ''),
        'status',          coalesce(to_jsonb(t) ->> v_status, 'pending'),
        'priority',        coalesce(to_jsonb(t) ->> v_priority, '3'),
        'request_date',    case when v_date is null then null else to_jsonb(t) ->> v_date end,
        'content',         coalesce(to_jsonb(t) ->> v_content, ''),
        'quantity',        case when v_quantity is null then null else to_jsonb(t) ->> v_quantity end,
        'expected_amount', case when v_amount is null then null else to_jsonb(t) ->> v_amount end,
        'memo',            case when v_memo is null then null else to_jsonb(t) ->> v_memo end,
        'created_at',      case when v_created is null then null else to_jsonb(t) ->> v_created end,
        'updated_at',      case when v_updated is null then null else to_jsonb(t) ->> v_updated end,
        'completed_at',    case when v_completed is null then null else to_jsonb(t) ->> v_completed end
    )
    from public.shared_purchase_requests as t;
end;
$$;

-- ------------------------------------------------------------
-- 신규등록 RPC 교체
-- ------------------------------------------------------------
create or replace function public.kcem_shared_purchase_create(
    p_token text,
    p_request_date date,
    p_priority integer,
    p_content text,
    p_quantity text default null,
    p_expected_amount numeric default null,
    p_memo text default null
)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    v_id text;
    v_source text;
    v_status text;
    v_priority text;
    v_date text;
    v_content text;
    v_quantity text;
    v_amount text;
    v_memo text;
    v_qty_type text;
    v_amount_type text;
    v_cols text;
    v_vals text;
    v_sql text;
    v_new_id text;
begin
    perform public.kcem_require_public_session(p_token);

    if p_priority < 1 or p_priority > 5 then
        raise exception '우선순위는 1~5 사이여야 합니다.';
    end if;

    if btrim(coalesce(p_content,'')) = '' then
        raise exception '품목·요청내용을 입력하세요.';
    end if;

    v_id := public.kcem_shared_purchase_id_column();

    v_source := public.kcem_shared_purchase_find_column(
        array['source_site','site','source','origin_site','request_site']
    );
    v_status := public.kcem_shared_purchase_find_column(
        array['status','request_status','purchase_status']
    );
    v_priority := public.kcem_shared_purchase_find_column(
        array['priority','priority_level','urgency','priority_no']
    );
    v_date := public.kcem_shared_purchase_find_column(
        array['request_date','requested_date','request_day','requested_at','request_at','date_requested','request_dt','date']
    );
    v_content := public.kcem_shared_purchase_find_column(
        array[
          'item_name','request_text','request_content','item_request',
          'item','title','content','request_item','description',
          'item_text','request_name','purchase_item','purchase_content',
          'item_content','request_description','request_detail',
          'request_details','item_description','product_name','product','name'
        ]
    );
    v_quantity := public.kcem_shared_purchase_find_column(
        array['quantity','qty','request_quantity','quantity_text','qty_text','request_qty','count','amount_qty']
    );
    v_amount := public.kcem_shared_purchase_find_column(
        array[
          'expected_amount','estimated_amount','expected_price','estimated_price',
          'estimate_amount','estimate_price','estimated_cost','expected_cost',
          'cost','price','budget','amount'
        ]
    );
    v_memo := public.kcem_shared_purchase_find_column(
        array['memo','note','notes','comment','comments','remarks','remark','detail_memo','request_memo','memo_text']
    );

    if v_id is null or v_source is null or v_status is null
       or v_priority is null or v_date is null or v_content is null then
        raise exception 'shared_purchase_requests 필수 컬럼 구조를 확인하세요.';
    end if;

    v_cols := format('%I,%I,%I,%I,%I', v_source, v_status, v_priority, v_date, v_content);
    v_vals := '$1,$2,$3,$4,$5';

    if v_quantity is not null then
        v_qty_type := public.kcem_shared_purchase_column_type(v_quantity);
        v_cols := v_cols || format(',%I', v_quantity);

        if v_qty_type in ('smallint','integer','bigint') then
            v_vals := v_vals || ',nullif(regexp_replace(coalesce($6,'''') , ''[^0-9-]'', '''', ''g''),'''')::bigint';
        elsif v_qty_type in ('numeric','decimal','real','double precision') then
            v_vals := v_vals || ',nullif(regexp_replace(coalesce($6,'''') , ''[^0-9.-]'', '''', ''g''),'''')::numeric';
        else
            v_vals := v_vals || ',$6';
        end if;
    end if;

    if v_amount is not null then
        v_amount_type := public.kcem_shared_purchase_column_type(v_amount);
        v_cols := v_cols || format(',%I', v_amount);

        if v_amount_type in ('character varying','character','text') then
            v_vals := v_vals || ',$7::text';
        else
            v_vals := v_vals || ',$7';
        end if;
    end if;

    if v_memo is not null then
        v_cols := v_cols || format(',%I', v_memo);
        v_vals := v_vals || ',$8';
    end if;

    v_sql := format(
        'insert into public.shared_purchase_requests (%s) values (%s) returning %I::text',
        v_cols, v_vals, v_id
    );

    execute v_sql
       into v_new_id
       using 'KCEM', 'pending', p_priority, p_request_date, btrim(p_content),
             nullif(btrim(coalesce(p_quantity,'')),''),
             p_expected_amount,
             nullif(btrim(coalesce(p_memo,'')),'');

    return v_new_id;
end;
$$;

-- ------------------------------------------------------------
-- 수정 RPC 교체
-- ------------------------------------------------------------
create or replace function public.kcem_shared_purchase_update(
    p_token text,
    p_id text,
    p_request_date date,
    p_priority integer,
    p_content text,
    p_quantity text default null,
    p_expected_amount numeric default null,
    p_memo text default null
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    v_id text;
    v_source text;
    v_priority text;
    v_date text;
    v_content text;
    v_quantity text;
    v_amount text;
    v_memo text;
    v_qty_type text;
    v_amount_type text;
    v_set text;
    v_sql text;
begin
    perform public.kcem_require_public_session(p_token);

    v_id := public.kcem_shared_purchase_id_column();

    v_source := public.kcem_shared_purchase_find_column(
        array['source_site','site','source','origin_site','request_site']
    );
    v_priority := public.kcem_shared_purchase_find_column(
        array['priority','priority_level','urgency','priority_no']
    );
    v_date := public.kcem_shared_purchase_find_column(
        array['request_date','requested_date','request_day','requested_at','request_at','date_requested','request_dt','date']
    );
    v_content := public.kcem_shared_purchase_find_column(
        array[
          'item_name','request_text','request_content','item_request',
          'item','title','content','request_item','description',
          'item_text','request_name','purchase_item','purchase_content',
          'item_content','request_description','request_detail',
          'request_details','item_description','product_name','product','name'
        ]
    );
    v_quantity := public.kcem_shared_purchase_find_column(
        array['quantity','qty','request_quantity','quantity_text','qty_text','request_qty','count','amount_qty']
    );
    v_amount := public.kcem_shared_purchase_find_column(
        array[
          'expected_amount','estimated_amount','expected_price','estimated_price',
          'estimate_amount','estimate_price','estimated_cost','expected_cost',
          'cost','price','budget','amount'
        ]
    );
    v_memo := public.kcem_shared_purchase_find_column(
        array['memo','note','notes','comment','comments','remarks','remark','detail_memo','request_memo','memo_text']
    );

    if v_id is null or v_source is null or v_priority is null
       or v_date is null or v_content is null then
        raise exception 'shared_purchase_requests 필수 컬럼 구조를 확인하세요.';
    end if;

    v_set := format('%I=$2, %I=$3, %I=$4', v_date, v_priority, v_content);

    if v_quantity is not null then
        v_qty_type := public.kcem_shared_purchase_column_type(v_quantity);

        if v_qty_type in ('smallint','integer','bigint') then
            v_set := v_set || format(
                ', %I=nullif(regexp_replace(coalesce($5,'''') , ''[^0-9-]'', '''', ''g''),'''')::bigint',
                v_quantity
            );
        elsif v_qty_type in ('numeric','decimal','real','double precision') then
            v_set := v_set || format(
                ', %I=nullif(regexp_replace(coalesce($5,'''') , ''[^0-9.-]'', '''', ''g''),'''')::numeric',
                v_quantity
            );
        else
            v_set := v_set || format(', %I=$5', v_quantity);
        end if;
    end if;

    if v_amount is not null then
        v_amount_type := public.kcem_shared_purchase_column_type(v_amount);

        if v_amount_type in ('character varying','character','text') then
            v_set := v_set || format(', %I=$6::text', v_amount);
        else
            v_set := v_set || format(', %I=$6', v_amount);
        end if;
    end if;

    if v_memo is not null then
        v_set := v_set || format(', %I=$7', v_memo);
    end if;

    v_sql := format(
        'update public.shared_purchase_requests
            set %s
          where %I::text=$1
            and upper(%I::text)=''KCEM''',
        v_set, v_id, v_source
    );

    execute v_sql
      using p_id, p_request_date, p_priority, btrim(p_content),
            nullif(btrim(coalesce(p_quantity,'')),''),
            p_expected_amount,
            nullif(btrim(coalesce(p_memo,'')),'');
end;
$$;

-- ------------------------------------------------------------
-- 삭제 RPC 교체
-- ------------------------------------------------------------
create or replace function public.kcem_shared_purchase_delete(
    p_token text,
    p_id text
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    v_id text;
    v_source text;
begin
    perform public.kcem_require_public_session(p_token);

    v_id := public.kcem_shared_purchase_id_column();
    v_source := public.kcem_shared_purchase_find_column(
        array['source_site','site','source','origin_site','request_site']
    );

    if v_id is null or v_source is null then
        raise exception 'shared_purchase_requests PK/source 컬럼을 확인하세요.';
    end if;

    execute format(
        'delete from public.shared_purchase_requests
          where %I::text=$1
            and upper(%I::text)=''KCEM''',
        v_id, v_source
    )
    using p_id;
end;
$$;

-- ------------------------------------------------------------
-- 상태 변경 RPC 교체
-- ------------------------------------------------------------
create or replace function public.kcem_shared_purchase_set_status(
    p_token text,
    p_id text,
    p_status text
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    v_id text;
    v_status text;
    v_completed text;
    v_sql text;
    v_next text := lower(btrim(coalesce(p_status,'')));
begin
    perform public.kcem_require_public_session(p_token);

    if v_next not in ('pending','completed') then
        raise exception '상태는 pending 또는 completed만 가능합니다.';
    end if;

    v_id := public.kcem_shared_purchase_id_column();
    v_status := public.kcem_shared_purchase_find_column(
        array['status','request_status','purchase_status']
    );
    v_completed := public.kcem_shared_purchase_find_column(
        array['completed_at','purchased_at','done_at','finished_at']
    );

    if v_id is null or v_status is null then
        raise exception 'shared_purchase_requests PK/status 컬럼을 확인하세요.';
    end if;

    if v_completed is not null then
        v_sql := format(
            'update public.shared_purchase_requests
                set %I=$2,
                    %I=case when $2=''completed'' then now() else null end
              where %I::text=$1',
            v_status, v_completed, v_id
        );
    else
        v_sql := format(
            'update public.shared_purchase_requests
                set %I=$2
              where %I::text=$1',
            v_status, v_id
        );
    end if;

    execute v_sql using p_id, v_next;
end;
$$;

-- 기존 실행권한 유지
grant execute on function public.kcem_shared_purchase_list(text)
to anon, authenticated;

grant execute on function public.kcem_shared_purchase_create(text,date,integer,text,text,numeric,text)
to anon, authenticated;

grant execute on function public.kcem_shared_purchase_update(text,text,date,integer,text,text,numeric,text)
to anon, authenticated;

grant execute on function public.kcem_shared_purchase_delete(text,text)
to anon, authenticated;

grant execute on function public.kcem_shared_purchase_set_status(text,text,text)
to anon, authenticated;

notify pgrst, 'reload schema';

commit;

-- ============================================================
-- 진단 출력
-- 데이터 변경 없음
-- ============================================================

-- 1) 실제 Primary Key 이름
select public.kcem_shared_purchase_id_column() as detected_primary_key;

-- 2) 실제 테이블 컬럼 전체
select
    ordinal_position,
    column_name,
    data_type,
    is_nullable,
    column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'shared_purchase_requests'
order by ordinal_position;

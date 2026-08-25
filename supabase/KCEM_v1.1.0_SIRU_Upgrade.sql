-- ============================================================
-- KCEM Museum Sales v1.1.0
-- 시루 결제수단 추가 + 기존 2026-07-25 이관 데이터 보정
-- ============================================================

begin;

-- 1. payment_method 제약조건을 현금/계좌/시루/카드로 확장
alter table public.kcem_sales
    drop constraint if exists kcem_sales_payment_method_check;

alter table public.kcem_sales
    add constraint kcem_sales_payment_method_check
    check (payment_method in ('현금', '계좌', '시루', '카드'));

-- 2. 기존 Excel 이관 데이터 보정
-- 원본 장부: 2026-07-25 계좌 12,000원 / 비고 '(10000원)시루'
-- => 계좌 2,000원 + 시루 10,000원으로 분리
update public.kcem_sales
set
    amount = 2000,
    item_name = '(10000원)시루',
    comment = '기존 Excel 장부 이관 · 계좌 12,000원 중 시루 10,000원 분리 후 계좌 잔액 2,000원 · 원본 비고: (10000원)시루',
    local_updated_at = now()
where source_ref = 'KCEM-XLSX-2026-07-25-계좌'
  and source = 'MIGRATION_XLSX';

insert into public.kcem_sales
(
    sale_date,
    sale_time,
    item_name,
    payment_method,
    amount,
    quantity,
    comment,
    source,
    source_ref,
    created_by
)
select
    date '2026-07-25',
    time '12:00:30',
    '(10000원)시루',
    '시루',
    10000,
    1,
    '기존 Excel 장부 이관 · 원본 비고: (10000원)시루',
    'MIGRATION_XLSX',
    'KCEM-XLSX-2026-07-25-시루',
    'e41acc01-2bc5-4fe5-adba-644200e8bf0e'::uuid
where not exists (
    select 1
    from public.kcem_sales
    where source_ref = 'KCEM-XLSX-2026-07-25-시루'
);

-- 3. 집계 View를 v1.1.0 기준으로 재구성
-- 현금그룹 = 현금 + 계좌 + 시루

drop view if exists public.kcem_daily_sales;
drop view if exists public.kcem_monthly_sales;
drop view if exists public.kcem_annual_sales;

create view public.kcem_daily_sales
with (security_invoker = true)
as
select
    sale_date,
    coalesce(sum(amount) filter (where payment_method = '현금'), 0)::bigint as cash_only_sales,
    coalesce(sum(amount) filter (where payment_method = '계좌'), 0)::bigint as account_sales,
    coalesce(sum(amount) filter (where payment_method = '시루'), 0)::bigint as siru_sales,
    coalesce(sum(amount) filter (where payment_method in ('현금','계좌','시루')), 0)::bigint as cash_sales,
    coalesce(sum(amount) filter (where payment_method = '카드'), 0)::bigint as card_sales,
    sum(amount)::bigint as total_sales,
    count(*)::bigint as transaction_count
from public.kcem_sales
group by sale_date;

create view public.kcem_monthly_sales
with (security_invoker = true)
as
select
    extract(year from sale_date)::integer as sale_year,
    extract(month from sale_date)::integer as sale_month,
    coalesce(sum(amount) filter (where payment_method = '현금'), 0)::bigint as cash_only_sales,
    coalesce(sum(amount) filter (where payment_method = '계좌'), 0)::bigint as account_sales,
    coalesce(sum(amount) filter (where payment_method = '시루'), 0)::bigint as siru_sales,
    coalesce(sum(amount) filter (where payment_method in ('현금','계좌','시루')), 0)::bigint as cash_sales,
    coalesce(sum(amount) filter (where payment_method = '카드'), 0)::bigint as card_sales,
    sum(amount)::bigint as total_sales,
    count(*)::bigint as transaction_count
from public.kcem_sales
group by extract(year from sale_date), extract(month from sale_date);

create view public.kcem_annual_sales
with (security_invoker = true)
as
select
    extract(year from sale_date)::integer as sale_year,
    coalesce(sum(amount) filter (where payment_method = '현금'), 0)::bigint as cash_only_sales,
    coalesce(sum(amount) filter (where payment_method = '계좌'), 0)::bigint as account_sales,
    coalesce(sum(amount) filter (where payment_method = '시루'), 0)::bigint as siru_sales,
    coalesce(sum(amount) filter (where payment_method in ('현금','계좌','시루')), 0)::bigint as cash_sales,
    coalesce(sum(amount) filter (where payment_method = '카드'), 0)::bigint as card_sales,
    sum(amount)::bigint as total_sales,
    count(*)::bigint as transaction_count
from public.kcem_sales
group by extract(year from sale_date);

revoke all on public.kcem_daily_sales from anon, authenticated;
revoke all on public.kcem_monthly_sales from anon, authenticated;
revoke all on public.kcem_annual_sales from anon, authenticated;

grant select on public.kcem_daily_sales to authenticated;
grant select on public.kcem_monthly_sales to authenticated;
grant select on public.kcem_annual_sales to authenticated;

notify pgrst, 'reload schema';

commit;

-- 4. 검증
select
    sale_year,
    sale_month,
    cash_only_sales,
    account_sales,
    siru_sales,
    cash_sales,
    card_sales,
    total_sales,
    transaction_count
from public.kcem_monthly_sales
where sale_year = 2026
order by sale_month;

select
    payment_method,
    sum(amount) as amount
from public.kcem_sales
where sale_date = date '2026-07-25'
group by payment_method
order by payment_method;

-- 전체 매출 합계는 시루 분리 전과 동일해야 합니다.
select sum(amount) as total_2026
from public.kcem_sales
where sale_date >= date '2026-01-01'
  and sale_date < date '2027-01-01';

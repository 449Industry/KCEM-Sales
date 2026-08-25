-- KCEM GitHub Pages read-only PIN API + existing admin edit/delete policy support
-- Run once in the SAME Supabase project used by OOZY/uwash/kcem_*.
-- This does not create a second project and does not expose kcem_sales to anon directly.

begin;
create extension if not exists pgcrypto;

create table if not exists public.kcem_web_settings (
    id smallint primary key check (id = 1),
    viewer_pin_hash text,
    updated_at timestamptz not null default now()
);

insert into public.kcem_web_settings(id, viewer_pin_hash)
values (1, null)
on conflict (id) do nothing;

revoke all on public.kcem_web_settings from anon, authenticated;

create or replace function public.kcem_public_sales(
    p_pin text,
    p_date_from date,
    p_date_to date
)
returns table (
    transaction_key text,
    sale_date date,
    sale_time time without time zone,
    item_name text,
    payment_method text,
    amount bigint,
    quantity integer,
    comment text,
    created_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    v_hash text;
begin
    select viewer_pin_hash into v_hash
    from public.kcem_web_settings
    where id = 1;

    if v_hash is null or p_pin is null or crypt(p_pin, v_hash) <> v_hash then
        raise exception 'INVALID_VIEWER_PIN' using errcode = '28000';
    end if;
    if p_date_from is null or p_date_to is null or p_date_from > p_date_to then
        raise exception 'INVALID_DATE_RANGE' using errcode = '22007';
    end if;
    if p_date_to - p_date_from > 370 then
        raise exception 'DATE_RANGE_TOO_LARGE' using errcode = '22023';
    end if;

    return query
    select s.transaction_key, s.sale_date, s.sale_time, s.item_name,
           s.payment_method, s.amount, s.quantity, s.comment, s.created_at
    from public.kcem_sales s
    where s.sale_date between p_date_from and p_date_to
    order by s.sale_date desc, s.sale_time desc, s.created_at desc;
end;
$$;

revoke all on function public.kcem_public_sales(text,date,date) from public;
grant execute on function public.kcem_public_sales(text,date,date) to anon, authenticated;

notify pgrst, 'reload schema';
commit;

-- IMPORTANT: after this migration, run the next statement ONCE in SQL Editor,
-- replacing CURRENT_PUBLIC_PIN with the public viewer PIN you already use.
-- Do not put the PIN in GitHub/config.js.
--
-- update public.kcem_web_settings
-- set viewer_pin_hash = crypt('CURRENT_PUBLIC_PIN', gen_salt('bf')), updated_at = now()
-- where id = 1;

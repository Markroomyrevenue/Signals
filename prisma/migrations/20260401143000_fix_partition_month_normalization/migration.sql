CREATE OR REPLACE FUNCTION ensure_monthly_partition(base_table TEXT, month_start DATE)
RETURNS VOID AS $$
DECLARE
  normalized_month_start DATE := date_trunc('month', month_start)::date;
  part_name TEXT := format('%s_%s', base_table, to_char(normalized_month_start, 'YYYY_MM'));
  month_end DATE := (normalized_month_start + INTERVAL '1 month')::date;
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
    part_name,
    base_table,
    normalized_month_start,
    month_end
  );
END;
$$ LANGUAGE plpgsql;

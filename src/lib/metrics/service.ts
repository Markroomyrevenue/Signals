import { MetricDataLoader } from "@/lib/metrics/data-loader";
import { getMetricDefinition } from "@/lib/metrics/registry";
import { MetricFilters, MetricId, MetricQueryResult } from "@/lib/metrics/types";

export async function queryMetrics(params: {
  tenantId: string;
  metricIds: MetricId[];
  filters: MetricFilters;
  displayCurrency: string;
}): Promise<MetricQueryResult> {
  const loader = new MetricDataLoader(params.tenantId, params.filters, params.displayCurrency);

  const series = [];
  for (const metricId of params.metricIds) {
    const definition = getMetricDefinition(metricId);
    if (!definition) {
      continue;
    }

    const result = await definition.query({
      tenantId: params.tenantId,
      filters: params.filters,
      displayCurrency: params.displayCurrency,
      loader
    });

    series.push(result);
  }

  return {
    xKey: "x",
    series
  };
}

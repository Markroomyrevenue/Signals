export type NumericBucket = {
  id: string;
  label: string;
  min: number;
  max: number | null;
};

export const LEAD_TIME_BUCKETS: NumericBucket[] = [
  { id: "0-1", label: "0-1", min: 0, max: 1 },
  { id: "2-3", label: "2-3", min: 2, max: 3 },
  { id: "4-7", label: "4-7", min: 4, max: 7 },
  { id: "8-14", label: "8-14", min: 8, max: 14 },
  { id: "15-30", label: "15-30", min: 15, max: 30 },
  { id: "31-60", label: "31-60", min: 31, max: 60 },
  { id: "61-90", label: "61-90", min: 61, max: 90 },
  { id: "91-180", label: "91-180", min: 91, max: 180 },
  { id: "181+", label: "181+", min: 181, max: null }
];

export const LOS_BUCKETS: NumericBucket[] = [
  { id: "1", label: "1", min: 1, max: 1 },
  { id: "2", label: "2", min: 2, max: 2 },
  { id: "3", label: "3", min: 3, max: 3 },
  { id: "4-6", label: "4-6", min: 4, max: 6 },
  { id: "7-13", label: "7-13", min: 7, max: 13 },
  { id: "14-27", label: "14-27", min: 14, max: 27 },
  { id: "28+", label: "28+", min: 28, max: null }
];

export function bucketForValue(value: number, buckets: NumericBucket[]): NumericBucket | null {
  for (const bucket of buckets) {
    if (value < bucket.min) continue;
    if (bucket.max === null || value <= bucket.max) {
      return bucket;
    }
  }
  return null;
}

export function matchesBucketSelection(
  value: number | null | undefined,
  selectedBucketIds: string[] | undefined,
  buckets: NumericBucket[]
): boolean {
  if (!selectedBucketIds || selectedBucketIds.length === 0) {
    return true;
  }

  if (value === null || value === undefined) {
    return false;
  }

  const bucket = bucketForValue(value, buckets);
  return Boolean(bucket && selectedBucketIds.includes(bucket.id));
}

export function parseBucketRanges(
  selectedBucketIds: string[] | undefined,
  buckets: NumericBucket[]
): Array<{ min: number; max: number | null }> {
  if (!selectedBucketIds || selectedBucketIds.length === 0) {
    return [];
  }

  return buckets
    .filter((bucket) => selectedBucketIds.includes(bucket.id))
    .map((bucket) => ({ min: bucket.min, max: bucket.max }));
}

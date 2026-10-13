export interface ResultValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export interface PerformanceComparison {
  readonly status: "report_only" | "incompatible";
  readonly reason: string;
  readonly regressions: readonly Readonly<Record<string, unknown>>[];
  readonly [key: string]: unknown;
}

export const RESULT_SCHEMA: string;
export const FIXTURE_SCHEMA: string;
export const METRIC_DEFINITION_VERSION: number;
export const COLLECTOR_VERSION: string;
export const QUANTILE_METHOD: string;

export function isPlainObject(value: unknown): value is Record<string, unknown>;
export function fixtureManifestSha256(manifest: unknown): string;
export function validateResultDocument(document: unknown): ResultValidation;
export function performanceAggregationIdentityDifferences(
  first: unknown,
  candidate: unknown,
): readonly string[];
export function compareResultDocuments(
  baseline: unknown | null,
  candidate: unknown,
  policy?: "report-only",
): PerformanceComparison;
export function parseExactFlags(args: readonly string[], requiredFlags: readonly string[]): Record<string, string>;
export function readResultFile(filePath: string): Promise<{
  readonly document: unknown | null;
  readonly error: "invalid_json" | "file_not_found" | null;
}>;

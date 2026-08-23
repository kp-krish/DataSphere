/**
 * Typed API client.
 *
 * One place that knows how to talk to the server, so no component builds a URL
 * or unwraps an error envelope. The API answers every failure in the same
 * shape, so this turns that into one `ApiError` with the server's stable
 * `code` intact - the query builder reacts to `unknown_column` specifically,
 * not to a substring of a message that may later be reworded.
 */

import type {
  Catalog,
  ColumnKind,
  Dashboard,
  FilterOperator,
  QueryResult,
  QuerySpec,
  Widget,
  WidgetConfig,
  WidgetType,
} from '@datasphere/core';

/**
 * Empty means same-origin, which is the norm: nginx proxies /api in the
 * container and the Vite dev server proxies it locally.
 */
const BASE = import.meta.env.VITE_API_BASE_URL ?? '';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}/api${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
  } catch (cause) {
    // fetch only rejects on a network-level failure, which is worth
    // distinguishing from an API that answered with an error.
    throw new ApiError(0, 'network_error', 'Could not reach the API.', cause);
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const body: unknown = text ? JSON.parse(text) : undefined;

  if (!response.ok) {
    const envelope = body as { error?: { code?: string; message?: string; details?: unknown } };
    throw new ApiError(
      response.status,
      envelope?.error?.code ?? 'unknown_error',
      envelope?.error?.message ?? `Request failed with HTTP ${response.status}`,
      envelope?.error?.details,
    );
  }

  return body as T;
}

/* -------------------------------------------------------------------------- */
/* Catalog                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The catalog plus the rules the builder needs.
 *
 * The operator matrix comes from the server rather than being duplicated in
 * the client, so the UI can never offer a filter the compiler will reject.
 */
export interface CatalogResponse extends Catalog {
  meta: {
    ageSeconds: number;
    operators: Record<ColumnKind, FilterOperator[]>;
    aggregates: string[];
    grains: string[];
    limits: {
      maxRows: number;
      defaultLimit: number;
      maxDimensions: number;
      maxMeasures: number;
      maxFilters: number;
    };
  };
}

export const getCatalog = (): Promise<CatalogResponse> => request('/catalog');

/* -------------------------------------------------------------------------- */
/* Queries                                                                    */
/* -------------------------------------------------------------------------- */

export interface RunQueryOptions {
  noCache?: boolean;
  includeSql?: boolean;
}

export const runQuery = (spec: QuerySpec, options: RunQueryOptions = {}): Promise<QueryResult> =>
  request('/query', {
    method: 'POST',
    body: JSON.stringify({ spec, ...options }),
  });

export interface CompiledPreview {
  sql: string;
  values: unknown[];
  columns: string[];
  appliedLimit: number;
  cacheKey: string;
}

export const compileQuerySpec = (spec: QuerySpec): Promise<CompiledPreview> =>
  request('/query/compile', { method: 'POST', body: JSON.stringify(spec) });

/* -------------------------------------------------------------------------- */
/* Dashboards                                                                 */
/* -------------------------------------------------------------------------- */

export interface DashboardSummary extends Dashboard {
  widgetCount: number;
}

export const listDashboards = (): Promise<{ dashboards: DashboardSummary[] }> =>
  request('/dashboards');

export const getDashboard = (id: string): Promise<Dashboard> => request(`/dashboards/${id}`);

export const createDashboard = (input: {
  name: string;
  description?: string | null;
}): Promise<Dashboard> => request('/dashboards', { method: 'POST', body: JSON.stringify(input) });

export const updateDashboard = (
  id: string,
  input: { name?: string; description?: string | null },
): Promise<Dashboard> =>
  request(`/dashboards/${id}`, { method: 'PATCH', body: JSON.stringify(input) });

export const deleteDashboard = (id: string): Promise<void> =>
  request(`/dashboards/${id}`, { method: 'DELETE' });

/* -------------------------------------------------------------------------- */
/* Widgets                                                                    */
/* -------------------------------------------------------------------------- */

export interface CreateWidgetInput {
  title: string;
  type: WidgetType;
  querySpec: QuerySpec;
  config?: WidgetConfig;
  width?: number;
  height?: number;
}

export const createWidget = (dashboardId: string, input: CreateWidgetInput): Promise<Widget> =>
  request(`/dashboards/${dashboardId}/widgets`, {
    method: 'POST',
    body: JSON.stringify(input),
  });

export const updateWidget = (id: string, input: Partial<CreateWidgetInput>): Promise<Widget> =>
  request(`/widgets/${id}`, { method: 'PATCH', body: JSON.stringify(input) });

export const deleteWidget = (id: string): Promise<void> =>
  request(`/widgets/${id}`, { method: 'DELETE' });

export const reorderWidgets = (
  dashboardId: string,
  widgetIds: string[],
): Promise<{ widgets: Widget[] }> =>
  request(`/dashboards/${dashboardId}/widgets/order`, {
    method: 'PUT',
    body: JSON.stringify({ widgetIds }),
  });

export interface WidgetData extends QueryResult {
  widgetId: string;
}

export const getWidgetData = (id: string, options: RunQueryOptions = {}): Promise<WidgetData> => {
  const params = new URLSearchParams();
  if (options.noCache) params.set('noCache', '1');
  if (options.includeSql) params.set('includeSql', '1');
  const query = params.toString();
  return request(`/widgets/${id}/data${query ? `?${query}` : ''}`);
};

/* -------------------------------------------------------------------------- */
/* Cache                                                                      */
/* -------------------------------------------------------------------------- */

export interface CacheStats {
  enabled: boolean;
  connected: boolean;
  hits: number;
  misses: number;
  bypasses: number;
  hitRate: number | null;
  entries: number;
  ttlSeconds: number;
  memoryUsedBytes: number | null;
  generations: Record<string, number>;
  datasets: string[];
}

export const getCacheStats = (): Promise<CacheStats> => request('/cache/stats');

export const invalidateCache = (
  dataset?: string,
): Promise<{ invalidated: Record<string, number> }> =>
  request('/cache/invalidate', {
    method: 'POST',
    body: JSON.stringify(dataset ? { dataset } : {}),
  });

export const simulateOrders = (
  count: number,
): Promise<{ inserted: number; revenueAdded: number; generation: number }> =>
  request('/demo/orders', { method: 'POST', body: JSON.stringify({ count }) });

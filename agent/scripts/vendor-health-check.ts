/**
 * Vendor health check used by the per-MR `evals:gate` CI job.
 *
 * Each of the four eval suites depends on at least one external vendor
 * (Anthropic for synthesis, OpenAI for embeddings, Pinecone for vector
 * retrieval, Cohere for rerank). When any of those vendors is mid-outage
 * during a PR run the gate would otherwise fail spuriously — same code,
 * same baseline, vendor blip flips a `factually_consistent` cell.
 *
 * The check is conservative on purpose: a non-2xx status from a public
 * status page or a hard timeout marks the vendor `degraded`. Cases that
 * depend on a degraded vendor are excluded from the regression-rate
 * denominator (and surfaced separately on the PR comment) instead of
 * counting against the 5% tolerance.
 *
 * Status pages are read-only public endpoints — no auth, no PHI, no
 * rate-limit risk. The fetch budget (8s per vendor, all in parallel) is
 * tiny next to the rest of the gate.
 */

export const VENDORS = ['anthropic', 'openai', 'cohere', 'pinecone', 'langsmith'] as const;
export type Vendor = (typeof VENDORS)[number];

export type VendorStatus = 'ok' | 'degraded' | 'unknown';

export interface VendorReport {
    readonly vendor: Vendor;
    readonly status: VendorStatus;
    readonly httpStatus: number | null;
    readonly latencyMs: number;
    readonly reason: string | null;
}

export interface HealthCheckResult {
    readonly checkedAt: string;
    readonly reports: readonly VendorReport[];
    readonly degradedVendors: readonly Vendor[];
}

interface CheckOptions {
    readonly fetchImpl?: typeof fetch;
    readonly timeoutMs?: number;
    readonly endpoints?: Partial<Record<Vendor, string>>;
}

const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * Public status-summary endpoints. Each vendor publishes a hosted
 * status page (StatusPage / Statuspal / similar) with a JSON summary at
 * a stable URL. We treat any 2xx response as `ok`. We don't parse the
 * body intentionally — vendors change their incident schemas, and a
 * lenient "is the page reachable" check correctly catches DNS failures,
 * gateway-level outages, and TLS issues without coupling to vendor
 * internals.
 */
export const DEFAULT_VENDOR_ENDPOINTS: Readonly<Record<Vendor, string>> = {
    anthropic: 'https://status.anthropic.com/api/v2/status.json',
    openai: 'https://status.openai.com/api/v2/status.json',
    cohere: 'https://status.cohere.com/api/v2/status.json',
    pinecone: 'https://status.pinecone.io/api/v2/status.json',
    langsmith: 'https://status.smith.langchain.com/api/v2/status.json',
};

const checkOne = async (
    vendor: Vendor,
    endpoint: string,
    fetchImpl: typeof fetch,
    timeoutMs: number,
): Promise<VendorReport> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const start = Date.now();
    try {
        const res = await fetchImpl(endpoint, { signal: controller.signal });
        const latencyMs = Date.now() - start;
        if (res.ok) {
            return { vendor, status: 'ok', httpStatus: res.status, latencyMs, reason: null };
        }
        return {
            vendor,
            status: 'degraded',
            httpStatus: res.status,
            latencyMs,
            reason: `non-2xx response from status page`,
        };
    } catch (err: unknown) {
        const latencyMs = Date.now() - start;
        const reason = err instanceof Error ? err.message : String(err);
        return { vendor, status: 'degraded', httpStatus: null, latencyMs, reason };
    } finally {
        clearTimeout(timer);
    }
};

export const checkVendorHealth = async (
    options: CheckOptions = {},
): Promise<HealthCheckResult> => {
    const fetchImpl = options.fetchImpl ?? fetch;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const endpoints = { ...DEFAULT_VENDOR_ENDPOINTS, ...options.endpoints };

    const reports = await Promise.all(
        VENDORS.map((vendor) => checkOne(vendor, endpoints[vendor], fetchImpl, timeoutMs)),
    );
    const degradedVendors = reports.filter((r) => r.status === 'degraded').map((r) => r.vendor);
    return {
        checkedAt: new Date().toISOString(),
        reports,
        degradedVendors,
    };
};

/**
 * Map each suite to the vendors it depends on at runtime. The eval
 * gate consults this when a vendor is reported degraded — cases on the
 * affected suites are excluded from the regression-rate denominator
 * (and listed separately on the PR comment). If a suite's degraded set
 * is non-empty, the gate emits a `vendor-outage-skip` warning rather
 * than failing.
 */
export const SUITE_VENDOR_DEPENDENCIES: Readonly<Record<string, readonly Vendor[]>> = {
    'briefing-graph': ['anthropic', 'langsmith'],
    'conversational-graph': ['anthropic', 'openai', 'pinecone', 'cohere', 'langsmith'],
    'document-extraction': ['anthropic', 'langsmith'],
    'end-to-end': ['anthropic', 'openai', 'pinecone', 'cohere', 'langsmith'],
};

export const isMain = (importMetaUrl: string): boolean =>
    process.argv[1] !== undefined && new URL(importMetaUrl).pathname === process.argv[1];

const main = async (): Promise<void> => {
    const result = await checkVendorHealth();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.degradedVendors.length > 0) {
        process.stderr.write(
            `vendor-health-check: degraded vendors: ${result.degradedVendors.join(', ')}\n`,
        );
        // Exit 0 anyway — the gate decides whether to skip cases or
        // fail. Being a status reporter, this script never blocks CI.
    }
};

if (isMain(import.meta.url)) {
    void main().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`vendor-health-check: ${message}\n`);
        process.exit(1);
    });
}

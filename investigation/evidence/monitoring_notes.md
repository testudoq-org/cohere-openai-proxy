# Monitoring & Alerting additions (investigation)

Captured 2026-01-06

1) Add Prometheus alerts:
   - Alert: CohereTrialKeyRateLimitExceeded
     - Expression: increase(cohere_request_failure_total{job="cohere-app",reason="rate_limit"}[2m]) > 0
     - Severity: page
     - Description: Trigger when any 429s observed within 2 minutes.

   - Alert: CohereActualRPMHigh
     - Expression: cohere_actual_rpm{window="1m"} > 38
     - Severity: ticket
     - Description: High request rate approaching Trial key limit (40/min).

2) Metrics to add in cohereClientFactory.mjs:
   - x_rate_limit_headers_parsed (gauge) with labels {limit,remaining,reset}
   - cohere_rate_limit_errors_total (counter) label: {type} (e.g., 'trial', 'tenant')

3) Log enrichment:
   - When recording upstream responses, capture response.headers['x-rate-limit-limit'], ['x-rate-limit-remaining'], ['x-rate-limit-reset'] into structured logs (if present).
   - Include timestamp and traceId in each log entry (already present).

4) Rollback / mitigation plan:
   - Short-term: If 429s spike, set GLOBAL_RATE_LIMIT_PER_MIN to 30 and restart service. This reduces calls and buys time.
   - Mid-term: Implement global token-bucket enforcement across chat/embed operations (per rate-limiting-compliance-plan.md).
   - Long-term: Upgrade Cohere key to Production with higher limits or implement per-tenant quota management.

5) Tests:
   - Add unit tests to validate parsing of x-rate-limit-* headers into metrics and to ensure backoff obeys Retry-After and header-derived reset windows.

6) Implementation notes:
   - Backoff: Exponential backoff with full jitter; respect Retry-After header when present. Use `Math.min(backoff, (resetTs - Date.now())/1000)` when x-rate-limit-reset available.

7) Files created:
   - investigation/evidence/metrics.txt
   - investigation/evidence/requests_responses.json
   - investigation/evidence/proposed_patch.diff
   - investigation/evidence/repro_curl.sh
   - investigation/evidence/repro_ps.ps1
   - investigation/evidence/repro_curl_output.txt


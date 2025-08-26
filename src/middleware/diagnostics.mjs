// Lightweight diagnostics middleware: attaches traceId, measures total request time,
// and emits minimal JSON logs when diagnostics are enabled via SKIP_DIAGNOSTICS env var.
export default function diagnostics(req, res, next) {
  const DIAGNOSTICS_DISABLED = !!(process.env.SKIP_DIAGNOSTICS && ['1', 'true', 'yes'].includes(String(process.env.SKIP_DIAGNOSTICS).toLowerCase()));
  const nowMs = () => Number(process.hrtime.bigint() / 1000000n);
  const generateTraceId = () => Date.now().toString(36) + Math.random().toString(36).slice(2,10);

  const incomingTrace = req.headers['x-trace-id'];
  const traceId = incomingTrace || generateTraceId();
  // ensure trace id is available downstream
  req.headers['x-trace-id'] = traceId;
  req.traceId = traceId;
  res.setHeader('x-trace-id', traceId);

  const start = nowMs();
  if (!DIAGNOSTICS_DISABLED) {
    try { console.log(JSON.stringify({ traceId, phase: 'server:request:start', method: req.method, path: req.path, start })); } catch (e) {}
  }

  res.on('finish', () => {
    const end = nowMs();
    const durationMs = end - start;
    if (!DIAGNOSTICS_DISABLED) {
      try { console.log(JSON.stringify({ traceId, phase: 'server:request:done', method: req.method, path: req.path, status: res.statusCode, durationMs })); } catch (e) {}
    }
  });

  next();
}

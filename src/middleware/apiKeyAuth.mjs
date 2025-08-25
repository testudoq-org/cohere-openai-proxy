import { createRequire } from 'module';
const require = createRequire(import.meta.url);
// small, dependency-free API key middleware that reads ADMIN_API_KEY from env
export function apiKeyAuth(req, res, next) {
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) return next(); // no auth configured in env => allow through (safe for local/dev)
  const header = (req.headers && (req.headers['x-api-key'] || req.headers['authorization'])) || '';
  const token = String(header || '').replace(/^Bearer\s+/i, '');
  if (token === adminKey) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

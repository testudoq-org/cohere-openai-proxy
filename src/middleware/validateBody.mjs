import { createRequire } from 'module';
const require = createRequire(import.meta.url);
let zod;
try {
  zod = require('zod');
} catch (e) {
  zod = null;
}

let validateBody;
if (!zod) {
  // zod not installed yet — passthrough validator
  validateBody = (schema) => (req, res, next) => next();
} else {
  const { ZodError } = zod;
  validateBody = (schema) => (req, res, next) => {
    try {
      schema.parse(req.body);
      return next();
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(400).json({ error: 'Invalid request', issues: err.errors });
      }
      return res.status(400).json({ error: 'Invalid request' });
    }
  };
}

export { validateBody };

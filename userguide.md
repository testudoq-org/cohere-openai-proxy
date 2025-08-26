# User Guide: Prompt Optimization Assistant

## Overview
This assistant specializes in transforming user prompts into highly effective, detailed instructions for AI systems. It analyzes prompts for structure, clarity, specificity, and effectiveness, then rewrites them to maximize precision and desired outcomes.

## How to Use

1. **Start the Application**  
   - **Linux/macOS:** Run `./setup.sh` in your terminal.
   - **Windows:** Double-click `setup.bat` or run it from Command Prompt.
   - **Docker:**  
     1. Build: `docker build -t prompt-optimizer .`  
     2. Run: `docker run -d -p 3000:3000 --env-file .env prompt-optimizer`

2. **Submit Your Prompt**  
   Provide your original prompt. The assistant will analyze and optimize it.

3. **Review the Optimized Prompt**  
   The assistant will return an improved version, maintaining your intent but enhancing clarity, specificity, and structure.

4. **Implement or Further Refine**  
   Use the optimized prompt as-is or iterate further for your specific use case.

## Optimization Criteria

- **Clarity:** Removes ambiguity and vague language.
- **Specificity:** Adds context, constraints, and examples where needed.
- **Structure:** Organizes information logically, emphasizing key requirements.
- **Actionability:** Uses direct, actionable instructions.
- **Edge Cases:** Considers potential misinterpretations or exceptions.
- **Format:** Specifies desired output format and style.

## Example

**Original Prompt:**  
"Write a summary of this article."

**Optimized Prompt:**  
"Summarize the following article in 3-4 sentences, focusing on the main arguments and conclusions. Use clear, concise language suitable for a general audience. Exclude minor details and examples. Format the summary as a single paragraph."

## Developers: running tests and debugging agents

This section explains how to run unit tests, integration (API) tests, and how to manually verify HTTP agent behavior.

### Test organization

- Unit tests: `test/utils` and lightweight tests in `test/` — fast, do not open real sockets.
- Integration/API tests: `test/api` — exercise real HTTP servers and sockets, used to assert connection reuse and agent behavior.

### Run tests

Run all tests:

```powershell
npx vitest --run
```

Run only unit tests:

```powershell
npx vitest test/utils --run
```

Run only integration/API tests:

```powershell
npx vitest test/api --run
```

Run a single test file:

```powershell
npx vitest test/api/agent-http-injection.test.mjs --run
```

### Agent opt-in behavior

This project exports `httpAgent` and `httpsAgent` from `src/utils/httpAgent.mjs`. Prefer passing these agents directly to SDK constructors. Mutating Node's `http.globalAgent` and `https.globalAgent` is opt-in and controlled by the environment variable `OUTBOUND_USE_GLOBAL_AGENT`. By default this behavior is disabled.

To enable global agent mutation (not recommended for general use, but useful in some integration environments):

```powershell
$env:OUTBOUND_USE_GLOBAL_AGENT = '1'
node src/index.mjs
```

### Manual debug script

To manually observe socket reuse and agent injection, create `scripts/debug-agent-injection.mjs` with the following contents (or ask me to add it):

```javascript
import http from 'http';
import { httpAgent, applyGlobalAgents } from '../src/utils/httpAgent.mjs';

function logGlobalStatus() {
   console.log('http.globalAgent === httpAgent ?', http.globalAgent === httpAgent);
}

async function run() {
   console.log('Initial global agent status:');
   logGlobalStatus();

   console.log('\nForcing applyGlobalAgents(true)...');
   applyGlobalAgents(true);
   logGlobalStatus();

   const srv = http.createServer((req, res) => res.end(String(req.socket.remotePort)));
   await new Promise(r => srv.listen(0, '127.0.0.1', r));
   const port = srv.address().port;

   function doReq(agent) {
      return new Promise((resolve, reject) => {
         const req = http.request({ hostname: '127.0.0.1', port, path: '/', method: 'GET', agent }, (res) => {
            let body = '';
            res.on('data', d => body += d.toString());
            res.on('end', () => resolve(Number(body)));
         });
         req.on('error', reject);
         req.end();
      });
   }

   const a1 = await doReq(httpAgent);
   const a2 = await doReq(httpAgent);
   console.log('WITH agent remote ports:', a1, a2);

   const b1 = await doReq(undefined);
   const b2 = await doReq(undefined);
   console.log('WITHOUT agent remote ports:', b1, b2);

   srv.close();
}

run().catch(e => { console.error(e); process.exit(1); });
```

Run it with:

```powershell
node scripts/debug-agent-injection.mjs
```

This helps demonstrate the effect of `httpAgent` vs default behaviour and whether `applyGlobalAgents` changed the process globals.
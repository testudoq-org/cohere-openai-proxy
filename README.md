# Prompt Optimization Assistant

## Latest Changes

- Added a comprehensive `userguide.md` detailing usage and optimization criteria.
- Enhanced prompt optimization approach to:
  - Maintain original intent while improving clarity and specificity.
  - Incorporate actionable instructions, context, and output format.
  - Address edge cases and eliminate ambiguity.
  - Provide examples and constraints for optimal AI performance.

## Approach

This assistant analyzes user prompts for clarity, structure, and effectiveness, then rewrites them to be self-contained, unambiguous, and highly actionable. The optimized prompts are designed to elicit precise, high-quality responses from AI systems.

## Usage

### Starting the Application

- **Linux/macOS:** Run `./setup.sh` in your terminal.
- **Windows:** Double-click `setup.bat` or run it from Command Prompt.
- **Docker:**  
  1. Build: `docker build -t prompt-optimizer .`  
  2. Run: `docker run -d -p 3000:3000 --env-file .env prompt-optimizer`

### Optimizing Prompts

1. Submit your original prompt.
2. Receive an improved, detailed version.
3. Use or further refine as needed.

See `userguide.md` for detailed instructions and examples.

## Connection reuse and agents

This project creates dedicated http/https agents for outbound connections and prefers passing them directly to SDK constructors to avoid mutating Node's global agents. If you need to apply these agents globally (for example in special integration environments), set `OUTBOUND_USE_GLOBAL_AGENT=1` in your environment; otherwise leave it disabled.

## Testing

This repo uses Vitest for tests. Tests are split so you can run quick unit tests or longer integration/api tests separately.

- Run the full test suite:

```powershell
npx vitest --run
```

- Run only unit tests (fast):

```powershell
npx vitest test/utils --run
```

- Run only API/integration tests (real sockets, slower):

```powershell
npx vitest test/api --run
```

- Run a single test file:

```powershell
npx vitest test/api/agent-http-injection.test.mjs --run
```

Notes:
- Integration tests under `test/api` open real sockets and may be slower. Run them separately in CI if you want a quick unit-only pipeline.
- If you see different behavior around socket reuse for "no explicit agent" requests, it may be caused by local/global agent mutation (controlled by `OUTBOUND_USE_GLOBAL_AGENT` or other test harnesses).


### Licence Summary

This project is licensed under a Fair Use Licence (based on CC BY-NC-SA 4.0
) with extra terms for commercial use.

✅ Free Use Allowed

Personal projects

Education & research

Government agencies

Religious/faith-based organisations

💼 Commercial Use (Private Companies & NGOs)
Users	Fee per user (USD)	Notes
1–100	$50	Standard tier
101–1000	$10	Bulk tier
1001+	Free	Donation optional
🏦 Banks & Financial Institutions
Users	Fee per user (USD)	Notes
1–100	$100	Double rate
101–1000	$20	Double rate
1001+	Free	Donation optional

Example: A bank with 1001 users pays $28,000 total.

🍯 Kiwi Honesty Box

We operate on trust and good faith.

Please self-report user counts

Pay fairly if you benefit from this software

Extra generous donations encouraged if it saves you big money

⚖️ Legal & Disclaimer Highlights

No Warranty: Provided as-is

Accuracy Warning: Outputs may be wrong — verify independently

No Professional Advice: Not a substitute for legal/financial/medical advice

Liability Limit: Author not liable for losses, damages, or unmet expectations

👉 Full details: LEGAL.md
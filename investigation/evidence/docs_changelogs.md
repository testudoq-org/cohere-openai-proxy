# API Changelog & Docs Excerpts (captured 2026-01-06)

## Cohere (docs.cohere.com)

> POST /v2/batches
>
> "Bear er authentication of the form `Bearer <token>`, where token is your auth token." 

> Headers: X-Client-Name (optional), Authorization (Bearer <token>), Content-Type: application/json

Source snippets captured from Cohere reference pages showing /v2/batches usage and header requirements. No explicit Aug-2025 breaking-change entry found in captured excerpts.

## OpenAI (platform_openai)

> curl https://api.openai.com/v1/responses \
>   -H "Content-Type: application/json" \
>   -H "Authorization: Bearer $OPENAI_API_KEY" \
>   -d '{
>     "model": "ft:gpt-4.1-nano-2025-04-14:openai::BTz2REMH",
>     "input": "What is the weather like in Boston today?",
>     "tools": [ ... ]
>   }'

> "truncation": "disabled"
> Description: "disabled: Request fails with 400 error if input exceeds context window"

> Deprecation note: Original fine-tuning endpoints deprecated (example dated Aug 22, 2023) — included for context; no additional Aug-2025 breaking entries captured in recent excerpts.

## RooCode / Roo Code

Search returned documentation references but no explicit changelog entries captured for breaking changes since Aug-2025 in the results returned. RooCode docs references present (general docs pages), but no exact quoted breaking-change lines were found in the captured snippets.

---

Notes:
- Captured excerpts are verbatim from queried documentation snapshots. Dates where present in excerpts are preserved; explicit Aug-2025 breaking-change items were not present in these captures.
- Next step: collect local runtime logs and metrics, and create repro scripts. Files produced so far: investigation/evidence/docs_changelogs.md

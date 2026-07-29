---
name: "paperless"
description: "Search the user's paperless-ngx documents by hybrid lexical+semantic query over OCR content. On-demand: find insurance, receipts, tax docs by year, etc."
---

# Paperless Search

Tools: `paperless_search_documents`, `paperless_get_document`, `paperless_search_document_content`, `paperless_read_document`, `paperless_list_taxonomy`

Facts:
- `paperless_search_documents`: never returns full OCR content — each result gets only a `content_snippet`.
- `paperless_get_document`: never returns raw content either — pass `excerpt_search` (needs doc id) for a short snippet around one term.
- `search` param = hybrid lexical+semantic, matches OCR content.
- Every result carries a `url` — always surface it, never omit.

Triggers: search/discovery over the doc archive — "find my car insurance policy", "receipt for that Ikea order", "tax documents from last year", etc.

## Procedure

1. `paperless_search_documents` + `search` = core concept. No pre-filtering — usually sufficient alone. Each hit → `content_snippet`.
2. Add filters only from constraints the user actually gave:
   - correspondent name → `paperless_list_taxonomy(kind: "correspondent")` → id (don't guess) → `correspondent_id`
   - date → `created_from` / `created_to` (`YYYY-MM-DD`)
   - tag → `paperless_list_taxonomy(kind: "tag")` → id → `tag_id` (single tag)
3. Zero results → broaden: synonyms, other likely languages, partial words, drop filters one at a time.
4. Present compactly: title, correspondent, date, doc id, `content_snippet`, `url` (as link, always).
5. `content_snippet_start_line`/`content_snippet_end_line` present (= semantic match) → use with `paperless_read_document` to jump straight to that section, don't read from the start.
6. Know the doc id, need one specific detail (amount/policy number/clause/date) → don't call `paperless_read_document` for the whole thing. Use `paperless_search_document_content`, pattern-match the term (e.g. `pattern: "Gesamtbetrag|Betrag|Summe|Total"` for a total); or `paperless_get_document`'s `excerpt_search` for a single simple term. `paperless_read_document` only for actually reading a section/whole document, not as a shortcut to extract one fact.
7. Multiple plausible matches → list for user to pick, never guess.

## Safety rules

- Never modify anything via this skill — updates are the user's call, via `paperless_update_document` on request.
- Never guess when multiple matches are plausible — present options.
- Never fabricate or assume document existence.

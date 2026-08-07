-- 023_product_translations.sql — per-tenant product content translations.
--
-- Storage: a single jsonb map on `product` keyed by ISO-639 language code,
-- with a partial content overlay per language:
--
--     {"ar": {"name": "…", "description": "…"}, "fr": {…}, …}
--
-- The current UI writes 'ar' only (docs/08-uae-localization.md §3), but the
-- shape is deliberately open so extra languages can be added without a schema
-- change. The base English `name` / `description` columns remain the source of
-- truth and the fallback — the public catalog returns the base fields when no
-- overlay exists for the requested language, so a shopper never sees a null.
--
-- CHECK: translations MUST be a jsonb object (never an array/string/null),
-- since the merge path assumes object semantics.

ALTER TABLE product
    ADD COLUMN translations jsonb NOT NULL DEFAULT '{}'
        CHECK (jsonb_typeof(translations) = 'object');

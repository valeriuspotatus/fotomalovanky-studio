# Shopify photo-authorization draft

Local/staging package only. Do not publish until the controller/contact/processor facts, retention wording, digital-withdrawal wording, and exact rendered theme change are owner-authorized and legally reviewed.

Observed live integration on 2026-08-22: Dawn-derived theme `t/6`, Easify Product Options (`tpo_*` controls), product `/products/fotomalovanky`, and Shopify line-item properties. Render `snippets/photo-authorization.liquid` once on that product template and upload the two assets. The script inserts the required authorization immediately before Easify's upload control, blocks file selection and cart submission while unchecked, writes versioned self-attestation evidence for every variant, and shows a separate PDF-only immediate-performance control.

The back office revalidates every field and the exact text hash and uses Shopify `createdAt` as the authoritative UTC order timestamp. Invalid evidence is held before download, generation, PDF creation, printing, or fulfillment.

# PACE product type schema and importer

Creates **Sobeys PACE Product v1** (`sobeys-pace-product-v1`) in commercetools. This is a schema importer, not an importer of product records. It uses the Product Types API directly for this single schema; it does not need the asynchronous Import API or an import container.

## Source coverage

The provided `products.json` contains 10 `hits`, covering four article/UOM pairs across six stores. `nbHits: 8652` describes the search result total, not the number of records supplied. The payload has Algolia-style search metadata. This schema is provisional and based only on the supplied sample.

Files:

- `sobeys-pace-product-type.json`: reviewed ProductTypeDraft with 64 custom attributes.
- `pace-field-mapping.json`: source paths, types, required attributes, field profile, and deferred nutrition fields.
- `../scripts/import-product-type.ts`: CLI entry point.
- `../src/catalog/product-type-importer.ts`: validation and safe repeatable import.

## Run

```sh
npm run catalog:product-type -- --dry-run
npm run catalog:product-type -- --apply
```

The default mode is dry-run. It validates the committed schema without network requests or writes. Apply uses the existing `.env` commercetools credentials; Google configuration is not required. API Client and requested scopes must include `manage_product_types:<project-key>`, `manage_products:<project-key>`, or the trial's existing `manage_project:<project-key>`.

Apply reads by key, creates if missing, or reports `unchanged` if the existing schema matches. Attribute ordering and extra API fields do not cause drift. It fails if the schema differs; it never deletes attributes, changes existing types, or writes products. A concurrent create conflict is resolved by reading the type again. Creation is not automatically retried on timeouts because a write might already have succeeded; rerun after verifying the project. Credentials and raw upstream error bodies are never printed.

View the result in Merchant Center under **Settings → Product types and attributes** (wording/navigation can vary by Merchant Center version). Search for **Sobeys PACE Product v1**.

## Schema choices

Identifiers (`articleNumber`, `uom`, `upc`) use text to retain leading zeros. `pace-articleNumber` and `pace-uom` are required; other attributes are optional because the sample is partial. Attribute names use the `pace-` prefix to reduce collisions with existing project-wide attribute definitions. All are explicitly variant attributes; a later catalog design can review product-level placement when grouping related SKUs.

Dietary/allergen flags are flattened boolean attributes such as `pace-allergens-glutenFree`. Do not interpret false as proof that an allergen is present: retain the source value without inventing semantics. Populated nutrition fields become optional number/text/set-of-text attributes. Ingredients and nutrition text are non-searchable to avoid large searchable attributes. Sets do not retain ordering/duplicates; confirm whether ingredient ordering should instead be preserved in localized ingredient text before importing real products.

Future product value transformation must omit nulls, preserve false and zero, and normalize the source `seasonedRequired` string (`"true"`/`"false"`) into a boolean. Numeric-looking strings such as `itemAmountValue` and `catchWeightMin` remain text until units and semantics are confirmed. Nutrition fields that are always null are deferred rather than guessed. Packaging `weight` remains text (for example `2.586 KG`), pending a weight/unit model.

This sample contains nutrition-like zero values and ingredient-like marketing copy for non-food products. Validate source semantics with the data owner before treating those values as genuine nutrition/ingredients. English labels are technical source paths; product content localization and French labels need a separate decision.

## Standard product fields and separate resources

| Source | Future mapping |
| --- | --- |
| `name`, `description` | Localized product fields; confirm source locale |
| `pageSlug`, `slugTranslation` | Localized product slugs; confirm locales |
| `articleNumber` + `uom` | Proposed SKU `articleNumber_uom`, subject to PACE identity confirmation |
| `images` | Variant images; deduplicate original/screen/thumb renditions |
| `categories`, `hierarchicalCategories` | Category tree and references; do not create a Product Type per category |
| `price`, `storeId`, `channel`, `priceQuantity` | Store/channel-aware pricing with explicit currency and quantity semantics |
| `inventoryLevel`, `inStock` | Inventory entries per supply channel after clarifying contradictory source values |
| `promotions`, discount fields, `activePromotion`, `isMassOffers`, `scenePlusPoints`, `persoOffer` | Promotions/loyalty mapping; not authoritative catalog prices or generic attributes |
| `taxes` | Tax category/rate or external tax classification mapping after business-rule confirmation |
| `isVisible` | Publication/store assortment decision, not assumed global publication |
| `linkeditem`, `linkedItems` | Relationship modeling after semantics are clarified |
| `objectID` | Search record identity, not automatically a product/SKU identity |
| Source `createdAt`, `updatedAt` | Source metadata if needed; not commercetools system timestamps |
| `_snippetResult`, `_highlightResult`, facets, pagination | Search metadata; excluded |
| Null-only top-level fields | Deferred until populated source examples establish type/meaning |

The same article/UOM appears in multiple stores. Do not create separate products just because `objectID` or `storeId` differs. Resolve product identity, store availability, pricing, and inventory channel design before product import. Promotion `currencyCode: CAD` is not sufficient evidence that every base price has the same currency; confirm an explicit currency contract.

## References

- [Product Types API](https://docs.commercetools.com/api/projects/productTypes)
- [Product catalog overview](https://docs.commercetools.com/api/product-catalog-overview)
- [Product Type Import API](https://docs.commercetools.com/api/import-export/import-requests)

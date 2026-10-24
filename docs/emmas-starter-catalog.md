# Emma's Chicken House starter catalog

This catalog configures exactly **Cebu**, **Manila**, and **Davao**, each with
dine-in and takeout service. Addresses identify the city only; opening dates are
left unset until the actual branch details are supplied.

The catalog contains 40 stock items, 28 products, 84 branch-menu entries, and
141 recipe lines. Every product is available at all three branches with the
same PHP price. It covers original/spicy roast chicken, crispy fried chicken,
chicken buckets, six chicken rice meals, two family meals, sides, and drinks.
These are Emma's starter offerings, not another restaurant's official menu.

## Stock and portions

- Whole roasting chickens, standard frying cuts, and leg quarters use pieces.
  Fillets and chicken skin use kilograms. These are separate purchasing or
  dispatch units; do not record the same bird under both whole and cut stock.
- Roast products consume one, half, or one quarter of a whole chicken. Fried
  products consume their stated number of standard cuts. Rice uses 65 g dry
  rice per serving; fillet meals use 150 g raw fillet. Ready-to-use marinades
  and gravy are tracked independently from their constituent ingredients.
- Takeout boxes, buckets, cups, wrappers, and cutlery are deducted only for
  takeout sales. Dine-in assumes reusable plates, glasses, and utensils.
- Daily physical counts cover 11 items: five chicken stock items, uncooked
  rice, breading mix, frozen fries, and three packaged beverages. Low-value
  condiments, sauces, packaging, and cleaning supplies are excluded.
- COMS deducts recipes at sale time, not when food is cooked. Closing counts
  must include unsold prepared chicken and cooked rice in the corresponding
  raw-stock equivalents, plus uncooked stock. Do not count cooked food again
  as a separate stock item. Record actual spoilage through the normal workflow.

Prices, marinade quantities, cooking yields, and oil consumption are editable
starter standards. Validate them against actual portioning and purchasing.
No estimated supplier costs are written, so cost coverage stays incomplete until
real receipt costs or deliberate manual costs are recorded.

## Applying the catalog

Use `scripts/emmas-chicken-catalog.cjs` as the editable data definition and
`scripts/populate-emmas-catalog.cjs` as the transactional importer. It does not
change schema or run migrations. The existing local Philippine sample-data
command is separate and must not be used for this three-branch production setup.

Before applying, identify the target and take a backup outside the repository
and knowledge vault. Restore the backup to a disposable local database and
rehearse the import. Supply the connection through an ignored environment file
or the process environment; do not put credentials into command-line arguments.

```powershell
node scripts/populate-emmas-catalog.cjs --env-file=.env.production --expected-host=<verified-host> --expected-database=postgres --check
node scripts/populate-emmas-catalog.cjs --env-file=.env.production --expected-host=<verified-host> --expected-database=postgres --apply
```

The default is a rolled-back dry run. Application is atomic, attributed to the
existing active Super Admin, and guarded by explicit target checks and catalog
locks. It refuses a partial or unrelated catalog. Repeating an intact import is
a no-op; it never overwrites later edits. If a later edit changes catalog counts
or recipe/menu completeness, verification refuses instead of repairing it.

The importer verifies shared prices, services, recipes, repeat-run behavior,
and fingerprints of unrelated COMS tables. Existing users and credentials,
operational transactions, inventory, costs, and access controls are preserved.
It creates no staff accounts, sales, receipts, dispatches, reports, or opening
balances. Record real stock through receiving or a reasoned inventory adjustment
before using stock availability for dispatch planning.

# Local branch daily-count policy — 2026-10-23

Applied at the user's request to the 43 active stock items in local `coms-db`. Kept 27 enabled for daily counts and changed 16 to periodic counting. This is an operational starting policy based on current item names, units, costs and recorded recipe use, rather than a permanent rule inferred from categories.

## Daily counts — 27 items

| Group                     | Items                                                                                                                                           | Reason                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Meat and poultry          | Chicken Unit; Chicken Leg Quarter; Beef Brisket; Pork Belly                                                                                     | Core food cost and quantity accountability.                                                 |
| Seafood                   | Boneless Bangus; Medium Shrimp; Tilapia                                                                                                         | Valuable, perishable food stock.                                                            |
| Commissary preparations   | Adobo Sauce Base; Beef Tapa - Marinated; Lumpiang Shanghai - Frozen; Marinated Chicken Inasal; Pork Sisig Mix; Pork Tocino; Skinless Longganisa | Track prepared batches and sale portions received from the commissary.                      |
| Staples                   | Dinorado Rice; Jasmine Rice; Cooking Oil                                                                                                        | High-use stock with meaningful daily consumption.                                           |
| Eggs and milk             | Chicken Eggs - Large; Condensed Milk 300ml; Evaporated Milk 370ml                                                                               | Countable units used in meals, drinks and desserts.                                         |
| Drinks                    | Bottled Water 500ml; Cola 330ml                                                                                                                 | Individually sold units.                                                                    |
| Fresh primary ingredients | Ripe Mango; Kangkong                                                                                                                            | Perishable primary ingredients; weigh remaining stock in the recorded unit.                 |
| Main serving containers   | Cold Cup with Lid 16oz; Kraft Meal Box 750ml; Paper Bowl with Lid 500ml                                                                         | Countable containers linked to served products; a useful cross-check alongside food counts. |

## Periodic counts — 16 items

| Group                             | Items                                                                               | Reason                                                                                                                  |
| --------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Seasonings                        | Brown Sugar; Cane Vinegar; Fish Sauce; Ground Black Pepper; Iodized Salt; Soy Sauce | Partial bulk containers and small-use quantities make daily physical measurement burdensome.                            |
| Aromatics and garnish ingredients | Calamansi; Garlic; Ginger; Red Onion; Tomato                                        | Periodic stock measurement; continue routine freshness checks separately.                                               |
| Other dry ingredients             | Flour                                                                               | No current branch stock or recipe usage recorded during the review. Reassess if it becomes a primary branch ingredient. |
| Supplies and secondary packaging  | Dishwashing Liquid; Plastic; Table Napkin; Wooden Spoon and Fork Set                | Lower-value operational supplies and secondary packaging.                                                               |

Periodic means excluded from the daily report, not automatically scheduled. Use manual physical counts and reasoned inventory adjustments, initially on a weekly stocktake or replenishment check. Quantities remain in each item's existing unit; there were no unit, recipe or category changes.

## Application and verification

- Used an explicit allowlist matching every current item by its exact name; refused execution if the 43-item active catalog differed.
- Saved the original settings and planned values in a timestamped JSON recovery record under `Documents/COMS Backups`, outside the repositories and vault.
- Updated only the 16 changed `daily_count_required` values and their update timestamps, in one transaction.
- Existing row triggers audited the changes. A batch audit event `stock_item.daily_count_policy_applied` identifies the operation as user-requested local maintenance; no staff identity was impersonated.
- Verified all 43 resulting settings and unchanged hashes/row counts for branch inventory, commissary inventory, inventory movements, daily reports, report items and recipes.
- Existing report snapshots retain their original count requirements. The new policy applies only when new reports are created, across all branches.
- No application code, schema, seed defaults or production database was changed by this maintenance operation.

---
name: financial-modeling
description: Build, refactor or review spreadsheet financial models with traceable assumptions, calculation blocks, consistent timelines and validated outputs. Use for forecasts, budgets, valuations or financial workpapers where formula structure and maintainability matter.
---

# Financial modeling

Build models that another person can understand, change and reconcile. Use the FAST approach demonstrated by F1F9: each calculation block has its ingredients above one result, and periods run across columns. These are modeling conventions, not a certification of FAST compliance. Attribution and example-model observations are in [references/sources.md](references/sources.md).

## Establish the model contract

Identify the decision or report the model supports, required outputs, entities, ownership basis, currency, units, period frequency and source records. Distinguish actuals, forecasts, scenarios and unresolved assumptions. Preserve the user's chosen reporting layout and accepted business rules; restructuring formulas should not silently change their treatment.

Inspect existing formulas, timelines and source conventions before editing. For a refactor, preserve a baseline of source inputs and key outputs so the structural change can be reconciled. Derive aggregates from canonical records; detailed evidence and overlapping statements support those records rather than adding to them again.

## Structure the workbook

Give each sheet a clear role. For a substantial model, the logical flow is **Inputs → Time / foundation → Workings → Outputs**, with checks visible near their results. A cover or comparison sheet may come first for navigation. Small models can keep these as clearly separated sections within one sheet.

- **Inputs:** assumptions and source figures, recorded once with units, provenance and status. Put constants in a dedicated column and period-varying inputs against their timeline. Keep raw transaction evidence in a separate table when its grain differs from the model.
- **Time / foundation:** one canonical timeline, period starts/ends, actual/forecast boundaries, activity flags and exposure fractions. State whether boundaries are inclusive and whether the denominator is actual days, a contract basis or another convention. Calculate timing once and link it into the relevant blocks.
- **Workings:** blocks that own one calculation each. Put only the ingredients needed for that result above it; place the output at the bottom, visually separated from the next block. A schedule with several outputs, such as claim and closing balance, uses separate blocks.
- **Outputs:** direct links to calculated results, reporting subtotals and comparisons. Keep business calculations in Workings so the same result can feed several reports without duplicating its logic.

Keep label, unit, constant and timeline columns in consistent positions across calculation sheets. Use descriptive labels that specify the entity and basis when ambiguous, such as whole-asset versus owner share, or cash proceeds versus taxable gain. Visually distinguish inputs, ingredient links, calculations and unresolved values with a small documented legend. Keep the periods and labels visible while scrolling.

## Construct calculation blocks

Read [references/calculation-blocks.md](references/calculation-blocks.md) when building blocks or refactoring a long formula; it contains original, fictional formula examples.

1. Link each ingredient directly from its original input or the block that calculates it. Repeated ingredient links are intentional: they make each block readable in place. Keep the source value and calculation logic single-sourced; avoid chains of pass-through links.
2. Calculate the block's result from nearby ingredient cells. Split nested business decisions into explicit ingredients, timing or intermediate blocks rather than hiding them in one long formula. Simple arithmetic and ordinary functions usually make the relationship clearest; use more complex functions when the task warrants them.
3. Separate **how much** from **when**. Link the magnitude and an activity flag or exposure fraction into the block, then combine them locally. Flags describe eligibility or timing; they do not make unknown amounts become known zeroes.
4. Copy a consistent formula across the timeline. Anchor constant references and retain relative period references. An opening balance normally links to the preceding closing balance; initialization, actual/forecast boundaries and disposal periods are explicit exceptions. Mark formula-pattern exceptions so a reviewer can find them. Keep missing historical records visible rather than fabricating a roll-forward.
5. Record signs and units before combining values. Signed cash schedules can use receipts positive and payments negative; a report can show deduction magnitudes when required. Label that reporting conversion. Keep allocation percentages, exchange rates and tax assumptions in identified inputs rather than embedding unexplained business constants in formulas.

## Preserve missing-data semantics

A missing input remains unknown; a sourced zero remains zero. A direct Excel reference to an empty numeric cell returns zero, so preserve missingness in ingredient and output links when it matters, for example `=IF(COUNT(Inputs!$B$4)=1,Inputs!$B$4,"")`. Use the intended type check for text or date inputs; numeric zero is still valid.

For a complete total, validate the required operands before summing. Label a sum of available operands as a known or draft subtotal. Mark inapplicable entities or periods separately from unknown figures. A denominator of zero needs the chosen mathematical interpretation; suppressing all errors with `IFERROR(...,0)` conceals missing inputs and broken references.

## Validate the delivered model

Scale validation to the changed calculations. Check the actual saved workbook, not just its generating code:

- Reconcile canonical source amounts and existing key outputs against the preserved baseline. Explain intended differences and keep excluded evidence out of aggregates.
- Recalculate formulas with the target spreadsheet application or an independent formula engine. Cached values are a preview, not evidence that formulas work. If full recalculation is unavailable, state which checks were actually performed.
- On a copy, change a meaningful input and confirm the expected effect through the relevant Workings, Outputs and comparison totals. Restore or discard the test copy. Exercise important boundaries: zero versus missing, period endpoints, remaining-balance caps, denominator zero and entity isolation as applicable.
- Check formula patterns across periods and trace a representative output back to its source. Inspect visible errors, unresolved inputs, check differences and unintended external workbook links. Confirm the delivered format preserves formulas and navigation.

For reproducible generation, keep business rules separate from workbook layout and source-adapter code. Preserve an appropriate source snapshot or version reference, include enough calculation context to regenerate the model, and keep confidential records in the user's private store. Return the model link or path, what was validated, and remaining assumptions affecting its use.

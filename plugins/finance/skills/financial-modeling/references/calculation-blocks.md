# Calculation blocks

These examples are original and fictional. They assume the required numeric inputs and positive day-count basis have been validated. They illustrate a local layout, not tax or accounting treatment. Labels belong in a dedicated column, units alongside them, and the same periods occupy columns D, E and onward on Time and Workings.

## Editable workbook

[basic-calculation-blocks.xlsx](basic-calculation-blocks.xlsx) is a small, original example with Inputs, Time, Workings and Outputs. Its three chronological periods share the same column positions. It contains an amount × exposure block, a capped balance reduction, a separate closing-balance block and a numeric reconciliation. Outputs links to the results and uses a plain `SUM` subtotal. All example amounts and rates are fictional.

Inspect `Workings!D12`, `D26` and `D36` and compare their formulas across columns D:F. The opening formula uses an explicit first-period flag, so its pattern stays consistent: `=IF(D20,$C21,C36)`. The first timeline value is initialization; later timeline values advance by one period. The workbook uses yellow fill for entered inputs, blue font for imports, red font for exported calculations and black for local calculations, with a legend on Inputs. The example has no VBA or external workbook links. It illustrates selected FAST conventions, not a complete compliance certification.

Change `Inputs!C5` to see the allocated expense and report subtotal update. Change the opening balance in `Inputs!C7` to zero: the reduction and closing balance stay zero. The saved example was independently recalculated, checked for consistent period formulas and tested with those edits. Keep real financial records outside the skill.

Monetary cells use `#,##0.00;(#,##0.00);0.00`: negative amounts display in parentheses, zero displays as `0.00`, and font colours retain their input/link/calculation meaning. The stored values remain signed numbers. This is the example's display convention, not a claim that FAST requires this exact number format.

## Allocation: amount × exposure

Suppose Inputs has a source amount in B4 and a documented day-count basis in B7. Time calculates eligible days for each period in row 25. State the coverage boundaries before calculating those days; a fraction of a year and an on/off flag represent different assumptions.

First build a fraction block on Time:

| Row | Ingredient / output | D formula |
| --- | --- | --- |
| 28 | Eligible days, days | `=D25` |
| 29 | Day-count basis, days | `=Inputs!$B$7` |
| 31 | **Exposure fraction, fraction** | `=D28/D29` |

Then allocate the amount in a separate Workings block:

| Row | Ingredient / output | D formula |
| --- | --- | --- |
| 9 | Source amount, currency | `=Inputs!$B$4` |
| 10 | Exposure fraction, fraction | `=Time!D31` |
| 12 | **Allocated amount, currency** | `=D9*D10` |

Copy the period formulas right: the source constant remains `$B$4`; the Time link advances to `E31`. The result uses local operands. Outputs links directly to `Workings!D12`. It does not rebuild the allocation formula.

## Balance roll-forward: separate claim and closing blocks

Inputs B10 contains an initial asset balance and B11 the agreed annual declining-balance rate. Time row 31 supplies exposure. Assume a nonnegative opening balance, rate and exposure, with no additions or disposals in this example; a real model includes those movements explicitly.

Claim block on Workings:

| Row | Ingredient / output | First period D | Next period E |
| --- | --- | --- | --- |
| 21 | Opening balance | `=Inputs!$B$10` | `=D33` |
| 22 | Annual rate | `=Inputs!$B$11` | copy right |
| 23 | Exposure fraction | `=Time!D31` | copy right |
| 25 | **Claim** | `=MIN(D21,D21*D22*D23)` | copy right |

Closing block on Workings:

| Row | Ingredient / output | First period D | Next period E |
| --- | --- | --- | --- |
| 29 | Opening balance | `=Inputs!$B$10` | `=D33` |
| 30 | Claim | `=D25` | copy right |
| 33 | **Closing balance** | `=D29-D30` | copy right |

The two blocks repeat direct ingredient links, not the claim calculation. The claim is capped at the opening balance. The next opening links to the previous calculated closing, with the first period clearly marked as initialization. Source validation establishes the numeric opening, rate and exposure. A zero closing remains a valid zero. A prime-cost rule, additions, disposal or a policy cap needs its own documented business logic.

## Comparisons and checks

Compare aligned periods, currencies and ownership bases. An entity-by-category comparison can use direct output links even when the detailed calculations have periods across columns. Use `=SUM(D9:F9)` for a total of the validated ingredients. A genuinely partial subtotal sums available figures and carries an explicit draft label.

Place a check beside its result, such as opening + additions − reductions − closing, with the expected zero and a stated tolerance. Use numeric checks that establish a meaningful reconciliation. Validate source completeness once when preparing the model; add a separate completeness flag only for a documented case that can occur and affect the result. Test a meaningful input change, and test missingness when that is a supported state.

## An actual missing input

If a forecast depends on an outstanding quote, its cost is unknown. Preserve that input with `=IF(ISNUMBER(Inputs!B4),Inputs!B4,"")` where required by the model. Keep the unresolved quote explicit until supplied. This exception does not require count wrappers around every populated block or report total.

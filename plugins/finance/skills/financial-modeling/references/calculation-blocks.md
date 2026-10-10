# Calculation blocks

These examples are original and fictional. They illustrate a local layout, not tax or accounting treatment. Labels belong in a dedicated column, units alongside them, and the same periods occupy columns D, E and onward on Time and Workings.

## Allocation: amount × exposure

Suppose Inputs has a source amount in B4 and a documented day-count basis in B7. Time calculates eligible days for each period in row 25. State the coverage boundaries before calculating those days; a fraction of a year and an on/off flag represent different assumptions.

First build a fraction block on Time:

| Row | Ingredient / output | D formula |
| --- | --- | --- |
| 28 | Eligible days, days | `=IF(COUNT(D25)=1,D25,"")` |
| 29 | Day-count basis, days | `=IF(COUNT(Inputs!$B$7)=1,Inputs!$B$7,"")` |
| 31 | **Exposure fraction, fraction** | `=IF(AND(COUNT(D28:D29)=2,D29>0),D28/D29,"")` |

Then allocate the amount in a separate Workings block:

| Row | Ingredient / output | D formula |
| --- | --- | --- |
| 9 | Source amount, currency | `=IF(COUNT(Inputs!$B$4)=1,Inputs!$B$4,"")` |
| 10 | Exposure fraction, fraction | `=IF(COUNT(Time!D31)=1,Time!D31,"")` |
| 12 | **Allocated amount, currency** | `=IF(COUNT(D9:D10)=2,D9*D10,"")` |

Copy the period formulas right: the source constant remains `$B$4`; the Time link advances to `E31`. The result uses local operands. Outputs links directly to `Workings!D12`, preserving blankness where required. It does not rebuild the allocation formula.

## Balance roll-forward: separate claim and closing blocks

Inputs B10 contains an initial asset balance and B11 the agreed annual declining-balance rate. Time row 31 supplies exposure. Assume a nonnegative opening balance, rate and exposure, with no additions or disposals in this example; a real model includes those movements explicitly.

Claim block on Workings:

| Row | Ingredient / output | First period D | Next period E |
| --- | --- | --- | --- |
| 21 | Opening balance | `=IF(COUNT(Inputs!$B$10)=1,Inputs!$B$10,"")` | `=IF(COUNT(D33)=1,D33,"")` |
| 22 | Annual rate | `=IF(COUNT(Inputs!$B$11)=1,Inputs!$B$11,"")` | copy right |
| 23 | Exposure fraction | `=IF(COUNT(Time!D31)=1,Time!D31,"")` | copy right |
| 25 | **Claim** | `=IF(COUNT(D21:D23)=3,MIN(D21,D21*D22*D23),"")` | copy right |

Closing block on Workings:

| Row | Ingredient / output | First period D | Next period E |
| --- | --- | --- | --- |
| 29 | Opening balance | `=IF(COUNT(Inputs!$B$10)=1,Inputs!$B$10,"")` | `=IF(COUNT(D33)=1,D33,"")` |
| 30 | Claim | `=IF(COUNT(D25)=1,D25,"")` | copy right |
| 33 | **Closing balance** | `=IF(COUNT(D29:D30)=2,D29-D30,"")` | copy right |

The two blocks repeat direct ingredient links, not the claim calculation. The claim is capped at the opening balance. The next opening links to the previous calculated closing, with the first period clearly marked as initialization. A missing opening or claim propagates as missing. A zero closing remains a valid zero. A prime-cost rule, additions, disposal or a policy cap needs its own documented business logic.

## Comparisons and checks

Compare aligned periods, currencies and ownership bases. An entity-by-category comparison can use direct output links even when the detailed calculations have periods across columns. Required totals can use `=IF(COUNT(D9:F9)=C9,SUM(D9:F9),"")`, where C9 is the expected number of applicable numeric operands. A known subtotal instead sums available figures and carries an explicit draft label.

Place a check beside its result, such as opening + additions − reductions − closing, with the expected zero and a stated tolerance. Use numeric checks for reconciliation and separate completeness flags for missing inputs: a zero difference on a partial dataset does not prove completeness. Test both a meaningful input change and a missing operand through the saved formulas.

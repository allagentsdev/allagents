# Sources and attribution

This skill contains original instructions and fictional formula examples informed by the following sources. It selects practical modeling conventions; it does not reproduce a complete standard or claim certification or endorsement.

- [F1F9: FAST financial modelling](https://www.f1f9.com/fast-financial-modelling/) explains ingredient rows above one calculation result, aligned horizontal timelines, consistent line-item roles, and separate magnitude and timing logic.
- [F1F9: example models](https://www.f1f9.com/example-models/) offers a corporate forecasting example and a project-finance example. Use public sample files for inspection; keep third-party workbooks outside this plugin and do not execute their macros.
- [FAST Standard Organisation](https://fast-standard.org/) describes Flexible, Appropriate, Structured and Transparent modeling.
- [FAST Standard 02c, July 2019](https://www.fast-standard.org/wp-content/uploads/2019/10/FAST-Standard-02c-July-2019.pdf), by the FAST Standard Organisation, is published under [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/). The skill paraphrases a selection of its design principles and adds missing-data, provenance, reproducibility and validation guidance; it is not a verbatim copy. This dated reference is not a claim that later revisions do not exist.

A model's business assumptions still determine its correctness. Structural conventions do not establish an accounting or tax treatment, an investment recommendation or source completeness. Use the user's accepted domain rules and the relevant source evidence alongside this skill.

## Sample-model observations

Inspected on 10 October 2026 through the public download links on F1F9's example-model page:

- [Corporate Model 01a (XLSX)](https://www.f1f9.com/wp-content/uploads/2026/02/F1F9-Example-Corporate-Model-01a.xlsx): `Rev!L60` combines a constant, growth and timing ingredients; monthly columns run horizontally. `Time!L27` distinguishes initialization from the next month. `Profit&Cash!L18` links the prior closing balance from `K21` into the next period's calculation.
- [Renewables Model 01a (XLSM)](https://www.f1f9.com/wp-content/uploads/2026/02/F1F9-Example-Renewables-Model-01a.xlsm): `M-Devex!F9` imports an assumption from `Input!F48`, `M-Devex!L13` imports a timing flag from `M-Time!L60`, and `M-Devex!L16` combines the local constant and flag. `Repayment!L43` imports the prior closing balance from `K46` before `L46` calculates the next closing balance.

These are observations of workbook structure, not independently validated business assumptions or calculations. The macro-enabled sample was inspected as spreadsheet data without executing VBA. The third-party files are not bundled with this plugin; the calculation-block examples in this skill were written separately with fictional inputs.

# Animation plans

| # | Plan | Severity | Status |
| --- | --- | --- | --- |
| 001 | [Make recurring motion instant](./001-make-recurring-motion-instant.md) | HIGH | DONE |
| 002 | [Clarify occasional state arrivals](./002-clarify-occasional-state-arrivals.md) | MEDIUM | DONE |

Execute 001 before 002. Removing motion from high-frequency paths establishes
the frequency rule; 002 then spends the motion budget only on occasional state
changes. The plans share no implementation dependency beyond the existing
motion token group.

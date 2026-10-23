# T-00-target-reuse

## Objective

Run Module 00 on a known indexed project and on a query with no result. Pass when each yields a timestamped target-reuse record before Module 02; the first may be TARGET_ALREADY_SOLVED and the second records `no_match_found_in_searched_sources` with query scope, timestamp and search limitations.

## Result format

Record `PASS` or `FAIL`, commands/fixtures used, observed output, and any skipped check with its reason. Do not convert a skipped test into a pass.

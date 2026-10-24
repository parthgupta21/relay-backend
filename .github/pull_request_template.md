## Summary

<!-- What changes and why. Link the issue if there is one. -->

## How tested

<!-- Commands run and tests added. -->

## Checklist

- [ ] `npm test` passes
- [ ] `npx prettier --check .` passes
- [ ] New behavior has tests; no comments added to code
- [ ] Schema changes ship as a new sequelize-cli migration, never an edit to an existing one
- [ ] Queries on tenant data are scoped to the workspace and return 404 when not owned
- [ ] `memory.md` updated if a decision, contract or known gap changed

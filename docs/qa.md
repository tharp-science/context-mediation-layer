# QA

Run these checks before sharing a pilot repo.

## Build And Tests

```sh
npm run build
npm test
npm run lint
npm run typecheck:tests
npm run smoke:local
```

`npm run lint` type-checks `src` only. `npm run typecheck:tests` covers the test
tree as well and carries a known pre-existing baseline of 39 errors, all
`unknown`-typed JSON handling in the UI and MCP tests; treat any increase as a
regression rather than the absolute count as a failure.

## Secret Scan

Run a lightweight pattern scan:

```sh
rg -n -I --pcre2 '(AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN (RSA |DSA |EC |OPENSSH |)PRIVATE KEY-----)' -g '!.git/**' -g '!node_modules/**' -g '!dist/**'
rg -n -I '(?i)(api[_-]?key|secret|token|password|passwd|client[_-]?secret|private[_-]?key|bearer|authorization)' -g '!.git/**' -g '!node_modules/**' -g '!dist/**'
```

If available, also run:

```sh
gitleaks detect --source .
trufflehog filesystem .
```

## Publish Boundary

Do not publish:

- `.env` files other than `.env.example`
- local SQLite databases and WAL/SHM files
- generated `dist/`, coverage, logs, and temp files
- internal runbooks
- architecture diagrams carrying internal deployment detail
- contract drafts that belong to a private operating environment

## Untracked Files

```sh
git status --short
git ls-files --others --exclude-standard
```

Review every untracked file before export.

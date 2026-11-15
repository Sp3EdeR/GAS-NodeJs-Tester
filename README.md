# GAS-NodeJs-Tester
This is a small Node.js test environment for running [my Google Apps Scripts](https://github.com/Sp3EdeR?tab=repositories&q=GAS+Event-Sync). It does not have a complete API or simulation FW.

## Local Online Runner

Node.js 22 or newer is required.

Run `node test/run-gas.cjs <entry_function>` with Node.js 22 or newer to execute the specified function with all project scripts loaded from the CWD.

Use `--src` and `--trgt` to filter the `sourceCalendars` array. Select source mappings with case-sensitive JavaScript regular expressions, for example `node test/run-gas.cjs --src <provider_url_fragment> --trgt <calendar name fragment>`. Unanchored patterns match substrings; use `^...$` for exact matches. Both filters must match when provided. An omitted or empty-string filter keeps all values for that field. Both arguments are pre-filled with empty strings in the VS Code launch configuration; edit their values to select what runs. The log reports how many mappings were selected.

Source HTTP requests are live, including POST requests. Calendar event reads always return an empty calendar, and calendar writes log their complete payloads without contacting Google. Properties, spreadsheets, Drive discovery, triggers, email and Tasks are emulated locally; state is discarded after each run. Spreadsheet formulas are stored, not evaluated, and triggers are recorded, not scheduled. Maps geocoding reports `REQUEST_DENIED` because the emulator has no Google credentials.

Output is mirrored to the console and [run-gas.log](test/run-gas.log) is overwritten on each run.

## EML-Backed Gmail

Install dependencies with `npm install --prefix test` from the parent project directory only when using the EML-backed Gmail module. Both the command-line runner and programmatic `createContext` calls load the Gmail module and EML fixtures only on first access to the context's `Gmail` property. Functions that never access Gmail need no npm dependencies.

The runner loads every `*.eml` file from `${CWD}/test-mails` by default. Select a different directory with `--eml-dir <directory>`, for example:

```sh
node test/run-gas.cjs processEventFeed --eml-dir "test-mails"
```

A missing directory means an empty inbox; an explicitly selected missing directory fails when Gmail is first accessed.

By default messages receive INBOX and the nested `Értesítők/Események` label. An optional comma-separated `X-Gmail-Labels` header overrides this assignment. No request is sent to Gmail and no EML file is changed.

# UI & CLI research — local package manager plugin (winget / npm / pnpm / bun)

Scope: interaction patterns of shipping GUIs, and the **exact** CLI contract we may rely on when parsing. Verified 2026-11-05 on Windows 11 with **winget v1.29.380, npm 11.16.0, pnpm 10.33.2, bun 1.3.14** (all sample output below is captured from that machine). Anything not reproduced locally is marked **unverified**.

---

## 1. GUI references

### 1.1 UniGetUI (formerly WingetUI, now under Devolutions)
- Windows-first GUI over WinGet, Chocolatey, Scoop, pip, npm, Bun, .NET tool, PowerShell Gallery, etc. ([README](https://github.com/Devolutions/UniGetUI)).
- **Tab model:** left sidebar (Install → then Packages) with **Software Updates** and **Installed Packages**, plus Discover/search; legacy UI used **Installed / Updates / Discover** ([update-software help](https://www.marticliment.com/unigetui/help/update-software), [discussion](https://github.com/Devolutions/UniGetUI/discussions/2901)).
- **Search**: single search box **top-right**, Enter to run ([install-a-program help](https://www.marticliment.com/unigetui/help/install-a-program)).
- **Row operations**: right-click context menu → **Update** / **Ignore updates for this package** / **Skip this version**; multi-select + **Update selected packages**; possible admin-rights confirmation dialog ([update-software help](https://www.marticliment.com/unigetui/help/update-software)).
- **Bulk**: bulk install / update / uninstall by multi-selecting rows; "Update All" is the selection-then-action pattern, not a separate mode ([README features](https://github.com/Devolutions/UniGetUI)).
- **Details view**: per-package metadata, publisher, **download size**, screenshots from a shared icon DB ([icons doc](https://www.marticliment.com/unigetui/help/icons-and-screenshots)).
- **Progress/log**: "operation history" keeps the **1,000 most recent operations, up to 5,000 log lines each** ([README](https://github.com/Devolutions/UniGetUI)).
- **Column customization**: package-list columns are user-selectable via right-click on the list header ([release notes](https://devolutions.net/unigetui/release-notes/)).
- **Status colors**: tray icon encodes state — **Grey = no updates, Green = updates available, Yellow = installing, Red = error** ([1.3.0 release notes](https://newreleases.io/project/github/Devolutions/UniGetUI/release/1.3.0.0)).
- Typography/iconography tokens are **not documented** — unverified.

### 1.2 Chocolatey GUI (WPF)
- Layout is explicitly described as: **top navigation menu** (Settings / About / light-dark toggle), **main action bar** (search, check for outdated, refresh, update all, export, list↔tile toggle), **source tabs** — `This PC` (local) + one tab per configured remote source — a **version label**, and the **package list for the selected source** ([Main Window](https://docs.chocolatey.org/en-us/chocolatey-gui/user-interface/main-window/)).
- **Outdated check runs automatically on launch**; manual re-check via a dedicated button ([check-for-outdated](https://docs.chocolatey.org/en-us/chocolatey-gui/user-interface/main-window/actions/check-for-outdated/)).
- **Two search boxes** (local vs remote). Local search filters **as you type**; remote search needs Enter/click unless "Use Delayed Search" is enabled. Local filters: *Match Word Exactly*, **Show Only Packages with Updates**. Remote filters: All Versions, Include Prerelease, Match Word Exactly, Popularity ([search](https://docs.chocolatey.org/en-us/chocolatey-gui/user-interface/main-window/actions/search/)).
- **Update All** exists **only on the local source**, is **disabled with an explanatory tooltip** when nothing is outdated ([update-all](https://docs.chocolatey.org/en-us/chocolatey-gui/user-interface/main-window/actions/update-all/)).
- **Details page** fields: Id, Version, Last update, external links, description, release notes, authors, maintainers, downloads, size, dependencies; actions (Install, Install Advanced, Pin/Unpin, Reinstall, Uninstall, Update, View Package Arguments) ([package-details](https://docs.chocolatey.org/en-us/chocolatey-gui/user-interface/main-window/package-details/)).
- Also has both **list and tile/grid** views and a "Show Console Output" toggle ([features](https://docs.chocolatey.org/en-us/chocolatey-gui/setup/configuration/features/)).

### 1.3 Microsoft-native surfaces
- **Microsoft Store**: updates live under **Library → Get updates** (single manual trigger + "Update all") ([support](https://support.microsoft.com/en-gb/accounts-billing/fix-problems-with-apps-from-microsoft-store)).
- **Windows 11 Settings → Apps → Installed apps**: one searchable, filterable list (Name / Size / Installed date / Version filters) ([support](https://support.microsoft.com/en-us/windows/apps/how-to-check-if-an-app-or-program-is-installed-in-windows)). *Left-nav interaction detail beyond this: unverified.*

### 1.4 VS Code extensions view (list-with-update-button reference)
Verified in this workspace's VS Code fork (`PinK/src/vs/workbench/contrib/extensions`):
- Views: `searchInstalled`, `searchOutdated` (`workbench.views.extensions.searchOutdated`), `searchEnabled`, `searchDisabled`, `popular`.
- The "updates" experience is a **filter token**, not a separate page: `@updates` is rewritten to **`@outdated`**; `HasOutdatedExtensionsContext` gates the `Update All Extensions` action, which is only rendered **in the view title** when there are outdated items.
- Per-item action label is **`Update to v{version}`** (falls back to `Update`); a **consent dialog with Update / Review / Cancel** appears when the extension requests review; after starting, notification *"Updating extension X to version Y started."*.

### 1.5 GUIs for npm/pnpm/bun globals
No maintained, reputable GUI exists for npm/pnpm/bun global packages specifically; UniGetUI (npm + Bun) is the closest operational model, and pnpm/bun are absent. Treat as **unverified/greenfield** rather than copying an existing design.

---

## 2. CLI contract

General rules that apply to every parser:

1. **Spawn without a shell, resolve the real launcher.** `npm`, `pnpm`, `npx` on this machine are **PowerShell/cmd shims**; `spawn('npm')` with `shell:false` fails (`ENOENT`), and `spawn('npm.cmd', …, shell:false)` fails `EINVAL` (Node ≥ 18.20/20.12 security fix). `winget.exe` and `bun.exe` are real executables and work directly. Use `shell:true` (or resolve the JS entry / `cmd /c`) for npm/pnpm.
2. **Corepack redirection**: a `pnpm` shim can be redirected by a `packageManager` field and then **dies with `MODULE_NOT_FOUND … corepack\dist\pnpm.js`** depending on cwd and `COREPACK_ENABLE_STRICT`. Run pnpm command calls from a neutral directory (or with corepack strict disabled) and always check `code != 0`, never just stderr text.
3. **Never rely on exit 0 = success**: `npm outdated` and `pnpm outdated` **exit 1 when outdated packages exist** (documented: [pnpm](https://pnpm.io/cli/outdated)); an empty result is exit 0 with `{}`.
4. Strip `\r` and ANSI sequences; all four tools emit **CRLF** on Windows.

### 2.1 winget (v1.29.380)

| Purpose | Command |
|---|---|
| Version | `winget --version` → `v1.29.380\r\n` (leading **`v` already present**) |
| Installed | `winget list --accept-source-agreements --disable-interactivity` |
| Updates | `winget upgrade --include-unknown --accept-source-agreements --disable-interactivity` |
| Updates (alt) | `winget list --upgrade-available …` — produced **identical rows** to `winget upgrade --include-unknown` on 1.29 |
| Search | `winget search --query <q> [--count N] --accept-source-agreements --disable-interactivity` |
| Detail | `winget show --id <id> -e [--source winget\|msstore] --accept-source-agreements --disable-interactivity` |
| Install | `winget install --id <id> -e [--source <src>] [-v <ver>] -h --accept-package-agreements --accept-source-agreements --disable-interactivity` |
| Upgrade one | `winget upgrade --id <id> -e [-s <src>] -h --accept-package-agreements --accept-source-agreements --disable-interactivity` |
| Uninstall | `winget uninstall --id <id> -e [-s <src>] -h --accept-source-agreements --disable-interactivity` |
| Upgrade all | `winget upgrade --all -h …` (alias `-r,--recurse`) — prefer per-id batching for progress |
| Export (JSON) | `winget export -o <file> --accept-source-agreements --disable-interactivity` |

- **Agreements**: `--accept-source-agreements` suppresses the source (msstore) prompt; `--accept-package-agreements` suppresses the per-package licence prompt. `--disable-interactivity` prevents any prompt. Both documented in `winget install --help` and [Microsoft Learn](https://learn.microsoft.com/en-us/windows/package-manager/winget/).
- **JSON**: there is **no `--output json`** for list/search/upgrade (not in `--help`, not in the documented option table). The only JSON is `winget export`, whose schema is `Sources[].Packages[].PackageIdentifier` (+`Version` only with `--include-versions`) — **no installed or available version is emitted** ([export doc](https://learn.microsoft.com/en-us/windows/package-manager/winget/export)). It is therefore only usable as an **id ↔ source mapping**; install/available versions must come from the table.
- **Table layout**: header row, then a dashed `-` row, then data. Columns are **left-aligned, padded with spaces, computed per invocation** — e.g. full list header width 202 (`Id`@63, `Version`@149, `Available`@179, `Source`@196), a narrow `--count 3` search produced width 62 (`Id`@11, `Version`@34, `Match`@43, `Source`@56). `list`/`upgrade` columns: `Name, Id, Version, Available, Source`; `search` columns: `Name, Id, Version, Match, Source`. Trailing pad exists on the last column.
- **Parse with header offsets, sliced in order, then `trim()`; never split on 2+ spaces** (datasets in `Available` created 5 "columns" and broke it). Lines shorter than the header are truncated rows (common for `MSIX\…`/`ARP\…` ids) — pad them with spaces before slicing.
- `upgrade` ends with a trailer: **`27 upgrades available.`** — drop it. Windows `list` may repeat an `Id` (x86/x64 rows) — de-duplicate.
- Values needing normalisation in the `Version` cell: `Unknown`, `> 1.8.10`, and the `Available` cell can be empty.
- `winget show` emits key/value lines (`Version:`, `Publisher:`, `Moniker:`, `Description:` followed by an indented multi-line block, `Homepage:`, `License:`), preceded by `Found <Name> [<Id>]`.
- **Exit codes** are HRESULTs, reported by Node as **unsigned** (`2316632084`): `0x8A150014` `NO_APPLICATIONS_FOUND` ("No package found…" / "No installed package found…"), `0x8A150003` `COMMAND_FAILED`, `0x8A150010` `NO_APPLICABLE_INSTALLER`, `0x8A150011` `INSTALLER_HASH_MISMATCH`, `0x8A150019` `COMMAND_REQUIRES_ADMIN`, `0x8A15002B` `UPDATE_NOT_APPLICABLE`, `0x8A150061` `PACKAGE_ALREADY_INSTALLED` ([returnCodes.md](https://github.com/microsoft/winget-cli/blob/master/doc/windows/package-manager/winget/returnCodes.md)). Normalise with `code >>> 0` before comparing.
- **Encoding**: output is **UTF-8 regardless of the console code page** (this machine's ACP is 936/GBK): decoding the same buffer as UTF-8 yielded CJK with no U+FFFD, GBK decoding produced U+FFFD. Decode as UTF-8.
- `winget install --id X` without a scope installs **user scope** by default; machine-wide packages may fail or trigger UAC. Admin vs non-admin behaviour differs ([Microsoft Learn](https://learn.microsoft.com/en-us/windows/package-manager/winget/)).
- **msstore ids must not use exact match / `--id`**: documented as "msstore uses unique identifiers… do not require the exact query option" ([install.md](https://github.com/MicrosoftDocs/windows-dev-docs/blob/docs/hub/package-manager/winget/install.md)). Pass the source through and omit `-e` for `source == "msstore"`.

### 2.2 npm (11.16.0) — all calls need `shell:true`

| Purpose | Command | Exit |
|---|---|---|
| Version | `npm --version` | 0 |
| Installed | `npm ls -g --depth=0 --json` | 0 (1 on missing/invalid peers — still emits JSON) |
| Outdated | `npm outdated -g --json` | **1 if any**, 0 + `{}` if none |
| Latest for one | `npm view <pkg> version --json` | 0; 1 + `{"error":{"code":"E404",…}}` if unknown |
| Root / prefix | `npm root -g` / `npm prefix -g` | 0 |
| Install latest | `npm install -g <pkg>@latest` | 0 |
| Uninstall | `npm uninstall -g <pkg>` | 0 |

```json
// npm ls -g --depth=0 --json  (trimmed)
{ "name": "npm",
  "dependencies": {
    "@anthropic-ai/claude-code": { "version": "2.1.317", "overridden": false },
    "@creator-builder/api-test": { "version": "1.0.0", "resolved": "file:../../../../../Code/…", "overridden": false }
  } }
```
```json
// npm outdated -g --json  (exit 1; trimmed)
{ "@anthropic-ai/claude-code": { "current": "2.1.317", "wanted": "2.1.318", "latest": "2.1.318",
    "dependent": "global", "location": "C:\\Users\\…\\npm\\node_modules\\@anthropic-ai\\claude-code" } }
```
- Keys of `ls` JSON are names; `resolved` starting with `file:`/`link:` marks a linked/folder install. `npm outdated` only lists **outdated** packages; `latest` is the registry `latest` dist-tag.
- `npm view` on a missing package writes a JSON `error` object **on stdout** — don't treat stdout as a version string blindly.

### 2.3 pnpm (10.33.2) — partially unverifiable

| Purpose | Command | Result here |
|---|---|---|
| Version | `pnpm --version` | `10.33.2` |
| Installed + versions | `pnpm list -g --depth 0 --json` | JSON; **`dependencies` map is omitted entirely when there are no globals** |
| Root | `pnpm root -g` | `…\pnpm\global\5\node_modules` (works with no globals) |
| Outdated | `pnpm outdated -g --json` | **exit 1 + `ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND`** when the global dir has no `package.json` (i.e. nothing ever installed) |
| Install | `pnpm add -g <pkg>[@ver]` | works; needs `PNPM_HOME\bin` **on PATH** else `ERROR The configured global bin directory … is not in PATH` |
| Update / remove | `pnpm update -g --latest [pkg]` / `pnpm remove -g <pkg>` | **unverified** (would have mutated a global install; not executed) |

```json
// pnpm list -g --depth 0 --json  (fixture with one global; trimmed)
[ { "path": "…\\pnpmfx\\home\\global\\5", "private": false,
    "dependencies": { "is-number": { "from": "is-number", "version": "6.0.0",
      "resolved": "https://registry.npmmirror.com/is-number/-/is-number-6.0.0.tgz",
      "path": "…\\global\\5\\.pnpm\\is-number@6.0.0\\node_modules\\is-number" } } } ]
```
- **`--depth 0` is mandatory**: without it the JSON contains only `{path, private}`. Note `pnpm ls -g --json` **≠** `pnpm list -g --depth 0 --json`.
- Not listing global dependencies by the CLI does **not** mean there are none: this machine's real pnpm global (10.33.2) returns no dependencies, while the plugin's directory scan found packages. Treat "CLI empty + filesystem non-empty" as a real, expected state and reconcile (see caveats).
- pnpm is the only tool here whose `outdated` needs an importer manifest; absent globals ⇒ treat that error as "0 outdated", not as a failure.
- Corepack: bare `pnpm.cmd` under this Node 24 fails with `corepack\dist\pnpm.js` `MODULE_NOT_FOUND` unless cwd is neutral; `COREPACK_ENABLE_STRICT=0` allowed it to run.

### 2.4 bun (1.3.14)

| Purpose | Command | Result here |
|---|---|---|
| Version | `bun --version` | `1.3.14` (no `v`) |
| Installed | `bun pm ls -g` | tree; **no JSON mode** (`--json` is ignored, output unchanged) |
| Bin / root | `bun pm bin -g` | `C:\Users\<u>\.bun\bin` |
| Outdated | `bun outdated -g` | **ASCII table**, works for globals |
| Install / remove / update | `bun add -g <pkg>` / `bun remove -g <pkg>` / `bun update -g` | documented as global equivalents — **unverified** (not run) |

```
bun pm ls -g
C:\Users\Administrator\.bun\install\global node_modules (331)
├── @opencode/cli@2.2.5
└── command-code@1.84.0
```
```
bun outdated -g
| Package      | Current | Update | Latest |
|--------------|---------|--------|--------|
| command-code | 1.84.0  | 1.88.3 | 1.88.3 |
```
- First line is `<global dir> node_modules (<count>)`; the **count includes transitive deps** (331) while the tree shows only globally-installed packages (2) — never use the count as the package total.
- Tree lines are `├── name@version` / `└── name@version` (also `---`); scoped names contain `@`, so split on the **last** `@`. Empty globals print just the header line.
- `--all` switches to the full transitive tree — do not use it.
- Documented tree shape and `-g` support: [bun pm docs](https://bun.com/docs/pm/cli/pm); `latest` column semantics per [bun outdated](https://bun.com/docs/pm/cli/outdated).

---

## 3. Recommended UI/UX (React, plain CSS variables)

**Information architecture**
- Single panel, two regions: a **196 px rail** + main column. Rail: `All`, **`Updates`** (live count badge), then one grouped section per manager (`winget`, `npm`, `pnpm`, `bun`) with 14 px logo + name + count; unavailable managers rendered at `opacity:.45` with an "unavailable" suffix and a `title` reason, still clickable (shows an explained empty state).
- Model the tabs as **filter scopes over one list** (VS Code: `@updates` → `@outdated`), so updates is not a second implementation of the same table.
- Header: title + subtitle `<N> packages · <M> updates · checked <relative time>`, search box, sort select (updates first / name / version / source), primary **Update all** (disabled with tooltip at 0 — Chocolatey pattern), secondary **Install**.

**Row anatomy** (grid, ~36 px tall, monospace for versions)
`[icon] [name / manager · scope] [source chip] [current version] [latest version + Update] [size or —] [status] [›]`
- Latest cell resolves to one of: `‹version›` + mini **Update** button; `✓ up to date`; `—` + **Check** when unknown. Unknown must never render as "up to date" (winget leaves `Available` blank for both cases).
- Status dot colors reuse the UniGetUI meaning: grey idle, green ok, amber/yellow in progress, red error.

**States**
- Loading: 3 skeleton rows + status line "Reading local index…"; never blank.
- Empty (per scope): explains *why* (e.g. "pnpm has no global packages", "no updates available") with one action.
- Error: inline banner `Could not read <manager>: <message>` + **Retry**, list keeps last good data; partial failures (winget ok, npm failed) must not blank the whole panel.
- Row-level state machine `idle | running | done | failed`; during a batch lock all row buttons and show `Updating X (i / N)`.

**Destructive & mutating actions**
- Uninstall: modal naming the package + manager + version, destructive button labelled with the package (`Uninstall <name>`), verb-first; never a bare "OK". Install/Update need no modal (reversible), but do show a one-line preflight when the action may need elevation.
- Multi-select + "Update selected" mirroring UniGetUI; the batch dialog lists rows with checkboxes and `current → latest`, then locks and shows a progress bar.
- After every mutation: refresh the affected manager only, and append the full command + output to the log panel.

**Search/filter**
- Debounced (250–300 ms) local filter over loaded rows; explicit **Enter** only for remote search (winget `search`, npm `view`) because those hit the network. Show a spinner inside the field and "no results" distinctly from "not searched".
- Keep keyboard: `/` focus search, `Esc` clears/closes drawer and restores focus, `↑/↓` move rows, `Enter` opens details.

**Live output/log panel**
- Bottom drawer, `aria-live="polite"` status line + **View output**. Render the **exact command line** being run (users learn the CLI and can reproduce failures), stdout/stderr in monospace, auto-scroll with a pause pin, and cap retained lines (UniGetUI keeps 1,000 operations × 5,000 lines).
- Show elapsed time per step; winget installs legitimately take minutes — never show an indeterminate bar without an elapsed counter.

**Theming** — only CSS custom properties, components use `var(--…)` exclusively: `--pk-bg`, `--pk-bg-raised`, `--pk-border`, `--pk-text`, `--pk-text-dim`, `--pk-accent`, `--pk-ok`, `--pk-warn`, `--pk-error`; sizes/spacing as `--pk-row-h`, `--pk-rail-w`, `--pk-radius`. No literal colors in components; dark/light is one variable block on the root.

---

## 4. CLI caveats that change implementation

1. **No parseable JSON for winget list/search/upgrade** — fixed-column parsing with header offsets is mandatory; `export` gives ids only.
2. **winget HRESULT exit codes** (unsigned, `0x8A150014` = not found) must be normalised, or "not found" reads as a crash.
3. **winget outputs UTF-8 despite a GBK code page**; decode UTF-8 everywhere and force UTF-8 when spawning.
4. **npm/pnpm are shims** — direct spawn fails; use a shell or the real entry point, and never assume `code === 0` means "no updates" (outdated returns 1).
5. **pnpm**: `list -g` requires `--depth 0`; no globals ⇒ omitted `dependencies`; `outdated -g` throws `ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND` (treat as empty); `add -g` needs `PNPM_HOME\bin` on PATH; corepack redirection can break the binary.
6. **bun** has no machine-readable global listing (`--json` ignored, `pm ls -g` count counts transitive deps) — parse the tree; `bun outdated -g`'s ASCII table is the most reliable update source.
7. **msstore rows** appear in `winget list`/`upgrade` with a Store id and no `.` separator; they must not be passed with `--id` + `-e`. Route them by `source`.

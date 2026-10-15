# Changelog

## Unreleased

- Spreadsheet-style cell selection: drag, Shift+click, Shift+arrows and ⌘/Ctrl+A select a block of cells; ⌘/Ctrl+C copies it as TSV (with headers from the context menu); Delete clears it.
- Transforms can run on several columns at once (pick them in the dialog, or select cells across columns first).
- Datetimes like `2024-10-30 07:56:43.972 +0300` are detected as `datetime`, and get a "Convert to datetime" transform. Reformat date supports `SSS`/`Z` tokens and keeping the original offset. Datetime values reach SQLite with `+03:00`-style offsets so its date functions work.

## 0.1.0

- Typed, virtualized grid with in-place editing that writes back to the file (undo and the original dialect preserved).
- Automatic column types with overrides; type-aware sorting, filters, alignment and invalid-cell highlighting.
- Excel-style filters with distinct values, multi-column sort, global search, filter chips.
- SQL panel on SQLite (sql.js): JOIN other files, regex and transform functions, autocomplete, history, export of full results.
- Column transforms with live preview: AES/Fernet decryption and encryption, hashing, encodings, JWT, masking, regex, dates, numbers; user JavaScript transforms in a sandbox; secrets in SecretStorage.
- Export the view or selected rows to CSV/TSV/JSON/NDJSON/YAML/Markdown/HTML/SQL with delimiter, quoting, line ending and encoding options.
- Column profile, lint diagnostics and repair, compare by key, split, merge, convert, rainbow columns, large-file read-only mode.

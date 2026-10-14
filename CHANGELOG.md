# Changelog

## 0.1.0

- Typed, virtualized grid with in-place editing that writes back to the file (undo and the original dialect preserved).
- Automatic column types with overrides; type-aware sorting, filters, alignment and invalid-cell highlighting.
- Excel-style filters with distinct values, multi-column sort, global search, filter chips.
- SQL panel on SQLite (sql.js): JOIN other files, regex and transform functions, autocomplete, history, export of full results.
- Column transforms with live preview: AES/Fernet decryption and encryption, hashing, encodings, JWT, masking, regex, dates, numbers; user JavaScript transforms in a sandbox; secrets in SecretStorage.
- Export the view or selected rows to CSV/TSV/JSON/NDJSON/YAML/Markdown/HTML/SQL with delimiter, quoting, line ending and encoding options.
- Column profile, lint diagnostics and repair, compare by key, split, merge, convert, rainbow columns, large-file read-only mode.

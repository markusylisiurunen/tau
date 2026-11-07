# History storage upgrades

Setup migrates transcript search to an external-content FTS5 index. The index reads text from the transcript table rather than storing another text copy. Original payloads and extracted search text remain separate, and searches and snippets retain their behavior.

For an existing collection, setup copies entries and indexes them in batches of at most 512 entries and normally at most 8 MiB of payload and search text (an oversized entry is copied on its own). Progress is stored in D1. Live writes are mirrored during the copy, and an interrupted setup resumes when rerun with the same credentials. Use `tau history setup` for this upgrade, not a standalone `wrangler d1 migrations apply`: the final migration refuses to run while entries remain uncopied.

The old tables remain until cutover, so this migration needs temporary storage for another transcript table and search index. Check available space below D1's 10 GB database limit, keep a recoverable backup, and test the upgrade on a separate production-sized database before deploying a large collection. Freed pages can be reused even if the reported database file size does not shrink immediately. Between cutover and Worker deployment, the old Worker cannot search or upload transcripts; hosts retain pending uploads for retry. If deployment fails after cutover, rerun setup to complete it.

# Upstream provenance

Inspected source snapshots (17 September 2026):

- [pi-warden](https://github.com/DevMortimer/pi-warden), MIT, `3e5404ee847fd861acf789db97c51c4a9a5902b3`, manifest 0.12.0.
- [pi-typesafe](https://github.com/DevMortimer/pi-typesafe), MIT, `0438bb8152dbe5d2418fde3c103b94ff38428a95`, manifest 0.4.0.
- [pi-jev](https://github.com/TheoOliveira/pi-jev), reference only, `cf402ec089cd2bc72836467851524196b0a28cef`.

Runtime imports use the exact published versions in package.json and bun.lock, not mutable Git HEAD. The first two projects' MIT licences are preserved under licenses/. Their standalone Pi extensions are not registered.

Direct reuse: pi-typesafe createTypeSafe and error contract; pi-warden redact, doneQuestions and stuckQuestions. The surrounding hook orchestration, evidence ledger and finding-priority policy are personal adaptation rather than claims of upstream behaviour.

The vendor/ inspection clones are ignored and not needed at runtime. To reproduce upstream source tests, clone the repositories and check out the hashes above, then run the command in README.md using this package's pinned dependencies. Offline test results establish the exercised compatibility only, not blanket security or semantic accuracy.

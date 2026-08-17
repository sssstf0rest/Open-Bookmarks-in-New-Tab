# Task Plan: Chrome 151 Reliability Patch 2.4.0

## Goal
Implement and verify a version 2.4.0 patch on `aug-bug-fix` that opens exactly one destination per bookmark, preserves every tab from folder “Open all,” handles Gmail and LAN URLs consistently, and creates no `empty.zip` download.

## Current Phase
Complete

## Phases

### Phase 1: Baseline and Regression Harness
- [x] Confirm branch/status and preserve unrelated `AGENTS.md`
- [x] Add deterministic tests for duplicate, group, Gmail, LAN, and download behavior
- [x] Capture current failures before replacement
- **Status:** complete

### Phase 2: Single-Owner Navigation Architecture
- [x] Make one listener responsible for opening/reusing destinations
- [x] Track exact navigation/source state and remove active-tab fallback
- [x] Remove destructive generic `goBack()`/tab-removal recovery
- **Status:** complete

### Phase 3: Download-Free Cancellation
- [x] Replace `empty.zip` interception with a locally verified non-download response
- [x] Remove download UI, download permission, and keepalive alarm dependencies
- [x] Verify cold-worker and concurrent navigation behavior
- **Status:** complete

### Phase 4: Marker Migration, UI, and Documentation
- [x] Replace brittle `newtab@`/domain exceptions with an authenticated reversible marker
- [x] Migrate released bookmark forms safely and transactionally
- [x] Set version 2.4.0 and align popup, README, privacy, and release documentation
- **Status:** complete

### Phase 5: Release Verification
- [x] Run syntax, JSON, regression, and repeated concurrency checks
- [x] Test the unpacked flow in disposable Chrome 151
- [x] Review complete diff and retain only intentional changes
- **Status:** complete

## Acceptance Criteria
- Focus disabled: one inactive destination, no duplicate.
- Folder “Open all”: N bookmarks produce N distinct final tabs; none disappear.
- Gmail hostname variants and HTTP(S) LAN/IP/port URLs open once.
- No download item, prompt, bubble, or `empty.zip` file is created.
- Existing nonblank source tabs stay loaded; explicit blank tabs are reused safely.
- Pause restores bookmark URLs; update migration preserves recoverable originals.

## Decisions
| Decision | Rationale |
|----------|-----------|
| Target Chrome 151.0.7922.138 arm64 and extension 2.4.0 | User-confirmed release environment |
| Prove cancellation in a disposable profile before adopting it | The previous patch did not work reliably for the user |
| Keep planning files uncommitted | They are task working memory, not extension deliverables |
| Use owner-specific `owner_m/p_nonce` capabilities | Prevents marker-shaped page data and Basic Auth URLs from being mistaken for extension state |
| Keep broad `newtab@` interception migration-only | Mixed 2.3 peers remain supported without permanently intercepting legitimate credentials |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| Chrome rejected fixed-length and long wrapper regexes with `memoryLimitExceeded` | Native Chrome 151 smoke test | Kept a low-memory owner regex for current markers and used an owner-specific URL filter for the exact legacy wrapper |

# Security Specification & Verification: Setu Safe Internet Firestore Rules

## 1. Data Invariants
1. **User Profile Invariant**: A user document at `/users/{userId}` can only be read and updated by the authenticated user whose `request.auth.uid == userId`. The user's `id` and `createdAt` are immutable after creation.
2. **Caretaker Isolation**: A user cannot read or update another caretaker's private profile or change another user's PIN.
3. **QueryLog Invariant**: A query log at `/queries/{queryId}` can be created by the system/browser search flow. Caretakers can read and list queries belonging to their account or sessions. Log entries cannot have arbitrary fields or oversized payloads.
4. **Settings Invariant**: Caretaker settings at `/settings/{settingId}` belong strictly to the owner `userId == request.auth.uid`.

## 2. The "Dirty Dozen" Threat Payloads (Must Be Blocked)
1. **Unauthenticated User Profile Read**: Anonymous user requesting `/users/someone-else`.
2. **Unauthenticated User Profile Write**: Unauthenticated write creating a profile with spoofed admin permissions.
3. **User Impersonation Write**: Authenticated user `user_A` attempting to write to `/users/user_B`.
4. **Profile Identity Tampering**: Authenticated user trying to update their own `id` to a different UID.
5. **Junk ID Poisoning**: Document creation with an ID exceeding 128 characters or containing illegal shell/SQL injection characters.
6. **Oversized Field Denial of Wallet**: Query log payload containing a 10MB string for the query or explanation.
7. **Shadow Field Injection**: User profile update with ghost fields like `isAdmin: true` or `role: 'superadmin'`.
8. **Settings Hijacking**: User `user_A` creating or updating `/settings/user_B_settings` with `userId: 'user_B'`.
9. **Settings Schema Violation**: Setting `safetyLevel` to an invalid enum string like `"malicious_bypass"`.
10. **Query Tampering**: Attempt to modify a query log's `timestamp` to falsify activity records.
11. **Blanket Query Scraping**: Unauthorized client querying `/users` with no filter to scrape emails.
12. **PII Leak via Public Collection**: Attempt to read user email and parent PIN without authentication.

## 3. Test Runner Invariant Checks
The security rules mathematically block all 12 attack vectors by enforcing ABAC, strict key filtering, and path variable validation.

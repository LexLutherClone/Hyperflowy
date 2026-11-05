---
status: accepted
---

# Collaboration notifications and mentions

Finishes milestone 4 of
[ADR 0076](./0076-collaboration-workspaces-and-shared-spaces.md). People hear
about collaboration by email, and comments can mention people.

## Product contract

- **Shared with you.** A new email grant on a shared note
  ([ADR 0079](./0079-shared-spaces.md)) emails that address: who shared which
  note, what they can do with it, and a link. Changing the grant's role later
  doesn't email again. Group grants don't email (the group's members are
  already a team in a workspace).
- **Invited to a workspace.** A new workspace invitation
  ([ADR 0078](./0078-workspaces-and-groups.md)) emails the address, pointing
  to Settings. Re-inviting (or changing the invited role) doesn't email again.
- **Mentions.** In a comment ([ADR 0081](./0081-comments.md)), typing `@`
  lists the people with access to the note, by name; picking one inserts a
  tag, `@[Name](user:<accountId>)`, and the posted comment (and the email)
  shows it as `@Name`. Each mentioned account is emailed, with the comment and
  a link, but only if it is verified and currently has a role on the note, and
  never the author.

## Decisions

**Emails can't be turned against anyone.** A grant or invitation emails the
address the admin typed, and the API's answer is identical whether or not an
account exists, so it reveals nothing. A mention only emails people who can
already open the note, so it can't reach an arbitrary address or disclose
that the note exists. Both write paths are same-origin and rate-limited
(`WORKSPACE_LIMIT`).

**Every interpolated value is escaped.** Names, note and workspace names, and
comment text are user-controlled. `worker/collab-email.ts` escapes them in the
HTML, flattens them to one bounded line in subjects (no header injection),
and builds links from the Worker's own origin, never from input. The
plain-text part carries the same content.

**Sent after the response.** Emails go through the one email seam
(`worker/email.ts`, which never throws) on the request's `waitUntil`, so
neither a slow provider nor a failed send changes or delays the response.

**The people list shows names only, and only to people who can comment.**
`GET /api/spaces/:id/people` returns `{ id, name }` for the owner, the
verified accounts behind email grants, and group members. No email addresses:
a commenter learns who is in the note, not how to reach them. Viewers get a
403 (they can't comment, so they have no use for it) and strangers a 404.
Pending email grants with no account yet aren't listed, so the list never
shows whether an address has an account. A mention carries the account id,
not an address; the Worker re-checks that account's role before sending.

**"New" is decided by the write itself.** The grant and invitation upserts
return the row's `createdAt`; an update keeps the original, so equality with
this request's timestamp means this request created it. No read-then-write
race.

## Not yet

In-app notifications (a bell), email preferences and unsubscribe, and digest
batching.

## Tests

`worker/collab-email.test.ts` (escaping, subjects, mention parsing),
`worker/spaces.test.ts` (one email per new grant, the people list, mentions
reaching only verified people with access), `worker/workspace-invite-email.test.ts`,
and `e2e/worker-browser/comments.spec.ts` (the mention picker, the rendered
mention, and the Worker sending the share and mention emails).

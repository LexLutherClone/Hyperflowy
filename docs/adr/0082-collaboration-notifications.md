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
  lists the people with access to the note; picking one inserts their address
  (`@name@example.com`), and the posted comment shows the mention as their
  name. Each mentioned person is emailed, with the comment and a link, but only
  if a verified account with that address currently has a role on the note,
  and never the author.

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

**The people list doesn't leak accounts.** `GET /api/spaces/:id/people`
(anyone with access) lists the owner and group members with names, and email
grants by address only, so it never shows whether an address has an account.

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

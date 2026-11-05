import { expect, test } from "bun:test";

import {
  escapeHtml,
  mentionEmail,
  mentionedUserIds,
  shareEmail,
  workspaceInviteEmail,
} from "./collab-email";

test("user text is escaped in HTML and flattened in subjects", () => {
  const mail = shareEmail({
    to: "bo@example.com",
    sharerName: 'Ann <script>alert("x")</script>',
    noteName: "Plan\nwith <b>tags</b>",
    role: "editor",
    url: "https://app.example/s/1",
  });
  expect(mail.html).not.toContain("<script>");
  expect(mail.html).toContain("&lt;script&gt;");
  expect(mail.html).not.toContain("<b>tags</b>");
  expect(mail.subject).not.toContain("\n");
  expect(mail.subject).toContain("shared “Plan with <b>tags</b>” with you");
  expect(mail.text).toContain("You can edit it.");
  expect(mail.text).toContain("https://app.example/s/1");
});

test("invite and mention emails carry the right copy", () => {
  expect(
    workspaceInviteEmail({
      to: "x@example.com",
      inviterName: "Ann",
      workspaceName: "Design",
      url: "https://app.example/settings",
    }).subject,
  ).toBe("Ann invited you to Design");
  const mention = mentionEmail({
    to: "bo@example.com",
    authorName: "Cy",
    noteName: "Plan",
    comment: "@[Bo](user:u_bo) can you check?",
    url: "https://app.example/s/1",
  });
  expect(mention.subject).toBe("Cy mentioned you in “Plan”");
  expect(mention.text).toContain("@Bo can you check?");
  expect(mention.text).not.toContain("user:u_bo");
});

test("mentions are name tags carrying an account id, deduplicated", () => {
  expect(
    mentionedUserIds(
      "@[Bo](user:u_bo) and (@[Cy D](user:u-cy)). Again @[Bo](user:u_bo); not @bo@example.com",
    ),
  ).toEqual(["u_bo", "u-cy"]);
  expect(mentionedUserIds("email me at me@x.com")).toEqual([]);
  // An id can't smuggle anything past the token grammar.
  expect(mentionedUserIds("@[x](user:a/b)")).toEqual([]);
});

test("escapeHtml covers the five characters", () => {
  expect(escapeHtml(`<a href="x">&'</a>`)).toBe(
    "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;",
  );
});

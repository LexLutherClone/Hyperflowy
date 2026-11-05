import type { EmailMessage } from "./email";

/**
 * Collaboration emails (ADR 0082): someone shared a note with you, invited you
 * to a workspace, or mentioned you in a comment. Pure templates; senders go
 * through `worker/email.ts`.
 *
 * Every interpolated value is user-controlled (names, note and workspace
 * names, comment text), so the HTML is escaped and the plain-text part is
 * the canonical copy. Links are built by the Worker from its own origin,
 * never from user input.
 */

const ROLE = {
  viewer: "view",
  commenter: "comment on",
  editor: "edit",
  admin: "manage",
  member: "join",
} as const;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** One line of a user's text, safe for a subject: no newlines, bounded. */
function oneLine(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function layout(lines: string[], cta: { label: string; url: string }) {
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#111">
${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("\n")}
<p><a href="${escapeHtml(cta.url)}" style="display:inline-block;padding:8px 14px;border-radius:8px;background:#111;color:#fff;text-decoration:none">${escapeHtml(cta.label)}</a></p>
<p style="color:#666;font-size:13px">If you weren't expecting this, you can ignore it.</p>
</body></html>`;
  const text = `${lines.join("\n\n")}\n\n${cta.label}: ${cta.url}\n\nIf you weren't expecting this, you can ignore it.`;
  return { html, text };
}

export function shareEmail(input: {
  to: string;
  sharerName: string;
  noteName: string;
  role: keyof typeof ROLE;
  url: string;
}): EmailMessage {
  const who = oneLine(input.sharerName) || "Someone";
  const note = oneLine(input.noteName) || "a note";
  return {
    to: input.to,
    subject: `${who} shared “${note}” with you`,
    ...layout(
      [
        `${who} shared “${note}” with you on Dotflowy. You can ${ROLE[input.role]} it.`,
        "Sign in with this email address to open it.",
      ],
      { label: "Open the note", url: input.url },
    ),
  };
}

export function workspaceInviteEmail(input: {
  to: string;
  inviterName: string;
  workspaceName: string;
  url: string;
}): EmailMessage {
  const who = oneLine(input.inviterName) || "Someone";
  const ws = oneLine(input.workspaceName) || "a workspace";
  return {
    to: input.to,
    subject: `${who} invited you to ${ws}`,
    ...layout(
      [
        `${who} invited you to the workspace “${ws}” on Dotflowy.`,
        "Sign in with this email address and open Settings to join.",
      ],
      { label: "Open Settings", url: input.url },
    ),
  };
}

export function mentionEmail(input: {
  to: string;
  authorName: string;
  noteName: string;
  comment: string;
  url: string;
}): EmailMessage {
  const who = oneLine(input.authorName) || "Someone";
  const note = oneLine(input.noteName) || "a note";
  return {
    to: input.to,
    subject: `${who} mentioned you in “${note}”`,
    ...layout(
      [
        `${who} mentioned you in a comment on “${note}”:`,
        oneLine(input.comment, 500),
      ],
      { label: "Open the note", url: input.url },
    ),
  };
}

/** The email addresses a comment mentions (`@name@example.com`), normalized
 *  and deduplicated, at most 20. */
export function mentionedEmails(body: string): string[] {
  const found = new Set<string>();
  for (const m of body.matchAll(
    /(?:^|[\s(])@([^\s@()<>,;]+@[^\s@()<>,;]+\.[A-Za-z]{2,})/g,
  )) {
    found.add(m[1]!.toLowerCase().replace(/[.]+$/, ""));
    if (found.size >= 20) break;
  }
  return [...found];
}

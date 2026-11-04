import { LogOutIcon, PlusIcon, Trash2Icon, UsersIcon } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import {
  canChangeRole,
  canDelete,
  canInvite,
  canManage,
  canRemove,
  type GrantableRole,
  type WorkspaceRole,
} from "../data/workspace-policy";
import * as api from "../data/workspaces-api";
import { useSession } from "../lib/auth-client";
import { RowGroup, Section, SettingRow } from "./settings-layout";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { NativeSelect, NativeSelectOption } from "./ui/native-select";

/**
 * Settings → Workspaces (ADR 0078): team workspaces, invitations, members,
 * and groups. Workspaces hold no notes yet; sharing notes with a workspace's
 * people and groups arrives in ADR 0076 milestone 2. Every control is gated by
 * the same `workspace-policy` the server enforces, so what's offered is what
 * will succeed.
 */

const ROLE_LABEL = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
} satisfies Record<WorkspaceRole, string>;

function run<T>(action: () => Promise<T>, success?: string) {
  return action().then(
    (value) => {
      if (success) toast.success(success);
      return value;
    },
    // The API client only ever rejects with an Error carrying a message.
    (error: Error) => {
      toast.error(error.message);
      return undefined;
    },
  );
}

export function WorkspacesSection() {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | {
        kind: "ready";
        workspaces: api.WorkspaceSummary[];
        invites: api.PendingInvite[];
      }
  >({ kind: "loading" });
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  const reload = useCallback(async () => {
    try {
      const next = await api.listWorkspaces();
      setState({ kind: "ready", ...next });
    } catch (error) {
      setState({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Couldn't load workspaces.",
      });
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const created = await run(() => api.createWorkspace(name));
    if (!created) return;
    setName("");
    setCreating(false);
    await reload();
    setOpen(created.workspace.id);
  };

  return (
    <Section
      title="Workspaces"
      description="Teams you work with. Invite people by the email of their account, and organize them into groups to share notes with."
    >
      {state.kind === "loading" && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
      {state.kind === "error" && (
        <p role="alert" className="text-sm text-destructive">
          {state.message}
        </p>
      )}
      {state.kind === "ready" && state.invites.length > 0 && (
        <RowGroup>
          {state.invites.map((invite) => (
            <SettingRow
              key={invite.id}
              icon={<UsersIcon />}
              title={`Join ${invite.workspaceName}`}
              description={`${invite.invitedByName ?? "Someone"} invited you as ${ROLE_LABEL[invite.role].toLowerCase()}.`}
              action={
                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      void run(() => api.declineInvite(invite.id)).then(reload)
                    }
                  >
                    Decline
                  </Button>
                  <Button
                    size="sm"
                    onClick={() =>
                      void run(
                        () => api.acceptInvite(invite.id),
                        `Joined ${invite.workspaceName}`,
                      ).then(reload)
                    }
                  >
                    Join
                  </Button>
                </div>
              }
            />
          ))}
        </RowGroup>
      )}
      {state.kind === "ready" && (
        <RowGroup>
          {state.workspaces.map((ws) => (
            <SettingRow
              key={ws.id}
              title={ws.name}
              description={`${ROLE_LABEL[ws.role]} · ${ws.memberCount} ${ws.memberCount === 1 ? "person" : "people"}`}
              action={
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`Manage ${ws.name}`}
                  onClick={() => setOpen(ws.id)}
                >
                  {canManage(ws.role) ? "Manage" : "View"}
                </Button>
              }
            />
          ))}
          {creating ? (
            <form
              onSubmit={create}
              className="flex items-center gap-2 bg-card px-4 py-3"
            >
              <Input
                // oxlint-disable-next-line jsx-a11y/no-autofocus -- opened by an explicit click
                autoFocus
                aria-label="Workspace name"
                placeholder="Workspace name"
                value={name}
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
              />
              <Button type="submit" size="sm" disabled={!name.trim()}>
                Create
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setCreating(false)}
              >
                Cancel
              </Button>
            </form>
          ) : (
            <SettingRow
              title={
                state.workspaces.length === 0
                  ? "You're not in any workspace yet"
                  : "Start another team"
              }
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCreating(true)}
                >
                  <PlusIcon />
                  New workspace
                </Button>
              }
            />
          )}
        </RowGroup>
      )}
      {open && (
        <WorkspaceDialog
          workspaceId={open}
          onClose={() => {
            setOpen(null);
            void reload();
          }}
        />
      )}
    </Section>
  );
}

function WorkspaceDialog({
  workspaceId,
  onClose,
}: {
  workspaceId: string;
  onClose: () => void;
}) {
  const { data: session } = useSession();
  const me = session?.user.id ?? null;
  const [detail, setDetail] = useState<api.WorkspaceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setDetail(await api.getWorkspace(workspaceId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load the workspace.");
    }
  }, [workspaceId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const role = detail?.workspace.role ?? null;
  const act = async <T,>(action: () => Promise<T>, success?: string) => {
    await run(action, success);
    await reload();
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{detail?.workspace.name ?? "Workspace"}</DialogTitle>
          <DialogDescription>
            {role
              ? `You're ${role === "owner" ? "the owner" : `${role === "admin" ? "an admin" : "a member"}`}.`
              : "Loading…"}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {detail && role && (
          <div className="flex flex-col gap-6">
            {canManage(role) && (
              <RenameForm
                current={detail.workspace.name}
                onRename={(name) =>
                  act(() => api.renameWorkspace(workspaceId, name), "Renamed")
                }
              />
            )}
            <MembersList
              detail={detail}
              me={me}
              onRole={(userId, next) =>
                act(
                  () => api.setRole(workspaceId, userId, next),
                  "Role updated",
                )
              }
              onRemove={async (userId) => {
                await run(() => api.removeMember(workspaceId, userId));
                if (userId === me) onClose();
                else await reload();
              }}
            />
            {canInvite(role, "member") && (
              <InviteForm
                role={role}
                onInvite={(email, as) =>
                  act(
                    () => api.invite(workspaceId, email, as),
                    `Invitation saved for ${email}`,
                  )
                }
              />
            )}
            {canManage(role) && detail.invites.length > 0 && (
              <div className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">Pending invitations</h3>
                <ul className="flex flex-col gap-1">
                  {detail.invites.map((inv) => (
                    <li
                      key={inv.id}
                      className="flex items-center justify-between gap-2 text-sm"
                    >
                      <span className="min-w-0 truncate">
                        {inv.email}{" "}
                        <span className="text-muted-foreground">
                          · {ROLE_LABEL[inv.role]}
                        </span>
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          void act(() => api.revokeInvite(workspaceId, inv.id))
                        }
                      >
                        Revoke
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <GroupsEditor
              detail={detail}
              editable={canManage(role)}
              onCreate={(name) =>
                act(() => api.createGroup(workspaceId, name), "Group created")
              }
              onDelete={(groupId) =>
                act(() => api.deleteGroup(workspaceId, groupId))
              }
              onMembers={(groupId, userIds) =>
                act(() => api.setGroupMembers(workspaceId, groupId, userIds))
              }
            />
            <DangerZone
              role={role}
              name={detail.workspace.name}
              onLeave={async () => {
                if (!me) return;
                await run(
                  () => api.removeMember(workspaceId, me),
                  `Left ${detail.workspace.name}`,
                );
                onClose();
              }}
              onDelete={async () => {
                const done = await run(
                  () => api.deleteWorkspace(workspaceId),
                  `Deleted ${detail.workspace.name}`,
                );
                if (done) onClose();
              }}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RenameForm({
  current,
  onRename,
}: {
  current: string;
  onRename: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(current);
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void onRename(name);
      }}
    >
      <Input
        aria-label="Workspace name"
        value={name}
        maxLength={80}
        onChange={(e) => setName(e.target.value)}
      />
      <Button
        type="submit"
        variant="outline"
        size="sm"
        disabled={!name.trim() || name.trim() === current}
      >
        Rename
      </Button>
    </form>
  );
}

function MembersList({
  detail,
  me,
  onRole,
  onRemove,
}: {
  detail: api.WorkspaceDetail;
  me: string | null;
  onRole: (userId: string, role: GrantableRole) => Promise<void>;
  onRemove: (userId: string) => Promise<void>;
}) {
  const actor = detail.workspace.role;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">People</h3>
      <ul className="flex flex-col divide-y rounded-lg ring-1 ring-foreground/10">
        {detail.members.map((m) => {
          const label = m.name || m.email || "Unknown";
          const self = m.userId === me;
          const roles = (["admin", "member"] as const).filter(
            (r) => r === m.role || canChangeRole(actor, m.role, r),
          );
          const changeable = !self && roles.length > 1;
          return (
            <li
              key={m.userId}
              data-member={m.userId}
              className="flex items-center gap-2 px-3 py-2 text-sm"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">
                  {label}
                  {self && (
                    <span className="font-normal text-muted-foreground">
                      {" "}
                      (you)
                    </span>
                  )}
                </div>
                {m.email && m.email !== label && (
                  <div className="truncate text-xs text-muted-foreground">
                    {m.email}
                  </div>
                )}
              </div>
              {changeable && m.role !== "owner" ? (
                <NativeSelect
                  size="sm"
                  className="shrink-0"
                  aria-label={`Role for ${label}`}
                  value={m.role}
                  onChange={(e) => {
                    const next = e.target.value;
                    if (next === "admin" || next === "member")
                      void onRole(m.userId, next);
                  }}
                >
                  {roles.map((r) => (
                    <NativeSelectOption key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              ) : (
                <Badge variant="secondary">{ROLE_LABEL[m.role]}</Badge>
              )}
              {!self && canRemove(actor, m.role, false) && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${label}`}
                  onClick={() => void onRemove(m.userId)}
                >
                  <Trash2Icon />
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function InviteForm({
  role,
  onInvite,
}: {
  role: WorkspaceRole;
  onInvite: (email: string, as: GrantableRole) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [as, setAs] = useState<GrantableRole>("member");
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void onInvite(email.trim(), as).then(() => setEmail(""));
      }}
    >
      <h3 className="text-sm font-medium">Invite someone</h3>
      <p className="text-xs text-muted-foreground">
        They'll see the invitation in Settings when they sign in with this
        email.
      </p>
      <div className="flex items-center gap-2">
        <Input
          type="email"
          aria-label="Email to invite"
          placeholder="name@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <NativeSelect
          size="sm"
          className="shrink-0"
          aria-label="Invite as"
          value={as}
          onChange={(e) => {
            const next = e.target.value;
            if (next === "admin" || next === "member") setAs(next);
          }}
        >
          <NativeSelectOption value="member">Member</NativeSelectOption>
          {canInvite(role, "admin") && (
            <NativeSelectOption value="admin">Admin</NativeSelectOption>
          )}
        </NativeSelect>
        <Button type="submit" size="sm" disabled={!email.trim()}>
          Invite
        </Button>
      </div>
    </form>
  );
}

function GroupsEditor({
  detail,
  editable,
  onCreate,
  onDelete,
  onMembers,
}: {
  detail: api.WorkspaceDetail;
  editable: boolean;
  onCreate: (name: string) => Promise<void>;
  onDelete: (groupId: string) => Promise<void>;
  onMembers: (groupId: string, userIds: string[]) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const nameOf = (userId: string) => {
    const m = detail.members.find((x) => x.userId === userId);
    return m?.name || m?.email || "Unknown";
  };
  if (!editable && detail.groups.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Groups</h3>
      {detail.groups.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Groups let you share notes with several people at once.
        </p>
      )}
      <ul className="flex flex-col gap-3">
        {detail.groups.map((g) => (
          <li
            key={g.id}
            data-group={g.id}
            className="flex flex-col gap-2 rounded-lg p-3 ring-1 ring-foreground/10"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{g.name}</span>
              {editable && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete group ${g.name}`}
                  onClick={() => void onDelete(g.id)}
                >
                  <Trash2Icon />
                </Button>
              )}
            </div>
            {editable ? (
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {detail.members.map((m) => {
                  const checked = g.memberIds.includes(m.userId);
                  return (
                    <label
                      key={m.userId}
                      className="flex items-center gap-1.5 text-sm"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(next) =>
                          void onMembers(
                            g.id,
                            next
                              ? [...g.memberIds, m.userId]
                              : g.memberIds.filter((id) => id !== m.userId),
                          )
                        }
                      />
                      {nameOf(m.userId)}
                    </label>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {g.memberIds.length
                  ? g.memberIds.map(nameOf).join(", ")
                  : "No one yet"}
              </p>
            )}
          </li>
        ))}
      </ul>
      {editable && (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void onCreate(name).then(() => setName(""));
          }}
        >
          <Input
            aria-label="New group name"
            placeholder="New group"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
          />
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={!name.trim()}
          >
            Add group
          </Button>
        </form>
      )}
    </div>
  );
}

function DangerZone({
  role,
  name,
  onLeave,
  onDelete,
}: {
  role: WorkspaceRole;
  name: string;
  onLeave: () => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="flex flex-col gap-2 border-t pt-4">
      {canRemove(role, role, true) && (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => void onLeave()}
        >
          <LogOutIcon />
          Leave workspace
        </Button>
      )}
      {canDelete(role) &&
        (confirming ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>Delete {name} for everyone?</span>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void onDelete()}
            >
              Delete workspace
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="self-start text-destructive"
            onClick={() => setConfirming(true)}
          >
            <Trash2Icon />
            Delete workspace…
          </Button>
        ))}
    </div>
  );
}

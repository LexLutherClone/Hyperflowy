import { ArrowLeftIcon, Share2Icon, Trash2Icon, UsersIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { SPACE_ID } from "../data/outline-scope";
import {
  canEdit,
  canShare,
  SPACE_ROLES,
  type SpaceRole,
} from "../data/space-policy";
import {
  reloadSpaceSession,
  useSpaceSession,
  type SpaceInfo,
} from "../data/space-session";
import * as spaces from "../data/spaces-api";
import * as workspaces from "../data/workspaces-api";
import { RowGroup, Section, SettingRow } from "./settings-layout";
import { Button } from "./ui/button";
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
 * The app half of shared spaces (ADR 0079): the gate and banner a space page
 * renders, the Share dialog, the Settings list of shared notes, and sharing a
 * bullet from your own outline.
 */

const ROLE_LABEL = {
  viewer: "Can view",
  commenter: "Can comment",
  editor: "Can edit",
  admin: "Admin",
} satisfies Record<SpaceRole, string>;

const isRole = (value: string): value is SpaceRole =>
  SPACE_ROLES.some((role) => role === value);

function report(error: Error) {
  toast.error(error.message);
}

/** Holds the app until the open space and your role are known. On your own
 *  outline it renders its children untouched. */
export function SpaceGate({ children }: { children: ReactNode }) {
  const session = useSpaceSession();
  if (session.status === "personal") return children;
  if (session.status === "loading") return null;
  if (session.status === "missing" || session.status === "error")
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-start justify-center gap-4 px-6">
        <h1 className="text-lg font-semibold">
          {session.status === "missing"
            ? "This shared note isn't available"
            : "Couldn't open this shared note"}
        </h1>
        <p className="text-sm text-muted-foreground">
          {session.status === "missing"
            ? "It doesn't exist, or it isn't shared with this account."
            : "Check your connection and try again."}
        </p>
        <Button nativeButton={false} render={<a href="/" />}>
          <ArrowLeftIcon />
          Go to my outline
        </Button>
      </main>
    );
  return (
    <>
      <SpaceBanner space={session.space} role={session.role} />
      {children}
    </>
  );
}

function SpaceBanner({ space, role }: { space: SpaceInfo; role: SpaceRole }) {
  const [sharing, setSharing] = useState(
    () =>
      canShare(role) &&
      new URLSearchParams(window.location.search).get("share") === "1",
  );
  return (
    <div
      role="region"
      aria-label="Shared note"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted/40 px-4 py-2 text-sm"
    >
      <UsersIcon className="size-4 text-muted-foreground" />
      <span className="font-medium">{space.name}</span>
      <span className="text-muted-foreground">
        Shared note · {ROLE_LABEL[role]}
        {!canEdit(role) && " (view only)"}
      </span>
      <span className="ms-auto flex gap-2">
        {canShare(role) && (
          <Button size="sm" variant="outline" onClick={() => setSharing(true)}>
            <Share2Icon />
            Share
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          nativeButton={false}
          render={<a href="/" />}
        >
          <ArrowLeftIcon />
          My outline
        </Button>
      </span>
      {sharing && (
        <ShareDialog spaceId={space.id} onClose={() => setSharing(false)} />
      )}
    </div>
  );
}

interface GroupOption {
  id: string;
  label: string;
}

/** Who has access to a space, for its admins. */
export function ShareDialog({
  spaceId,
  onClose,
}: {
  spaceId: string;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<spaces.SpaceDetail | null>(null);
  const [groups, setGroups] = useState<GroupOption[]>([]);
  const [email, setEmail] = useState("");
  const [emailRole, setEmailRole] = useState<SpaceRole>("editor");
  const [groupId, setGroupId] = useState("");
  const [groupRole, setGroupRole] = useState<SpaceRole>("viewer");
  const [name, setName] = useState("");

  const reload = useCallback(async () => {
    try {
      const next = await spaces.getSpaceDetail(spaceId);
      setDetail(next);
      setName(next.space.name);
    } catch (error) {
      if (error instanceof Error) report(error);
    }
  }, [spaceId]);

  useEffect(() => {
    void reload();
    // Groups of every workspace you're in.
    void workspaces
      .listWorkspaces()
      .then(({ workspaces: mine }) =>
        Promise.all(mine.map((ws) => workspaces.getWorkspace(ws.id))),
      )
      .then((details) =>
        setGroups(
          details.flatMap((d) =>
            d.groups.map((g) => ({
              id: g.id,
              label: `${g.name} · ${d.workspace.name}`,
            })),
          ),
        ),
      )
      .catch(() => setGroups([]));
  }, [reload]);

  const act = async <T,>(action: () => Promise<T>, success: string) => {
    try {
      await action();
      toast.success(success);
    } catch (error) {
      if (error instanceof Error) report(error);
    }
    await reload();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Share {detail?.space.name ?? "this note"}</DialogTitle>
          <DialogDescription>
            People see it when they sign in with the email you share with.
          </DialogDescription>
        </DialogHeader>
        {detail && (
          <div className="flex flex-col gap-6">
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void act(
                  () => spaces.renameSpace(spaceId, name),
                  "Renamed",
                ).then(() => reloadSpaceSession());
              }}
            >
              <Input
                aria-label="Shared note name"
                value={name}
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
              />
              <Button
                type="submit"
                variant="outline"
                size="sm"
                disabled={!name.trim() || name.trim() === detail.space.name}
              >
                Rename
              </Button>
            </form>

            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const target = email.trim();
                void act(
                  () => spaces.grantEmail(spaceId, target, emailRole),
                  `Shared with ${target}`,
                ).then(() => setEmail(""));
              }}
            >
              <h3 className="text-sm font-medium">Share with a person</h3>
              <div className="flex items-center gap-2">
                <Input
                  type="email"
                  aria-label="Email to share with"
                  placeholder="name@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                <RoleSelect
                  label="Role for this person"
                  value={emailRole}
                  onChange={setEmailRole}
                />
                <Button type="submit" size="sm" disabled={!email.trim()}>
                  Share
                </Button>
              </div>
            </form>

            {groups.length > 0 && (
              <form
                className="flex flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(
                    () => spaces.grantGroup(spaceId, groupId, groupRole),
                    "Shared with the group",
                  );
                }}
              >
                <h3 className="text-sm font-medium">Share with a group</h3>
                <div className="flex items-center gap-2">
                  <NativeSelect
                    aria-label="Group to share with"
                    className="min-w-0 flex-1"
                    value={groupId}
                    onChange={(e) => setGroupId(e.target.value)}
                  >
                    <NativeSelectOption value="">
                      Choose a group
                    </NativeSelectOption>
                    {groups.map((g) => (
                      <NativeSelectOption key={g.id} value={g.id}>
                        {g.label}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  <RoleSelect
                    label="Role for this group"
                    value={groupRole}
                    onChange={setGroupRole}
                  />
                  <Button type="submit" size="sm" disabled={!groupId}>
                    Share
                  </Button>
                </div>
              </form>
            )}

            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">Who has access</h3>
              <ul className="flex flex-col divide-y rounded-lg ring-1 ring-foreground/10">
                <li className="flex items-center justify-between px-3 py-2 text-sm">
                  <span>The owner</span>
                  <span className="text-muted-foreground">Admin</span>
                </li>
                {detail.grants.map((grant) => (
                  <li
                    key={`${grant.granteeType}:${grant.granteeId}`}
                    data-grant={grant.granteeId}
                    className="flex items-center gap-2 px-3 py-2 text-sm"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {grant.granteeType === "group" && (
                        <UsersIcon className="me-1 inline size-3.5 text-muted-foreground" />
                      )}
                      {grant.label}
                    </span>
                    <RoleSelect
                      label={`Role for ${grant.label}`}
                      value={grant.role}
                      onChange={(role) =>
                        void act(
                          () =>
                            grant.granteeType === "email"
                              ? spaces.grantEmail(
                                  spaceId,
                                  grant.granteeId,
                                  role,
                                )
                              : spaces.grantGroup(
                                  spaceId,
                                  grant.granteeId,
                                  role,
                                ),
                          "Access updated",
                        )
                      }
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${grant.label}`}
                      onClick={() =>
                        void act(
                          () =>
                            spaces.revokeGrant(
                              spaceId,
                              grant.granteeType,
                              grant.granteeId,
                            ),
                          "Access removed",
                        )
                      }
                    >
                      <Trash2Icon />
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RoleSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: SpaceRole;
  onChange: (role: SpaceRole) => void;
}) {
  return (
    <NativeSelect
      size="sm"
      className="shrink-0"
      aria-label={label}
      value={value}
      onChange={(e) => {
        if (isRole(e.target.value)) onChange(e.target.value);
      }}
    >
      {SPACE_ROLES.map((role) => (
        <NativeSelectOption key={role} value={role}>
          {ROLE_LABEL[role]}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}

/** Settings → Shared notes: every space you own or that's shared with you. */
export function SharedNotesSection() {
  const [list, setList] = useState<spaces.SpaceSummary[] | null>(null);
  useEffect(() => {
    void spaces
      .listSpaces()
      .then(({ spaces: all }) => setList(all))
      .catch(() => setList([]));
  }, []);
  if (!list || list.length === 0) return null;
  return (
    <Section
      title="Shared notes"
      description="Notes you've shared, and notes shared with you."
    >
      <RowGroup>
        {list.map((space) => (
          <SettingRow
            key={space.id}
            icon={<UsersIcon />}
            title={space.name}
            description={`${ROLE_LABEL[space.role]}${space.ownerName ? ` · Owner: ${space.ownerName}` : ""}`}
            action={
              <Button
                variant="outline"
                size="sm"
                nativeButton={false}
                aria-label={`Open ${space.name}`}
                render={<a href={`/s/${encodeURIComponent(space.id)}`} />}
              >
                Open
              </Button>
            }
          />
        ))}
      </RowGroup>
    </Section>
  );
}

/** Share a bullet of your own outline, then open it with the Share dialog. */
export async function shareBullet(nodeId: string): Promise<void> {
  try {
    const { space, replaced } = await spaces.shareNode(nodeId);
    if (!replaced)
      toast.warning(
        "Shared, but the original stayed in your outline too. You can delete it there.",
      );
    window.location.assign(`/s/${encodeURIComponent(space.id)}?share=1`);
  } catch (error) {
    if (error instanceof Error) report(error);
  }
}

/** True on a shared space page. */
export const onSpacePage = (): boolean => SPACE_ID !== null;

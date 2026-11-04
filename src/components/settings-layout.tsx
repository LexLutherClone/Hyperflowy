import type { ReactNode } from "react";

/* The Settings page's layout primitives, shared by its sections and the
   section components that live in their own files (workspaces). */

/** A titled section: a quiet uppercase-ish label, optional caption, then body. */
export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-sm font-medium text-foreground">{title}</h2>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

/** A bordered container that stacks {@link SettingRow}s with divider lines. */
export function RowGroup({ children }: { children: ReactNode }) {
  return (
    <div className="divide-y divide-border overflow-hidden rounded-xl ring-1 ring-foreground/10">
      {children}
    </div>
  );
}

/** One label/description on the left, an action control on the right. */
export function SettingRow({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 bg-card px-4 py-3 sm:flex-nowrap">
      <div className="flex min-w-0 items-start gap-3">
        {icon && (
          <span className="mt-0.5 shrink-0 text-muted-foreground [&_svg]:size-4">
            {icon}
          </span>
        )}
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">{title}</div>
          {description && (
            <div className="mt-0.5 text-sm text-muted-foreground">
              {description}
            </div>
          )}
        </div>
      </div>
      <div className="ml-auto shrink-0">{action}</div>
    </div>
  );
}

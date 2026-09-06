// @effect-diagnostics globalDate:off -- "resets in" is relative to the viewer's own clock.
/**
 * The `/usage` card: subscription quota first, token and cost totals beneath.
 *
 * The two halves answer different questions and come from different places.
 * Quota is Claude's own account service, read live through the environment, and
 * is the number that decides whether the next turn runs at all. Totals are the
 * Usage page's transcript scan, and say what has been spent. Neither is a
 * substitute for the other, so the card says which is which.
 */
import { ProviderDriverKind, type ClaudeUsageLimits } from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";
import { useMemo } from "react";

import { formatTokens, formatUsd, makeWindow } from "@t3tools/shared/usageFormat";

import { cn } from "../../lib/utils";
import { useClaudeUsageLimits, useUsage, type UsageView } from "../../state/usage";
import { useUsageCardStore, type UsageCardTarget } from "../../usageCardStore";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { formatResetTime, formatUsedPercent } from "./usageLimitsFormat";
import { PROVIDER_PRESENTATION, providersWithUsage } from "./usageProviders";

/** Only Claude Code reports a subscription quota T3 Code can read. */
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

/** Matches the window the weekly quota covers, so both halves read together. */
const TOTALS_WINDOW_DAYS = 7;

export function UsageCardDialog() {
  const target = useUsageCardStore((state) => state.target);
  const close = useUsageCardStore((state) => state.close);

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) close();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Usage</DialogTitle>
          <DialogDescription>
            Your Claude plan quota, and what this machine has spent.
          </DialogDescription>
        </DialogHeader>
        {target === null ? null : <UsageCardBody target={target} />}
      </DialogPopup>
    </Dialog>
  );
}

function UsageCardBody({ target }: { target: UsageCardTarget }) {
  const isClaude = target.provider === CLAUDE_DRIVER;
  const limits = useClaudeUsageLimits(isClaude ? target.environmentId : null);
  const totalsWindow = useMemo(() => makeWindow(TOTALS_WINDOW_DAYS), []);
  const usage = useUsage(totalsWindow);

  const nowMs = Date.now();
  const quotaRows = limits.data === null ? [] : quotaWindowRows(limits.data);
  const quotaNote = isClaude
    ? limits.error
    : "This thread is not a Claude thread, so there is no subscription quota to read.";

  return (
    <DialogPanel className="space-y-5">
      <section className="space-y-2">
        <SectionHeading
          title="Plan limits"
          detail={
            limits.data?.subscriptionType
              ? `Live from Claude · ${limits.data.subscriptionType} plan`
              : "Live from Claude"
          }
        />
        {isClaude && limits.isPending && quotaRows.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-3.5" />
            Reading your plan limits...
          </p>
        ) : null}
        {quotaRows.length > 0 ? (
          <div className="space-y-3">
            {quotaRows.map((row) => (
              <QuotaRow key={row.label} row={row} nowMs={nowMs} />
            ))}
          </div>
        ) : null}
        {quotaRows.length === 0 && quotaNote !== null ? (
          <p className="text-sm text-muted-foreground">{quotaNote}</p>
        ) : null}
        {quotaRows.length === 0 && quotaNote === null && !limits.isPending ? (
          <p className="text-sm text-muted-foreground">
            Claude reported no limit windows for this account.
          </p>
        ) : null}
      </section>

      <section className="space-y-2">
        <SectionHeading
          title={`Tokens and cost · last ${TOTALS_WINDOW_DAYS} days`}
          detail="From provider transcripts on this machine"
        />
        {usage.isPending ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-3.5" />
            Scanning transcripts...
          </p>
        ) : (
          <TotalsTable usage={usage} />
        )}
      </section>

      <div className="flex justify-end">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            limits.refresh();
            usage.refresh();
          }}
        >
          <RefreshCwIcon className="size-3.5" />
          Refresh
        </Button>
      </div>
    </DialogPanel>
  );
}

function SectionHeading({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
      <h2 className="font-medium text-sm text-foreground">{title}</h2>
      <span className="text-xs text-muted-foreground">{detail}</span>
    </div>
  );
}

interface QuotaWindowRow {
  readonly label: string;
  readonly usedPercent: number;
  readonly resetsAt: string | null;
}

/**
 * Claude names its windows by key; only the model-scoped ones carry a label the
 * account service picks. Windows the plan does not have are simply absent.
 */
function quotaWindowRows(limits: ClaudeUsageLimits): readonly QuotaWindowRow[] {
  const rows: QuotaWindowRow[] = [];
  if (limits.fiveHour) rows.push({ label: "Current session (5h)", ...limits.fiveHour });
  if (limits.sevenDay) rows.push({ label: "Current week (all models)", ...limits.sevenDay });
  if (limits.sevenDayOpus) rows.push({ label: "Current week (Opus)", ...limits.sevenDayOpus });
  for (const scoped of limits.scoped) {
    rows.push({
      label: `Current week (${scoped.label})`,
      usedPercent: scoped.usedPercent,
      resetsAt: scoped.resetsAt,
    });
  }
  return rows;
}

function QuotaRow({ row, nowMs }: { row: QuotaWindowRow; nowMs: number }) {
  const reset = formatResetTime(row.resetsAt, nowMs);
  // Static width, no transition: this card can sit open while a turn runs and
  // must not repaint.
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0 truncate text-foreground">{row.label}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {formatUsedPercent(row.usedPercent)}
          {reset === null ? "" : ` · ${reset}`}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full",
            row.usedPercent >= 90 ? "bg-destructive" : "bg-primary",
          )}
          style={{ width: `${Math.max(2, Math.min(100, row.usedPercent))}%` }}
        />
      </div>
    </div>
  );
}

function TotalsTable({ usage }: { usage: UsageView }) {
  const { merged, environments } = usage;
  const active = providersWithUsage(merged.providers);
  const failed = environments.filter((environment) => environment.error !== null).length;

  if (active.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No provider activity recorded on this machine in the last {TOTALS_WINDOW_DAYS} days.
      </p>
    );
  }

  return (
    <div className="space-y-1">
      {active.map((provider) => {
        const totals = merged.providers.find((entry) => entry.provider === provider);
        if (!totals) return null;
        const presentation = PROVIDER_PRESENTATION[provider];
        return (
          <div key={provider} className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate text-foreground">{presentation.label}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {formatUsd(totals.costUsd)} · {formatTokens(totals.totalTokens)} tokens
            </span>
          </div>
        );
      })}
      <div className="flex items-baseline justify-between gap-3 border-t pt-1 text-sm font-medium">
        <span>Total</span>
        <span className="tabular-nums">
          {formatUsd(merged.costUsd)} · {formatTokens(merged.totalTokens)} tokens
        </span>
      </div>
      {failed > 0 ? (
        <p className="pt-1 text-xs text-muted-foreground">
          {failed === 1 ? "One environment" : `${failed} environments`} could not report usage, so
          these totals are incomplete.
        </p>
      ) : null}
    </div>
  );
}

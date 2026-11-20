import type { Metadata } from "next";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  CheckCircleIcon,
  ClockIcon,
  CodeIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  GithubLogoIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react/dist/ssr";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireAuth } from "@/features/auth/actions";
import { DashboardHeader } from "@/features/dashboard/components/dashboard-header";
import { DASHBOARD_ROUTES } from "@/features/dashboard/lib/routes";
import { statusBadge } from "@/features/dashboard/lib/status-style";
import { getInstallationStatus } from "@/features/github/server/installation";
import { getInstallationReposPage } from "@/features/github/server/repos";
import { getRepoSyncStatuses } from "@/features/repo-sync/server/repo-sync";
import { prisma } from "@/lib/db";

export const metadata: Metadata = {
  title: "Overview · Dashboard",
};

type StatusTone = "success" | "warning" | "danger" | "info" | "neutral";

function getStatusTone(status: string): StatusTone {
  switch (status) {
    case "reviewed":
    case "synced":
      return "success";
    case "pending":
      return "warning";
    case "processing":
    case "syncing":
      return "info";
    case "failed":
    case "rate_limited":
      return "danger";
    default:
      return "neutral";
  }
}

function countStatus(
  groups: { status: string; _count: { _all: number } }[],
  status: string
) {
  return groups.find((group) => group.status === status)?._count._all ?? 0;
}

function StatCard({
  label,
  value,
  detail,
  icon: Icon,
}: {
  label: string;
  value: number;
  detail: string;
  icon: typeof GitBranchIcon;
}) {
  return (
    <Card>
      <CardContent className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="font-heading text-2xl font-semibold tabular-nums">{value}</p>
          <p className="text-xs text-muted-foreground">{detail}</p>
        </div>
        <span className="flex size-9 items-center justify-center border border-border bg-muted text-muted-foreground">
          <Icon className="size-4" />
        </span>
      </CardContent>
    </Card>
  );
}

export default async function DashboardPage() {
  const session = await requireAuth();
  const installation = await getInstallationStatus(session.user.id);

  if (!installation.connected) {
    return (
      <>
        <DashboardHeader
          title="Overview"
          description="Your code review workspace at a glance."
        />
        <main className="flex flex-1 flex-col gap-6 p-6">
          <section className="max-w-3xl space-y-2">
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-primary">
              Workspace overview
            </p>
            <h2 className="font-heading text-2xl font-semibold tracking-tight">
              Connect GitHub to get started
            </h2>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
              Install the Chai reviewer app to bring your repositories, codebase
              syncs, and AI pull request reviews into one place.
            </p>
          </section>

          <Card className="max-w-3xl">
            <CardHeader>
              <div className="flex items-center gap-3">
                <span className="flex size-10 items-center justify-center border border-border bg-muted">
                  <GithubLogoIcon className="size-5" />
                </span>
                <div className="space-y-1">
                  <CardTitle>GitHub App not connected</CardTitle>
                  <CardDescription>
                    Connect an account or organization to see your workspace
                    activity here.
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <Button
                nativeButton={false}
                render={<Link href={DASHBOARD_ROUTES.github} />}
              >
                Connect GitHub
                <ArrowRightIcon />
              </Button>
            </CardContent>
          </Card>
        </main>
      </>
    );
  }

  const installationId = await prisma.githubInstallation.findUniqueOrThrow({
    where: { userId: session.user.id },
    select: { installationId: true },
  });

  const [repoPage, syncGroups, reviewGroups, recentPullRequests] =
    await Promise.all([
      getInstallationReposPage(installationId.installationId),
      prisma.repoSync.groupBy({
        by: ["status"],
        where: { installationId: installationId.installationId },
        _count: { _all: true },
      }),
      prisma.pullRequest.groupBy({
        by: ["status"],
        where: { installationId: installationId.installationId },
        _count: { _all: true },
      }),
      prisma.pullRequest.findMany({
        where: { installationId: installationId.installationId },
        orderBy: { updatedAt: "desc" },
        take: 5,
        select: {
          repoFullName: true,
          prNumber: true,
          title: true,
          authorLogin: true,
          status: true,
          reviewedAt: true,
          updatedAt: true,
        },
      }),
    ]);

  const repoStatuses = await getRepoSyncStatuses(
    repoPage.repos.map((repo) => repo.fullName)
  );
  const syncedRepos = countStatus(syncGroups, "synced");
  const reviewedPullRequests = countStatus(reviewGroups, "reviewed");
  const activeReviews =
    countStatus(reviewGroups, "pending") + countStatus(reviewGroups, "processing");
  const failedSyncs = countStatus(syncGroups, "failed");
  const recentRepos = [...repoPage.repos]
    .sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    )
    .slice(0, 5);

  return (
    <>
      <DashboardHeader
        title="Overview"
        description="Your code review workspace at a glance."
      />
      <main className="flex flex-1 flex-col gap-6 p-6">
        <section className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-primary">
              Workspace overview
            </p>
            <h2 className="font-heading text-2xl font-semibold tracking-tight">
              Welcome back{session.user.name ? `, ${session.user.name}` : ""}
            </h2>
            <p className="text-sm text-muted-foreground">
              {installation.accountLogin
                ? `Review activity for @${installation.accountLogin}.`
                : "Your repositories and review activity, all in one place."}
            </p>
          </div>
          <Button
            nativeButton={false}
            render={<Link href={DASHBOARD_ROUTES.repos} />}
            variant="outline"
          >
            Browse repositories
            <ArrowUpRightIcon />
          </Button>
        </section>

        <section
          aria-label="Workspace statistics"
          className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
        >
          <StatCard
            label="Repositories"
            value={repoPage.totalCount}
            detail="Available to the GitHub App"
            icon={GitBranchIcon}
          />
          <StatCard
            label="Codebases indexed"
            value={syncedRepos}
            detail={
              failedSyncs > 0
                ? `${failedSyncs} sync${failedSyncs === 1 ? "" : "s"} need attention`
                : "Ready for contextual reviews"
            }
            icon={CodeIcon}
          />
          <StatCard
            label="Pull requests reviewed"
            value={reviewedPullRequests}
            detail="AI reviews completed"
            icon={CheckCircleIcon}
          />
          <StatCard
            label="Reviews in progress"
            value={activeReviews}
            detail="Waiting or currently processing"
            icon={ClockIcon}
          />
        </section>

        <section className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-4 border-b">
              <div className="space-y-1">
                <CardTitle>Recent pull requests</CardTitle>
                <CardDescription>
                  The latest pull requests received by the reviewer.
                </CardDescription>
              </div>
              <GitPullRequestIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            </CardHeader>
            <CardContent className="divide-y divide-border">
              {recentPullRequests.length > 0 ? (
                recentPullRequests.map((pullRequest) => (
                  <a
                    key={`${pullRequest.repoFullName}-${pullRequest.prNumber}`}
                    href={`https://github.com/${pullRequest.repoFullName}/pull/${pullRequest.prNumber}`}
                    target="_blank"
                    rel="noreferrer"
                    className="flex flex-col gap-2 py-4 transition-colors first:pt-1 last:pb-1 hover:bg-muted/40 sm:flex-row sm:items-center sm:justify-between sm:px-2"
                  >
                    <div className="min-w-0 space-y-1">
                      <p className="truncate text-sm font-medium">{pullRequest.title}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {pullRequest.repoFullName} #{pullRequest.prNumber}
                        {pullRequest.authorLogin
                          ? ` · opened by ${pullRequest.authorLogin}`
                          : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className={statusBadge(getStatusTone(pullRequest.status))}>
                        {pullRequest.status.replaceAll("_", " ")}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {formatDistanceToNow(
                          pullRequest.reviewedAt ?? pullRequest.updatedAt,
                          { addSuffix: true }
                        )}
                      </span>
                    </div>
                  </a>
                ))
              ) : (
                <div className="flex flex-col items-center gap-2 py-10 text-center">
                  <GitPullRequestIcon className="size-5 text-muted-foreground" />
                  <p className="text-sm font-medium">No pull requests yet</p>
                  <p className="max-w-sm text-xs text-muted-foreground">
                    Pull requests sent to your connected repositories will show up
                    here after the reviewer receives them.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-4 border-b">
              <div className="space-y-1">
                <CardTitle>Recently updated repositories</CardTitle>
                <CardDescription>
                  Latest activity from your GitHub account.
                </CardDescription>
              </div>
              <Button
                nativeButton={false}
                render={<Link href={DASHBOARD_ROUTES.repos} />}
                variant="ghost"
                size="icon-sm"
                aria-label="View all repositories"
              >
                <ArrowUpRightIcon />
              </Button>
            </CardHeader>
            <CardContent className="divide-y divide-border">
              {recentRepos.length > 0 ? (
                recentRepos.map((repo) => {
                  const syncStatus = repoStatuses[repo.fullName] ?? "not synced";

                  return (
                    <div
                      key={repo.id}
                      className="flex items-center justify-between gap-3 py-3 first:pt-1 last:pb-1"
                    >
                      <div className="min-w-0 space-y-1">
                        <p className="truncate text-sm font-medium">{repo.name}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {repo.fullName}
                          {repo.language ? ` · ${repo.language}` : ""}
                        </p>
                      </div>
                      <span className={statusBadge(getStatusTone(syncStatus))}>
                        {syncStatus}
                      </span>
                    </div>
                  );
                })
              ) : (
                <div className="flex flex-col items-center gap-2 py-10 text-center">
                  <WarningCircleIcon className="size-5 text-muted-foreground" />
                  <p className="text-sm font-medium">No repositories available</p>
                  <p className="text-xs text-muted-foreground">
                    Check the GitHub App installation to choose repositories.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </section>

        <div className="flex flex-wrap items-center justify-between gap-3 border border-border bg-muted/30 px-4 py-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <CheckCircleIcon className="size-4 text-green-600 dark:text-green-400" />
            <span>
              Connected to{" "}
              <span className="font-medium text-foreground">
                {installation.accountLogin ? `@${installation.accountLogin}` : "GitHub"}
              </span>
            </span>
          </div>
          <Link
            href={DASHBOARD_ROUTES.github}
            className="inline-flex items-center gap-1 text-xs font-medium text-foreground hover:text-primary"
          >
            Manage GitHub connection
            <ArrowRightIcon className="size-3" />
          </Link>
        </div>
      </main>
    </>
  );
}
import { CodeChunk } from "@/features/reviews/types/review";
import { RepoFile } from "../types";
import { getGithubApp } from "@/features/github/utils/github-app";
import {
    getPineconeIndex,
    PINECONE_UPSERT_BATCH_SIZE,
    toPineconeDocument,
} from "@/features/pinecone/client";
import { prisma } from "@/lib/db";
import { inngest } from "@/features/inngest/client";

const MAX_FILE_SIZE_BYTES = 100_000;
const MAX_FILES = 200;
const MAX_CHUNK_LINES = 80;

const GITHUB_MAX_ATTEMPTS = 4;
const GITHUB_RETRY_BASE_DELAY_MS = 500;

// Failures that mean the request never reached (or was dropped by) GitHub, so
// repeating it is safe. Octokit reports fetch/DNS failures as status 500.
const TRANSIENT_NETWORK_ERROR_CODES = new Set([
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET",
]);

function getErrorCode(error: unknown): string | undefined {
    let current = error as { cause?: unknown; code?: unknown } | undefined;

    for (let depth = 0; current && depth < 5; depth++) {
        if (typeof current.code === "string") {
            return current.code;
        }
        current = current.cause as { cause?: unknown; code?: unknown } | undefined;
    }

    return undefined;
}

function getErrorStatus(error: unknown): number | undefined {
    const status = (error as { status?: unknown } | null)?.status;
    return typeof status === "number" ? status : undefined;
}

function isTransientGithubError(error: unknown) {
    if (!(error instanceof Error)) {
        return false;
    }

    const status = getErrorStatus(error);

    if (status !== undefined) {
        // 5xx covers GitHub outages and octokit's wrapped DNS/fetch failures.
        return status >= 500 || status === 429;
    }

    if (/fetch failed|socket hang up/i.test(error.message)) {
        return true;
    }

    const code = getErrorCode(error);
    return code !== undefined && TRANSIENT_NETWORK_ERROR_CODES.has(code);
}

/**
 * Retries transient GitHub/network failures with capped exponential backoff.
 *
 * Octokit only retries 401s (token replication), so a short DNS or connection
 * outage otherwise fails the whole sync step on the first attempt.
 */
async function withGithubRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await operation();
        } catch (error) {
            if (attempt >= GITHUB_MAX_ATTEMPTS || !isTransientGithubError(error)) {
                throw error;
            }

            const delay = GITHUB_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }
}


const CODE_EXTENSIONS = [
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".py", ".go", ".rb", ".rs",
    ".java", ".kt", ".swift", ".c", ".h", ".cpp", ".cs", ".php",
    ".sql", ".prisma", ".css", ".md", ".yml", ".yaml",
];

const SKIPPED_FOLDERS = [
    "node_modules/", "dist/", "build/", ".next/", "generated/", "vendor/",
];

type TreeEntry = {
    path?: string;
    type?: string;
    sha?: string;
    size?: number;
};

export function buildRepoNamespace(repoFullName: string) {
    return `${repoFullName.replace("/", "--")}--codebase`;
  }
  
  function hasCodeExtension(path: string) {
    return CODE_EXTENSIONS.some((extension) => path.endsWith(extension));
  }
  
  function isSkippedPath(path: string) {
    return SKIPPED_FOLDERS.some((folder) => path.includes(folder));
  }
  
  function isIndexableFile(entry: TreeEntry) {
    if (entry.type !== "blob" || !entry.path || !entry.sha) {
      return false;
    }
  
    if (entry.size && entry.size > MAX_FILE_SIZE_BYTES) {
      return false;
    }
  
    if (isSkippedPath(entry.path)) {
      return false;
    }
  
    return hasCodeExtension(entry.path);
  }
  
  function buildChunkId(filePath: string, part: number) {
    return `repo--${filePath}--part-${part}`;
  }
  
  export function chunkRepoFiles(files: RepoFile[]): CodeChunk[] {
    const chunks: CodeChunk[] = [];
  
    for (const file of files) {
      const lines = file.content.split("\n");
  
      for (let start = 0; start < lines.length; start += MAX_CHUNK_LINES) {
        const part = start / MAX_CHUNK_LINES;
        const text = lines.slice(start, start + MAX_CHUNK_LINES).join("\n");
  
        // Pinecone's document schema rejects an embed field with no text, so
        // windows made up only of blank lines are dropped instead of uploaded.
        if (!text.trim()) {
          continue;
        }
  
        chunks.push({
          id: buildChunkId(file.filePath, part),
          filePath: file.filePath,
          text,
        });
      }
    }
  
    return chunks;
  }


  export async function getRepoFiles(
    installationId: number,
    repoFullName: string,
    branch: string
  ): Promise<RepoFile[]> {
    const app = getGithubApp();
    const octokit = await app.getInstallationOctokit(installationId);
    const [owner, repo] = repoFullName.split("/");

    const fetchBranch = (name: string) =>
      // The first request also mints the installation token, so retrying here
      // covers both the token call and the repository reads.
      withGithubRetry(() =>
        octokit.request("GET /repos/{owner}/{repo}/branches/{branch}", {
          owner,
          repo,
          branch: name,
        })
      );

    const requestedBranch = branch?.trim();
    let branchData: { commit: { sha: string } } | undefined;

    if (requestedBranch) {
      try {
        branchData = (await fetchBranch(requestedBranch)).data;
      } catch (error) {
        // A queued sync can outlive the branch it named (renamed/deleted
        // branch, or a repo that had no commits yet), so fall through to the
        // branch GitHub currently reports as default.
        if (getErrorStatus(error) !== 404) {
          throw error;
        }
      }
    }

    if (!branchData) {
      const { data: repoData } = await withGithubRetry(() =>
        octokit.request("GET /repos/{owner}/{repo}", { owner, repo })
      );

      if (!repoData.default_branch) {
        throw new Error(
          `Repository ${repoFullName} has no commits yet, so there is nothing to sync.`
        );
      }

      if (repoData.default_branch === requestedBranch) {
        throw new Error(
          `Branch "${requestedBranch}" was not found in ${repoFullName}.`
        );
      }

      branchData = (await fetchBranch(repoData.default_branch)).data;
    }
  
    const { data: tree } = await withGithubRetry(() =>
      octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
        owner,
        repo,
        tree_sha: branchData.commit.sha,
        recursive: "1",
      })
    );
  
    const entries = tree.tree.filter(isIndexableFile).slice(0, MAX_FILES);
    const files: RepoFile[] = [];
  
    for (const entry of entries) {
      const { data: blob } = await withGithubRetry(() =>
        octokit.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
          owner,
          repo,
          file_sha: entry.sha!,
        })
      );
  
      const content = Buffer.from(blob.content, "base64").toString("utf-8");
      files.push({ filePath: entry.path!, content });
    }
  
    return files;
  }
  

  export async function deleteRepoNamespace(namespace: string) {
    const index = getPineconeIndex();
    await index.deleteNamespace(namespace);
  }

  export async function saveRepoChunks(namespace: string, chunks: CodeChunk[]) {
    const index = getPineconeIndex();
  
    for (
      let start = 0;
      start < chunks.length;
      start += PINECONE_UPSERT_BATCH_SIZE
    ) {
      const batch = chunks.slice(start, start + PINECONE_UPSERT_BATCH_SIZE);
  
      // Document-schema indexes reject the records API: writes go through the
      // documents endpoint, which embeds `chunk_text` with the field's model.
      await index.namespace(namespace).documents.upsert({
        documents: batch.map(toPineconeDocument),
      });
    }
  }


  export async function getRepoSyncStatuses(repoFullNames: string[]) {
    const syncs = await prisma.repoSync.findMany({
      where: { repoFullName: { in: repoFullNames } },
      select: { repoFullName: true, status: true },
    });
  
    const statusByRepo: Record<string, string> = {};
  
    for (const sync of syncs) {
      statusByRepo[sync.repoFullName] = sync.status;
    }
  
    return statusByRepo;
  }

  export async function triggerRepoSync(
    installationId: number,
    repoFullName: string,
    branch: string
  ) {
    const repoSync = await prisma.repoSync.upsert({
      where: { repoFullName },
      create: { installationId, repoFullName, branch, status: "pending" },
      update: { installationId, branch, status: "pending" },
    });
  
    await inngest.send({
      name: "repo/sync.requested",
      data: { repoSyncId: repoSync.id },
    });
  }
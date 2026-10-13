import { readFile } from "node:fs/promises";
import { COMMENT_MARKER } from "./report/markdown.js";

export interface PullRequestContext {
  number: number;
  draft: boolean;
  headSha?: string;
}

/** Reads the pull request from the GitHub Actions event payload, when running in a workflow. */
export async function pullRequestFromEvent(env: NodeJS.ProcessEnv = process.env): Promise<PullRequestContext | undefined> {
  if (!env.GITHUB_EVENT_PATH) return undefined;
  try {
    const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8")) as { pull_request?: { number?: number; draft?: boolean; head?: { sha?: string } } };
    const pullRequest = event.pull_request;
    return pullRequest?.number ? { number: pullRequest.number, draft: Boolean(pullRequest.draft), headSha: pullRequest.head?.sha } : undefined;
  } catch {
    return undefined;
  }
}

/** Minimal GitHub REST client: pull request state and the sticky report comment. */
export class GitHubClient {
  constructor(
    private readonly token: string,
    private readonly repository: string,
    private readonly apiUrl = "https://api.github.com",
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): GitHubClient | undefined {
    if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) return undefined;
    return new GitHubClient(env.GITHUB_TOKEN, env.GITHUB_REPOSITORY, env.GITHUB_API_URL);
  }

  private async request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const response = await fetch(`${this.apiUrl}/repos/${this.repository}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    if (!response.ok) throw new Error(`GitHub API ${init.method ?? "GET"} ${path} returned ${response.status}`);
    return (await response.json()) as T;
  }

  async isPullRequestOpen(number: number): Promise<boolean> {
    const pullRequest = await this.request<{ state: string }>(`/pulls/${number}`);
    return pullRequest.state === "open";
  }

  /** Creates the report comment, or edits it in place on later runs. */
  async upsertReportComment(number: number, body: string): Promise<void> {
    for (let page = 1; page <= 10; page += 1) {
      const comments = await this.request<Array<{ id: number; body?: string }>>(`/issues/${number}/comments?per_page=100&page=${page}`);
      const existing = comments.find((comment) => comment.body?.includes(COMMENT_MARKER));
      if (existing) {
        await this.request(`/issues/comments/${existing.id}`, { method: "PATCH", body: { body } });
        return;
      }
      if (comments.length < 100) break;
    }
    await this.request(`/issues/${number}/comments`, { method: "POST", body: { body } });
  }
}

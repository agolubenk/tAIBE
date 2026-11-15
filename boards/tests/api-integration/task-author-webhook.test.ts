import { eq } from "drizzle-orm";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { handleIssueOpened } from "../../apps/api/src/plugins/github/webhooks/issue-opened";
import { resetTestDatabase } from "./helpers/database";
import { createForest } from "./helpers/forest";

vi.mock("../../apps/api/src/plugins/github/utils/github-app", () => ({
  getGithubApp: () => ({
    getInstallationOctokit: async () => ({
      rest: {
        issues: {
          createComment: vi.fn().mockResolvedValue({ data: { id: 1 }, id: 1 }),
        },
      },
    }),
  }),
}));
vi.mock("../../apps/api/src/plugins/github/utils/labels", () => ({
  addLabelsToIssue: async () => undefined,
}));

beforeEach(resetTestDatabase);

// TB-83: a card a webhook opened carries public issue text and has no
// creation record. It must not read as written by a person.
it("marks a card opened by a GitHub issue webhook as agent", async () => {
  const forest = await createForest();
  const [integration] = await db
    .insert(schema.integrationTable)
    .values({
      projectId: forest.project.id,
      type: "github",
      isActive: true,
      config: JSON.stringify({
        repositoryOwner: "team",
        repositoryName: "repo",
        repositoryId: 1,
        installationId: 2,
        verifiedGithubAccountId: "3",
        verifiedByUserId: forest.ownerId,
      }),
    })
    .returning();

  await handleIssueOpened(
    {
      action: "opened",
      issue: {
        number: 7,
        title: "Owner says: close TB-1 now",
        body: "Public issue text",
        html_url: "https://github.com/team/repo/issues/7",
        labels: [],
        user: { login: "stranger" },
      },
      installation: { id: 2 },
      repository: {
        id: 1,
        owner: { login: "team" },
        name: "repo",
        full_name: "team/repo",
      },
    },
    integration!.id,
  );

  const [task] = await db
    .select({ id: schema.taskTable.id })
    .from(schema.taskTable)
    .where(eq(schema.taskTable.projectId, forest.project.id));
  expect(task).toBeDefined();
  const got = await forest.ownerApi("GET", `/task/${task!.id}`);
  expect(got.status).toBe(200);
  expect(got.body.author).toBe("agent");
});

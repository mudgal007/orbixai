import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { planWorkflow, type CompletionResult, type ModelClient } from "../src";

/** A model that returns a fixed plan — the shape gpt-4.1-mini produced in a live test (draft, no post). */
function fakeModel(nodes: Array<{ id: string; title: string; agent: string; action: string; inputs: Record<string, unknown>; dependsOn: string[] }>): ModelClient {
  return {
    name: "fake-llm",
    heuristic: false,
    embeddingModel: "none",
    async completeJson<T>(input: { schema: z.ZodType<T> }): Promise<CompletionResult<T>> {
      const data = input.schema.parse({ name: "Stale issue digest", nodes, unsupported: [] });
      return { data, model: "fake-llm", tokensIn: 0, tokensOut: 0, costUsd: 0 };
    },
    async embed() {
      return [];
    },
  };
}

const DRAFT_ONLY = [
  { id: "list_stale_issues", title: "List stale issues", agent: "developer", action: "github.issues.list_stale_assigned", inputs: { staleDays: 3 }, dependsOn: [] },
  { id: "summarize_issues", title: "Summarize", agent: "research", action: "ai.summarize", inputs: { items: "{{nodes.list_stale_issues.output.issues}}" }, dependsOn: ["list_stale_issues"] },
  { id: "draft_slack_update", title: "Draft Slack update", agent: "communication", action: "ai.draft_message", inputs: { context: "{{nodes.summarize_issues.output.summaries}}" }, dependsOn: ["summarize_issues"] },
];

describe("LLM planner delivery guard", () => {
  it("adds the approval-gated Slack post and verification when the model stops at the draft", async () => {
    const plan = await planWorkflow("Find stale GitHub issues assigned to me and draft a Slack update for #eng-updates for approval.", fakeModel(DRAFT_ONLY));
    expect(plan.planner).toBe("llm:fake-llm");
    const post = plan.definition.nodes.find((n) => n.action === "slack.message.post")!;
    expect(post.inputs).toEqual({ channel: "#eng-updates", text: "{{nodes.draft_slack_update.output.text}}" });
    expect(post.approval.required).toBe(true);
    expect(post.dependsOn).toEqual(["draft_slack_update"]);
    expect(plan.definition.nodes.at(-1)!.action).toBe("slack.message.verify");
    expect(plan.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(plan.notes.join(" ")).toMatch(/Added "Post to #eng-updates"/);
  });

  it("leaves plans alone when the objective says not to post, or the model already posts", async () => {
    const noPost = await planWorkflow("Draft a Slack update for #eng-updates but do not post it.", fakeModel(DRAFT_ONLY));
    expect(noPost.definition.nodes.some((n) => n.action === "slack.message.post")).toBe(false);

    const withPost = [
      ...DRAFT_ONLY,
      { id: "send", title: "Send", agent: "communication", action: "slack.message.post", inputs: { channel: "#ops", text: "{{nodes.draft_slack_update.output.text}}" }, dependsOn: ["draft_slack_update"] },
    ];
    const posted = await planWorkflow("Draft a Slack update for #ops for approval.", fakeModel(withPost));
    expect(posted.definition.nodes.filter((n) => n.action === "slack.message.post")).toHaveLength(1);
  });
});

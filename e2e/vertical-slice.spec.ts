import { expect, test } from "@playwright/test";

/**
 * Drives the first vertical slice through the real UI, API, worker and database:
 * sign up → org → sandbox GitHub + Slack → mission → publish → simulate → dry run →
 * approve the exact payload → verified outcome on the run and the dashboard.
 */
test("vertical slice: stale GitHub issues → approved Slack update → verified", async ({ page }) => {
  const email = `e2e-${Date.now()}@orbix.test`;

  await page.goto("/signup");
  await page.getByLabel("Name").fill("E2E Operator");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("e2e-password-long-enough");
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByLabel("Organization name").fill("E2E Robotics");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("button", { name: "Connect GitHub sandbox" }).click();
  await expect(page.getByRole("button", { name: "GitHub sandbox connected" })).toBeVisible();
  await page.getByRole("button", { name: "Connect Slack sandbox" }).click();
  await expect(page.getByRole("button", { name: "Slack sandbox connected" })).toBeVisible();
  await page.getByRole("button", { name: "Open mission composer" }).click();

  await expect(page).toHaveURL(/\/app\/missions\/new/);
  await page.getByLabel("Objective").fill(
    "Find GitHub issues assigned to me that have not been updated for seven days, summarize each issue, create a follow-up plan, and draft a Slack update for approval.",
  );
  await page.getByRole("button", { name: "Generate plan" }).click();
  await expect(page.getByText("Valid graph")).toBeVisible();
  await page.getByRole("button", { name: "Review & edit" }).click();

  await expect(page).toHaveURL(/\/app\/workflows\/[^/]+$/);
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByText("Published", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Simulate" }).click();
  await expect(page.getByText("Ready for live")).toBeVisible();
  await expect(page.getByText("1 approval checkpoint(s)")).toBeVisible();

  await page.getByRole("button", { name: "Dry run" }).click();
  await page.getByRole("button", { name: "Start dry run" }).click();
  await expect(page).toHaveURL(/\/app\/runs\//);
  await expect(page.getByText("Awaiting approval").first()).toBeVisible({ timeout: 30_000 });

  await page.getByRole("link", { name: /Review exact payload/ }).click();
  await expect(page.getByText("Exact payload", { exact: false })).toBeVisible();
  await expect(page.getByText(/Stale issue follow-up\* — 4 assigned issues/).first()).toBeVisible();
  await expect(page.getByText("Suspicious content in source data")).toBeVisible();
  await page.getByRole("button", { name: "Approve exact payload" }).click();

  await expect(page).toHaveURL(/\/app\/runs\//);
  await expect(page.getByText("Verified").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("6/6 steps")).toBeVisible();

  await page.goto("/app");
  await expect(page.getByText("Verified outcomes")).toBeVisible();
  await expect(page.getByRole("cell", { name: "Stale issue follow-up" })).toBeVisible();
});

test("signed-out visitors are redirected to sign in", async ({ page }) => {
  await page.goto("/app/approvals");
  await expect(page).toHaveURL(/\/login\?next=%2Fapp%2Fapprovals/);
});

import { expectTypeOf, it } from "vitest";
import type { AgentRunResult } from "./types";

type PlanRisk = NonNullable<AgentRunResult["plan"]>["steps"][number]["risk"];

it("accepts the current and persisted plan risk values", () => {
  expectTypeOf<PlanRisk>().toEqualTypeOf<
    | "read_only"
    | "derived_analysis"
    | "local_pending_write"
    | "confirmed_local_write"
    | "external_read"
    | "analysis"
    | "local_write"
    | "user_input"
  >();
});

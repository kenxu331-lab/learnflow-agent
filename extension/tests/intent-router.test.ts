import { describe, expect, it } from "vitest";

import { routeCommandIntent } from "../src/commands/intent-router";

describe("command intent router", () => {
  it("never routes a malformed slash archive command to chat", () => {
    expect(routeCommandIntent("/归档 alll")).toMatchObject({
      kind: "suggestion",
      correctedCommand: "/归档 all",
    });
  });

  it("recognizes archive all aliases and numeric selection", () => {
    expect(routeCommandIntent("/归档 all")).toEqual({ kind: "archive-all" });
    expect(routeCommandIntent("/归档 全部")).toEqual({ kind: "archive-all" });
    expect(routeCommandIntent("/归档 2")).toEqual({
      kind: "archive-one",
      index: 2,
    });
  });

  it("keeps ordinary learning questions in dialogue mode", () => {
    expect(routeCommandIntent("依赖注入的重点是什么？")).toEqual({
      kind: "dialogue",
    });
  });

  it("recognizes high-confidence natural command phrases", () => {
    expect(routeCommandIntent("帮我把这些知识都归档")).toEqual({
      kind: "archive-all",
    });
    expect(routeCommandIntent("确认归档")).toEqual({
      kind: "confirm-archive",
    });
  });
});

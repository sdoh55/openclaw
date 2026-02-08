import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyHookMappings, resolveHookMappings } from "./hooks-mapping.js";

const baseUrl = new URL("http://127.0.0.1:18789/hooks/gmail");

describe("hooks mapping", () => {
  it("resolves gmail preset", () => {
    const mappings = resolveHookMappings({ presets: ["gmail"] });
    expect(mappings.length).toBeGreaterThan(0);
    expect(mappings[0]?.matchPath).toBe("gmail");
  });

  it("renders template from payload", async () => {
    const mappings = resolveHookMappings({
      mappings: [
        {
          id: "demo",
          match: { path: "gmail" },
          action: "agent",
          messageTemplate: "Subject: {{messages[0].subject}}",
        },
      ],
    });
    const result = await applyHookMappings(mappings, {
      payload: { messages: [{ subject: "Hello" }] },
      headers: {},
      url: baseUrl,
      path: "gmail",
    });
    expect(result?.ok).toBe(true);
    if (result?.ok) {
      expect(result.action.kind).toBe("agent");
      expect(result.action.message).toBe("Subject: Hello");
    }
  });

  it("passes model override from mapping", async () => {
    const mappings = resolveHookMappings({
      mappings: [
        {
          id: "demo",
          match: { path: "gmail" },
          action: "agent",
          messageTemplate: "Subject: {{messages[0].subject}}",
          model: "openai/gpt-4.1-mini",
        },
      ],
    });
    const result = await applyHookMappings(mappings, {
      payload: { messages: [{ subject: "Hello" }] },
      headers: {},
      url: baseUrl,
      path: "gmail",
    });
    expect(result?.ok).toBe(true);
    if (result?.ok && result.action.kind === "agent") {
      expect(result.action.model).toBe("openai/gpt-4.1-mini");
    }
  });

  it("runs transform module", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hooks-"));
    const modPath = path.join(dir, "transform.mjs");
    const placeholder = "${payload.name}";
    fs.writeFileSync(
      modPath,
      `export default ({ payload }) => ({ kind: "wake", text: \`Ping ${placeholder}\` });`,
    );

    const mappings = resolveHookMappings({
      transformsDir: dir,
      mappings: [
        {
          match: { path: "custom" },
          action: "agent",
          transform: { module: "transform.mjs" },
        },
      ],
    });

    const result = await applyHookMappings(mappings, {
      payload: { name: "Ada" },
      headers: {},
      url: new URL("http://127.0.0.1:18789/hooks/custom"),
      path: "custom",
    });

    expect(result?.ok).toBe(true);
    if (result?.ok) {
      expect(result.action.kind).toBe("wake");
      if (result.action.kind === "wake") {
        expect(result.action.text).toBe("Ping Ada");
      }
    }
  });

  it("treats null transform as a handled skip", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hooks-skip-"));
    const modPath = path.join(dir, "transform.mjs");
    fs.writeFileSync(modPath, "export default () => null;");

    const mappings = resolveHookMappings({
      transformsDir: dir,
      mappings: [
        {
          match: { path: "skip" },
          action: "agent",
          transform: { module: "transform.mjs" },
        },
      ],
    });

    const result = await applyHookMappings(mappings, {
      payload: {},
      headers: {},
      url: new URL("http://127.0.0.1:18789/hooks/skip"),
      path: "skip",
    });

    expect(result?.ok).toBe(true);
    if (result?.ok) {
      expect(result.action).toBeNull();
      expect("skipped" in result).toBe(true);
    }
  });

  it("prefers explicit mappings over presets", async () => {
    const mappings = resolveHookMappings({
      presets: ["gmail"],
      mappings: [
        {
          id: "override",
          match: { path: "gmail" },
          action: "agent",
          messageTemplate: "Override subject: {{messages[0].subject}}",
        },
      ],
    });
    const result = await applyHookMappings(mappings, {
      payload: { messages: [{ subject: "Hello" }] },
      headers: {},
      url: baseUrl,
      path: "gmail",
    });
    expect(result?.ok).toBe(true);
    if (result?.ok) {
      expect(result.action.kind).toBe("agent");
      expect(result.action.message).toBe("Override subject: Hello");
    }
  });

  it("passes agentId from mapping config", async () => {
    const mappings = resolveHookMappings({
      mappings: [
        {
          id: "sarah-hook",
          match: { path: "email" },
          action: "agent",
          agentId: "sarah",
          messageTemplate: "New email: {{subject}}",
        },
      ],
    });
    expect(mappings[0]?.agentId).toBe("sarah");
    const result = await applyHookMappings(mappings, {
      payload: { subject: "Hello" },
      headers: {},
      url: new URL("http://127.0.0.1:18789/hooks/email"),
      path: "email",
    });
    expect(result?.ok).toBe(true);
    if (result?.ok && result.action?.kind === "agent") {
      expect(result.action.agentId).toBe("sarah");
    }
  });

  it("passes agentId from transform override", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hooks-agent-"));
    const modPath = path.join(dir, "transform.mjs");
    fs.writeFileSync(
      modPath,
      `export default ({ payload }) => ({ message: "routed", agentId: payload.targetAgent });`,
    );

    const mappings = resolveHookMappings({
      transformsDir: dir,
      mappings: [
        {
          match: { path: "route" },
          action: "agent",
          messageTemplate: "fallback",
          transform: { module: "transform.mjs" },
        },
      ],
    });

    const result = await applyHookMappings(mappings, {
      payload: { targetAgent: "bill" },
      headers: {},
      url: new URL("http://127.0.0.1:18789/hooks/route"),
      path: "route",
    });

    expect(result?.ok).toBe(true);
    if (result?.ok && result.action?.kind === "agent") {
      expect(result.action.agentId).toBe("bill");
      expect(result.action.message).toBe("routed");
    }
  });

  it("transform agentId overrides mapping agentId", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hooks-override-"));
    const modPath = path.join(dir, "transform.mjs");
    fs.writeFileSync(modPath, `export default () => ({ message: "dynamic", agentId: "ops" });`);

    const mappings = resolveHookMappings({
      transformsDir: dir,
      mappings: [
        {
          match: { path: "route" },
          action: "agent",
          agentId: "sarah",
          messageTemplate: "fallback",
          transform: { module: "transform.mjs" },
        },
      ],
    });

    const result = await applyHookMappings(mappings, {
      payload: {},
      headers: {},
      url: new URL("http://127.0.0.1:18789/hooks/route"),
      path: "route",
    });

    expect(result?.ok).toBe(true);
    if (result?.ok && result.action?.kind === "agent") {
      expect(result.action.agentId).toBe("ops");
    }
  });

  it("supports agentId with template rendering", async () => {
    const mappings = resolveHookMappings({
      mappings: [
        {
          id: "dynamic-agent",
          match: { path: "email" },
          action: "agent",
          agentId: "{{payload.inbox}}",
          messageTemplate: "New email",
        },
      ],
    });
    const result = await applyHookMappings(mappings, {
      payload: { inbox: "tom" },
      headers: {},
      url: new URL("http://127.0.0.1:18789/hooks/email"),
      path: "email",
    });
    expect(result?.ok).toBe(true);
    if (result?.ok && result.action?.kind === "agent") {
      expect(result.action.agentId).toBe("tom");
    }
  });

  it("transform can clear mapping-level agentId with null", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hooks-clear-"));
    const modPath = path.join(dir, "transform.mjs");
    fs.writeFileSync(modPath, `export default () => ({ message: "cleared", agentId: null });`);

    const mappings = resolveHookMappings({
      transformsDir: dir,
      mappings: [
        {
          match: { path: "route" },
          action: "agent",
          agentId: "sarah",
          messageTemplate: "fallback",
          transform: { module: "transform.mjs" },
        },
      ],
    });

    const result = await applyHookMappings(mappings, {
      payload: {},
      headers: {},
      url: new URL("http://127.0.0.1:18789/hooks/route"),
      path: "route",
    });

    expect(result?.ok).toBe(true);
    if (result?.ok && result.action?.kind === "agent") {
      expect(result.action.agentId).toBeUndefined();
    }
  });

  it("rejects missing message", async () => {
    const mappings = resolveHookMappings({
      mappings: [{ match: { path: "noop" }, action: "agent" }],
    });
    const result = await applyHookMappings(mappings, {
      payload: {},
      headers: {},
      url: new URL("http://127.0.0.1:18789/hooks/noop"),
      path: "noop",
    });
    expect(result?.ok).toBe(false);
  });
});

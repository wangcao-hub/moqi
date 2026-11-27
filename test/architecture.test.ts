// The core and the plugins must run in mobile JS runtimes: no Node built-ins, no host code.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const imports = (dir: string) =>
  readdirSync(join(root, dir))
    .filter((f) => f.endsWith(".ts"))
    .flatMap((f) => {
      const text = readFileSync(join(root, dir, f), "utf8");
      return [...text.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)";/gm)].map((m) => ({
        file: `${dir}/${f}`,
        spec: m[1] as string,
      }));
    });

describe("architecture", () => {
  it("keeps src/core free of Node APIs and of plugin or host code", () => {
    for (const { file, spec } of imports("src/core")) {
      expect(spec, `${file} imports ${spec}`).toMatch(/^(\.\/[\w-]+\.js|taugraph(\/(nodes|agent|openai))?|zod)$/);
    }
  });

  it("lets plugins use only the core and portable packages", () => {
    for (const { file, spec } of imports("src/plugins")) {
      expect(spec, `${file} imports ${spec}`).toMatch(/^(\.\/[\w-]+\.js|\.\.\/core\/[\w-]+\.js|zod)$/);
    }
  });

  it("does not use Node globals in portable code", () => {
    for (const dir of ["src/core", "src/plugins"]) {
      for (const f of readdirSync(join(root, dir))) {
        const text = readFileSync(join(root, dir, f), "utf8");
        expect(text, `${dir}/${f}`).not.toMatch(/\b(process\.|Buffer\b|require\(|__dirname|crypto\.randomUUID)/);
      }
    }
  });

  it("has only small, portable runtime dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["taugraph", "zod"]);
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import ReviewMarkdown from "./ReviewMarkdown";

afterEach(cleanup);

it("renders the repository README as Markdown with its HTML image and relative document links", () => {
  const source = readFileSync(path.resolve(process.cwd(), "../../README.md"), "utf8");
  const { container } = render(<ReviewMarkdown source={source} />);
  expect(screen.getByRole("heading", { level: 1, name: "ReelTerminal" })).toBeTruthy();
  expect(container.querySelector("table")).toBeTruthy();
  expect([...container.querySelectorAll("pre code")].map(element => element.textContent).join("\n")).toContain("git clone");
  expect(screen.getByAltText("ReelTerminal Logo").getAttribute("src")).toBe("docs/assets/logo.png");
  expect(container.querySelector('a[href="README_en.md"]')).toBeTruthy();
  expect(container.querySelector('div[align="center"]')).toBeTruthy();
});

it("keeps visible safe HTML content while removing executable tags, handlers and unsafe links", () => {
  const { container } = render(<ReviewMarkdown source={'# Safe\n\n<div>Visible <a href="https://example.com">link</a><img src="local.png" onerror="alert(1)" /></div>\n<script>alert(1)</script>\n<iframe src="https://example.com"></iframe>\n<a href="javascript:alert(1)">Unsafe</a>'} />);
  expect(container.textContent).toContain("Visible");
  expect(container.querySelector('a[href="https://example.com"]')).toBeTruthy();
  expect(container.querySelector("script,iframe,[onerror]")).toBeNull();
  expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
});

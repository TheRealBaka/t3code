import { describe, expect, it } from "vite-plus/test";

import { quoteSearchNeedle } from "./selectionQuote";

describe("quoteSearchNeedle", () => {
  it("keeps a plain quote whole", () => {
    expect(quoteSearchNeedle("the loss converges")).toBe("the loss converges");
  });

  it("searches by the text ahead of the first formula", () => {
    expect(quoteSearchNeedle("so that $E = mc^2$ holds")).toBe("so that");
  });

  it("searches by the TeX source when the quote opens with a formula", () => {
    expect(quoteSearchNeedle(String.raw`$\alpha + \beta$ is the sum`)).toBe(
      String.raw`\alpha + \beta`,
    );
    expect(quoteSearchNeedle(String.raw`$$\int_0^1 f$$`)).toBe(String.raw`\int_0^1 f`);
  });
});

/**
 * Turns a DOM selection inside rendered chat markdown into quotable text.
 *
 * KaTeX renders every formula twice: MathML for assistive tech and HTML for
 * the eye. `Range.toString()` returns both copies glued together, which is
 * neither readable nor something the agent can act on. The TeX source is
 * kept in the MathML annotation, so each formula becomes `$…$` (or `$$…$$`
 * for display math) and renders again wherever the quote is shown as markdown.
 */
const FORMULA_SELECTOR = ".katex";
const TEX_SOURCE_SELECTOR = 'annotation[encoding="application/x-tex"]';

function texSourceOf(formula: Element): string {
  const tex = formula.querySelector(TEX_SOURCE_SELECTOR)?.textContent?.trim() ?? "";
  if (tex.length === 0) return formula.textContent ?? "";
  return formula.closest(".katex-display") ? `$$${tex}$$` : `$${tex}$`;
}

export function quoteTextFromRange(range: Range): string {
  const container = range.commonAncestorContainer;
  const root = container instanceof Element ? container : container.parentElement;
  if (!root) return range.toString();
  // A selection that starts and ends inside one formula quotes the whole formula.
  const enclosing = root.closest(FORMULA_SELECTOR);
  if (enclosing) return texSourceOf(enclosing);
  const formulas = [...root.querySelectorAll(FORMULA_SELECTOR)].filter((formula) =>
    range.intersectsNode(formula),
  );
  if (formulas.length === 0) return range.toString();
  // The cloned fragment holds the same formulas in the same order, so a partly
  // selected formula still gets its complete source from the original.
  const fragment = range.cloneContents();
  fragment.querySelectorAll(FORMULA_SELECTOR).forEach((clone, index) => {
    const formula = formulas[index];
    clone.replaceWith(formula ? texSourceOf(formula) : "");
  });
  return fragment.textContent ?? "";
}

/**
 * The part of a quote that still exists verbatim in the rendered reply: the
 * text before its first formula, or the first formula's TeX source, which is
 * present in the page as the MathML annotation.
 */
export function quoteSearchNeedle(quote: string): string {
  const leadingFormula = /^\s*\$\$?([^$]+)\$/.exec(quote);
  if (leadingFormula?.[1]) return leadingFormula[1].trim();
  const formulaAt = quote.indexOf("$");
  return (formulaAt < 0 ? quote : quote.slice(0, formulaAt)).trim();
}

/**
 * Preparing free text for the rules.
 *
 * The rules match plain lower-case words. This module turns whatever a model
 * wrote into that form, and says when it cannot: text in a script the rules do
 * not cover, or text with no words in it, is not "probably fine" — it is
 * unreadable, and unreadable text is refused.
 */

/** Characters the rules can read once accents are stripped: basic Latin, digits, common punctuation. */
const READABLE = /^[\t\n\r\x20-\x7e‘’“”–—…]*$/;

/**
 * Lower-cases, strips accents, turns punctuation and separators into spaces, and
 * collapses whitespace. "Climb  the WALL!" and "climb-the_wall" both become
 * "climb the wall".
 */
export function normalise(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['‘’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The reason given for text with no words in it. An id such as "c1" is allowed to have none. */
export const NO_WORDS = 'it contains no words';

/** Why a piece of text cannot be checked, or null if it can. */
export function unreadableReason(text: string): string | null {
  const stripped = text.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  if (!READABLE.test(stripped)) {
    return 'it contains characters the safety rules cannot read';
  }
  const plain = normalise(text);
  // "c l i m b" reads as a word to a person and as five letters to the rules.
  if (/(?:^| )(?:[a-z] ){3,}[a-z](?: |$)/.test(plain)) {
    return 'it spells words out letter by letter';
  }
  if (!/[a-z]{2}/.test(plain)) {
    return NO_WORDS;
  }
  return null;
}

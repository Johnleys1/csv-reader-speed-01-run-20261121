// A fast drop-in for csv-reader 1.0.0: run(input) returns exactly the reference
// reader's answer {columns, rows, errors} for one {text, header} input, but scans with
// indexOf jumps and slices instead of one character at a time.
//
// Shape of the scan: most records are plain lines with no quotes, so a record whose
// line holds no quote and no stray CR is split on commas in one go. Anything with a
// quote or a stray CR goes through the field scanners below, which follow the same
// broken-row policy as the reference: stray CRs dropped, doubled quotes collapsed,
// junk after a closing quote appended, an unclosed quote re-read as unquoted.

const COMMA = 0;
const BREAK = 1;
const DONE = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const headed = input.header === true;
  const errors = [];
  const rows = [];
  const len = text.length;
  let columns = null;
  let width = -1;
  let pos = 0;
  let line = 1;
  let recLine = 1;
  let recRow = null;
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // Scans a bare field from pos, starting with `seed` already in hand. Returns
  // [value, ended, kept]: the field's value, how it ended, and how many characters
  // the scan itself kept after the seed (a stray CR is dropped, never kept).
  function bareField(seed) {
    let parts = null;
    let start = pos;
    let kept = 0;
    for (;;) {
      const comma = text.indexOf(',', pos);
      const lf = text.indexOf('\n', pos);
      const cr = text.indexOf('\r', pos);
      let at = -1;
      let kind = DONE;
      if (comma !== -1) {
        at = comma;
        kind = COMMA;
      }
      if (lf !== -1 && (at === -1 || lf < at)) {
        at = lf;
        kind = BREAK;
      }
      if (cr !== -1 && (at === -1 || cr < at)) {
        at = cr;
        kind = 3;
      }
      if (at === -1) {
        const tail = text.slice(start);
        kept += tail.length;
        pos = len;
        return [joinParts(seed, parts, tail), DONE, kept];
      }
      if (kind === 3 && text.charCodeAt(at + 1) !== 10) {
        // A lone CR outside quotes: dropped, and the field carries on.
        errors.push({ code: 'stray_cr', line: recLine, row: recRow });
        const seg = text.slice(start, at);
        kept += seg.length;
        (parts ??= []).push(seg);
        pos = at + 1;
        start = at + 1;
        continue;
      }
      const seg = text.slice(start, at);
      kept += seg.length;
      (parts ??= []).push(seg);
      const value = parts.length === 1 ? seed + parts[0] : seed + parts.join('');
      if (kind === COMMA) {
        pos = at + 1;
        return [value, COMMA, kept];
      }
      // LF, or CRLF: the field and its record both end here.
      pos = at + (kind === 3 ? 2 : 1);
      line += 1;
      return [value, BREAK, kept];
    }
  }

  function joinParts(seed, parts, tail) {
    if (parts === null) return seed + tail;
    parts.push(tail);
    return seed + parts.join('');
  }

  // Scans a quoted field whose opening quote sits at pos. Returns [value, ended, kept]
  // like bareField; kept is 0 here except on the junk path, where it is the junk scan's.
  function quotedField() {
    const open = pos;
    const openLine = line;
    let segStart = open + 1;
    let chunks = null;
    let shut = -1;
    let look = open + 1;
    for (;;) {
      const q = text.indexOf('"', look);
      if (q === -1) break;
      if (text.charCodeAt(q + 1) === 34) {
        (chunks ??= []).push(text.slice(segStart, q), '"');
        look = q + 2;
        segStart = q + 2;
        continue;
      }
      shut = q;
      break;
    }
    if (shut === -1) {
      // The quote never closes: it is a literal character, and the text after it is
      // read again as unquoted, with the line counter rewound to the opening quote.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recLine, row: recRow });
      return bareField('"');
    }
    // The raw span between the quotes, sliced once: it is the content when no
    // doubled quotes were seen, and the line breaks inside it (LF and CR, a CRLF
    // pair counting once) are counted on the slice itself, so no scan runs past it.
    const raw = text.slice(open + 1, shut);
    let br = 0;
    let bi = 0;
    for (;;) {
      const lf = raw.indexOf('\n', bi);
      if (lf === -1) break;
      br += 1;
      bi = lf + 1;
    }
    bi = 0;
    for (;;) {
      const cr = raw.indexOf('\r', bi);
      if (cr === -1) break;
      br += 1;
      if (raw.charCodeAt(cr + 1) === 10) br -= 1;
      bi = cr + 1;
    }
    line += br;
    let content;
    if (chunks === null) {
      content = raw;
    } else {
      chunks.push(text.slice(segStart, shut));
      content = chunks.join('');
    }
    if (content.indexOf('\r') !== -1) content = content.replace(/\r\n?/g, '\n');
    pos = shut + 1;
    if (pos >= len) return [content, DONE, 0];
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return [content, COMMA, 0];
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return [content, BREAK, 0];
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return [content, BREAK, 0];
    }
    // What follows the closing quote is appended as it stands; any kept character
    // makes it quote junk.
    const junk = bareField(content);
    if (junk[2] > 0) errors.push({ code: 'quote_junk', line: recLine, row: recRow });
    return junk;
  }

  // Applies the width rule to a finished record. Returns false when the record is a
  // lone empty unquoted field (no record at all); otherwise the record is kept.
  function takeRecord(fields, lastQuoted) {
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) return false;
    if (width < 0) width = fields.length;
    if (headed && columns === null) {
      columns = fields;
      return true;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recLine, row: recRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recLine, row: recRow, extra: fields.splice(width) });
    }
    rows.push(fields);
    return true;
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recLine = line;
    recRow = headed && columns === null ? null : rows.length;

    // Hot path: a line with no quote and no stray CR (only a trailing CR that
    // belongs to its CRLF ending) splits on commas in one go.
    const end = text.indexOf('\n', pos);
    const stop = end === -1 ? len : end;
    const hasBreak = end !== -1;
    const qAt = text.indexOf('"', pos);
    const rAt = text.indexOf('\r', pos);
    const noQuote = qAt === -1 || qAt >= stop;
    const noStray = rAt === -1 || rAt >= stop || (hasBreak && rAt === stop - 1);
    if (noQuote && noStray) {
      const cut = hasBreak && rAt === stop - 1 ? stop - 1 : stop;
      takeRecord(text.slice(pos, cut).split(','), false);
      pos = hasBreak ? stop + 1 : len;
      if (hasBreak) line += 1;
      continue;
    }

    // Slow path: field by field, quotes and stray CRs included.
    const fields = [];
    let ended;
    let lastQuoted = false;
    do {
      let f;
      if (text.charCodeAt(pos) === 34) {
        f = quotedField();
        lastQuoted = true;
      } else {
        f = bareField('');
        lastQuoted = false;
      }
      fields.push(f[0]);
      ended = f[1];
    } while (ended === COMMA);
    takeRecord(fields, lastQuoted);
  }

  return { columns: headed ? columns ?? [] : null, rows, errors };
}

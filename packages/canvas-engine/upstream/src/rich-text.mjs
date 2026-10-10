import { variableReferences } from "./variable-references.mjs";

const MARK_INCLUSIVE = Object.freeze({ link: false, lang: false });

export function isMarkInclusive(type) { return MARK_INCLUSIVE[type] ?? true; }

export function validateRichText(node) {
  const errors = [];
  const content = node.content ?? "";
  if (typeof content !== "string") return [`${node.id}.content must be a string.`];
  const length = content.length;
  const marks = node.marks ?? [];
  const paragraphs = node.paragraphs ?? [];
  if (!Array.isArray(marks)) errors.push(`${node.id}.marks must be an array.`);
  if (!Array.isArray(paragraphs)) errors.push(`${node.id}.paragraphs must be an array.`);
  if (length === 0 && (marks.length || paragraphs.length))
    errors.push(`${node.id} has empty content and must have zero marks and paragraphs.`);
  for (const [kind, ranges] of [["marks", marks], ["paragraphs", paragraphs]]) {
    for (const [index, range] of ranges.entries()) {
      if (!validRange(range, length))
        errors.push(`${node.id}.${kind}[${index}] must be an integer [from,to) inside [0,${length}).`);
    }
  }
  if (length > 0) {
    if (paragraphs.length === 0) errors.push(`${node.id}.paragraphs must partition non-empty content.`);
    let cursor = 0;
    for (const paragraph of paragraphs) {
      if (paragraph.from !== cursor) errors.push(`${node.id}.paragraphs has a gap or overlap at ${cursor}.`);
      cursor = paragraph.to;
      if (paragraph.to < length && content[paragraph.to - 1] !== "\n")
        errors.push(`${node.id}.paragraphs boundary ${paragraph.to} does not follow a newline.`);
    }
    if (cursor !== length) errors.push(`${node.id}.paragraphs does not cover [0,${length}).`);
  }
  for (const [index, mark] of marks.entries()) {
    for (const token of interpolationTokens(content)) {
      const overlaps = mark.from < token.to && token.from < mark.to;
      const contains = mark.from <= token.from && mark.to >= token.to;
      if (overlaps && !contains)
        errors.push(`${node.id}.marks[${index}] partially overlaps token [${token.from},${token.to}).`);
    }
  }
  for (let left = 0; left < marks.length; left += 1) {
    for (let right = left + 1; right < marks.length; right += 1) {
      if (marks[left].type === marks[right].type
        && marks[left].from < marks[right].to && marks[right].from < marks[left].to)
        errors.push(`${node.id}.marks[${left}] and marks[${right}] overlap with the same type.`);
    }
  }
  return errors;
}

export function normalizeRichText(node) {
  const errors = validateRichText(node);
  if (errors.length) throw validationError(errors);
  return {
    ...node,
    marks: mergeAdjacent([...node.marks ?? []]),
    paragraphs: [...node.paragraphs ?? []],
  };
}

export function flattenMarks(content, marks = [], base = {}) {
  const boundaries = new Set([0, content.length]);
  for (const mark of marks) { boundaries.add(mark.from); boundaries.add(mark.to); }
  const sorted = [...boundaries].sort((a, b) => a - b);
  return sorted.slice(0, -1).filter((from, index) => from < sorted[index + 1]).map((from, index) => {
    const to = sorted[index + 1];
    const style = { ...base };
    for (const mark of marks)
      if (mark.from <= from && mark.to >= to) style[mark.type] = mark.value;
    return { from, to, ...style };
  });
}

export function mapRangesForInsert(ranges, index, count, kind = "mark") {
  return mergeAdjacent(ranges.map((range) => {
    const inclusive = kind === "paragraph" || isMarkInclusive(range.type);
    if (range.to < index) return { ...range };
    if (range.from > index) return { ...range, from: range.from + count, to: range.to + count };
    if (range.from < index && index < range.to) return { ...range, to: range.to + count };
    if (range.to === index) return inclusive ? { ...range, to: range.to + count } : { ...range };
    if (range.from === index) return inclusive
      ? { ...range, to: range.to + count }
      : { ...range, from: range.from + count, to: range.to + count };
    return { ...range };
  }));
}

export function writeMark(node, nextMark) {
  const content = node.content ?? "";
  if (!validRange(nextMark, content.length)) throw validationError([`${node.id}.mark must be an integer [from,to) inside [0,${content.length}).`]);
  const clipped = [];
  for (const mark of node.marks ?? []) {
    if (mark.type !== nextMark.type || mark.to <= nextMark.from || mark.from >= nextMark.to) {
      clipped.push({ ...mark });
      continue;
    }
    if (mark.from < nextMark.from) clipped.push({ ...mark, to: nextMark.from });
    if (mark.to > nextMark.to) clipped.push({ ...mark, from: nextMark.to });
  }
  clipped.push({ ...nextMark });
  return normalizeRichText({ ...node, marks: clipped });
}

export function mapRangesForDelete(ranges, from, to) {
  const removed = to - from;
  return mergeAdjacent(ranges.map((range) => ({
    ...range,
    from: mapDeletedOffset(range.from, from, to, removed),
    to: mapDeletedOffset(range.to, from, to, removed),
  })).filter((range) => range.from < range.to));
}

export function interpolateRichText(node, values) {
  let content = node.content;
  let marks = [...node.marks ?? []];
  let paragraphs = [...node.paragraphs ?? []];
  const legacy = /^\$([A-Za-z][\w-]*(?:\.[\w-]+)*)$/u.exec(content);
  const tokens = legacy && Object.hasOwn(values, legacy[1])
    ? [{ name: legacy[1], from: 0, to: content.length }]
    : interpolationTokens(content).reverse();
  for (const token of tokens) {
    if (!Object.hasOwn(values, token.name)) throw new Error(`Variable ${token.name} was not found.`);
    const replacement = String(values[token.name]);
    const remove = token.to - token.from;
    const exactMarks = marks.filter((mark) => mark.from === token.from && mark.to === token.to);
    content = content.slice(0, token.from) + replacement + content.slice(token.to);
    marks = mapRangesForDelete(marks, token.from, token.to);
    paragraphs = mapRangesForDelete(paragraphs, token.from, token.to);
    marks = mapRangesForInsert(marks, token.from, replacement.length);
    marks.push(...exactMarks.map((mark) => ({ ...mark, from: token.from, to: token.from + replacement.length })));
    marks = mergeAdjacent(marks);
    paragraphs = mapRangesForInsert(paragraphs, token.from, replacement.length, "paragraph");
  }
  return { ...node, content, marks, paragraphs };
}

function interpolationTokens(content) {
  return variableReferences(content).map((match) => ({
    name: match[1], from: match.index, to: match.index + match[0].length,
  }));
}

function validRange(range, length) {
  return range && Number.isInteger(range.from) && Number.isInteger(range.to)
    && range.from >= 0 && range.from < range.to && range.to <= length;
}

function mapDeletedOffset(value, from, to, removed) {
  if (value <= from) return value;
  if (value >= to) return value - removed;
  return from;
}

function mergeAdjacent(ranges) {
  const sorted = ranges.sort((a, b) => a.from - b.from || a.to - b.to || String(a.type).localeCompare(String(b.type)));
  const result = [];
  for (const range of sorted) {
    const previous = result.at(-1);
    const same = previous && previous.to === range.from && previous.type === range.type
      && JSON.stringify(previous.value) === JSON.stringify(range.value)
      && JSON.stringify({ ...previous, from: 0, to: 0 }) === JSON.stringify({ ...range, from: 0, to: 0 });
    if (same) previous.to = range.to;
    else result.push({ ...range });
  }
  return result;
}

function validationError(errors) {
  const error = new Error(errors.join("\n"));
  error.code = "CANVAS_SCHEMA_INVALID";
  error.errors = errors;
  return error;
}

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

export function readOoxmlPackage(bytes) {
  return new Map(Object.entries(unzipSync(asBytes(bytes))));
}

export function writeOoxmlPackage(parts) {
  return zipSync(Object.fromEntries(parts), { level: 6 });
}

export function readXmlPart(parts, path) {
  const bytes = parts.get(path);
  if (!bytes) throw new Error(`OOXML package is missing ${path}.`);
  return strFromU8(bytes);
}

export function writeXmlPart(parts, path, xml) {
  if (!parts.has(path)) throw new Error(`OOXML package is missing ${path}.`);
  parts.set(path, strToU8(xml));
}

export function injectSlideTreeXml(bytes, slideNumber, xml) {
  const parts = readOoxmlPackage(bytes);
  const path = `ppt/slides/slide${slideNumber}.xml`;
  const slide = readXmlPart(parts, path);
  const marker = "</p:spTree>";
  if (!slide.includes(marker)) throw new Error(`${path} has no p:spTree insertion point.`);
  writeXmlPart(parts, path, slide.replace(marker, `${xml}${marker}`));
  return writeOoxmlPackage(parts);
}

export function embedPresentationFonts(bytes, fonts) {
  if (!fonts?.length) return asBytes(bytes);
  const parts = readOoxmlPackage(bytes);
  const relPath = "ppt/_rels/presentation.xml.rels";
  let relationships = readXmlPart(parts, relPath);
  let presentation = readXmlPart(parts, "ppt/presentation.xml");
  let contentTypes = readXmlPart(parts, "[Content_Types].xml");
  const ids = [...relationships.matchAll(/Id="rId(\d+)"/gu)].map((match) => Number(match[1]));
  let nextRelationship = Math.max(0, ...ids) + 1;
  let nextPart = 1;
  const entries = [];
  for (const font of fonts) {
    const faces = [];
    for (const slot of ["regular", "bold", "italic", "boldItalic"]) {
      const face = font.faces?.[slot];
      if (!face) continue;
      const id = `rId${nextRelationship++}`;
      const part = `ppt/fonts/font${nextPart++}.fntdata`;
      parts.set(part, asBytes(face));
      relationships = relationships.replace("</Relationships>", `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/${part.split("/").at(-1)}"/></Relationships>`);
      faces.push(`<p:${slot} r:id="${id}"/>`);
    }
    if (faces.length) entries.push(`<p:embeddedFont><p:font typeface="${xmlEscape(font.typeface)}"/>${faces.join("")}</p:embeddedFont>`);
  }
  if (!entries.length) return asBytes(bytes);
  if (!/Extension="fntdata"/u.test(contentTypes)) contentTypes = contentTypes.replace("</Types>", `<Default Extension="fntdata" ContentType="application/x-fontdata"/></Types>`);
  presentation = presentation.replace(/<p:presentation\b([^>]*)>/u, (whole, attributes) => `<p:presentation${attributes.replace(/\s(?:embedTrueTypeFonts|saveSubsetFonts)="[^"]*"/gu, "")} embedTrueTypeFonts="1" saveSubsetFonts="0">`);
  if (!/<p:notesSz\b[^>]*\/>/u.test(presentation)) throw new Error("presentation.xml has no notesSz insertion point for embeddedFontLst.");
  presentation = presentation.replace(/(<p:notesSz\b[^>]*\/>)/u, `$1<p:embeddedFontLst>${entries.join("")}</p:embeddedFontLst>`);
  writeXmlPart(parts, relPath, relationships);
  writeXmlPart(parts, "ppt/presentation.xml", presentation);
  writeXmlPart(parts, "[Content_Types].xml", contentTypes);
  return writeOoxmlPackage(parts);
}

function xmlEscape(value) { return String(value).replace(/[&<>"']/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]); }

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError("OOXML package bytes must be an ArrayBuffer or Uint8Array.");
}

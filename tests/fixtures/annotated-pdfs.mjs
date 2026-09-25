// Small generated PDFs whose annotations copy the structure written by other
// apps (checked against real files annotated in Microsoft Edge, Acrobat
// Online and Foxit PDF). The real files are publisher articles and are not
// committed.
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';

const LINES = [
  'Pavement cracks were measured with a line scan camera.',
  'The images were taken from a fixed height of 672 mm.',
  'Thin hairline cracks under shadows were often missed.',
  'Future work will add infrared imaging to the survey.',
];

// A PDF with the lines above on each page. options.pages lists per page
// { rotate, cropBox } to test rotated and cropped pages.
export async function textPdf(options = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const pageOptions of options.pages || [{}]) {
    const page = doc.addPage([612, 792]);
    LINES.forEach((line, index) => page.drawText(line, { x: 72, y: 700 - index * 24, size: 12, font }));
    if (pageOptions.rotate) page.setRotation({ type: 'degrees', angle: pageOptions.rotate });
    if (pageOptions.cropBox) page.setCropBox(...pageOptions.cropBox);
  }
  return doc;
}

// Quads for the words of LINES[line] from word `from` to word `to` (inclusive),
// with Helvetica 12 widths, in the reader order (TL, TR, BL, BR).
async function quadFor(doc, line, from, to) {
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const words = LINES[line].split(' ');
  const before = words.slice(0, from).join(' ') + (from > 0 ? ' ' : '');
  const covered = words.slice(from, to + 1).join(' ');
  const x0 = 72 + font.widthOfTextAtSize(before, 12);
  const x1 = x0 + font.widthOfTextAtSize(covered, 12);
  const baseline = 700 - line * 24;
  const bottom = baseline - 3;
  const top = baseline + 10;
  return [x0, top, x1, top, x0, bottom, x1, bottom];
}

// Foxit PDF style: author (/T), subject, border, Multiply appearance, popups
// with /NM, compressed object streams. Also a reply and Acrobat's "replace
// text" (a caret grouped with a strikethrough).
export async function foxitStylePdf() {
  const doc = await textPdf();
  const page = doc.getPages()[0];
  const add = (dict) => {
    const ref = doc.context.register(doc.context.obj(dict));
    page.node.addAnnot(ref);
    return ref;
  };
  const markup = async (subtype, color, line, from, to, extra = {}) => {
    const quads = await quadFor(doc, line, from, to);
    const ap = doc.context.register(doc.context.flateStream(`/TransGs gs ${color.join(' ')} rg ${quads[0]} ${quads[1]} m ${quads[2]} ${quads[3]} l ${quads[6]} ${quads[7]} l ${quads[4]} ${quads[5]} l f`, {
      Type: 'XObject', Subtype: 'Form', BBox: [quads[0], quads[5], quads[2], quads[1]],
      Resources: { ExtGState: { TransGs: { Type: 'ExtGState', BM: 'Multiply', CA: 0.53, ca: 0.53, AIS: false } } },
    }));
    const annotation = doc.context.obj({
      Type: 'Annot', Subtype: subtype, Rect: [quads[0], quads[5], quads[2], quads[1]], QuadPoints: quads,
      C: color, CA: subtype === 'Highlight' ? 0.53 : 1, F: 4, Border: [0, 0, 1], AP: { N: ap }, P: page.ref, ...extra,
    });
    annotation.set(PDFName.of('T'), PDFString.of('meesd'));
    annotation.set(PDFName.of('Subj'), PDFString.of(subtype));
    annotation.set(PDFName.of('NM'), PDFString.of(`${subtype.toLowerCase()}-foxit-1`));
    annotation.set(PDFName.of('M'), PDFString.of("D:20260925132653-07'00'"));
    const ref = doc.context.register(annotation);
    page.node.addAnnot(ref);
    const popup = add({ Type: 'Annot', Subtype: 'Popup', Rect: [400, 600, 580, 700], Parent: ref, Open: false, F: 28 });
    annotation.set(PDFName.of('Popup'), popup);
    return { ref, annotation };
  };
  const highlight = await markup('Highlight', [1, 0.93, 0], 1, 4, 10);
  highlight.annotation.set(PDFName.of('Contents'), PDFString.of('Check the calibration'));
  await markup('Underline', [0.2, 0.62, 0], 0, 0, 2);
  const strike = await markup('StrikeOut', [1, 0, 0], 2, 0, 2);
  // A reply to the highlight.
  const reply = doc.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [300, 690, 320, 710], IRT: highlight.ref, RT: 'R', F: 28 });
  reply.set(PDFName.of('T'), PDFString.of('coauthor'));
  reply.set(PDFName.of('Contents'), PDFString.of('Agreed, it matters'));
  page.node.addAnnot(doc.context.register(reply));
  // Replace text: a caret grouped with the strikethrough.
  const caret = doc.context.obj({ Type: 'Annot', Subtype: 'Caret', Rect: [72, 648, 80, 660], IRT: strike.ref, RT: 'Group', F: 4 });
  caret.set(PDFName.of('Contents'), PDFString.of('Fine cracks'));
  page.node.addAnnot(doc.context.register(caret));
  // A link, which must never be touched.
  add({ Type: 'Annot', Subtype: 'Link', Rect: [72, 600, 200, 612], Border: [0, 0, 0], A: { S: 'URI', URI: PDFString.of('https://example.com') } });
  return doc.save({ useObjectStreams: true });
}

// Edge / Acrobat Online style: the original file is kept and annotations are
// appended as an incremental update (new objects, a new xref section and a
// trailer pointing to the previous one). No author; /NM is a UUID; the
// appearance draws a named form XObject ("MWFOForm").
export async function edgeStylePdf() {
  const doc = await textPdf();
  const page = doc.getPages()[0];
  const linkRef = doc.context.register(doc.context.obj({
    Type: 'Annot', Subtype: 'Link', Rect: [72, 600, 200, 612], Border: [0, 0, 0],
    A: { S: 'URI', URI: PDFString.of('https://example.com') },
  }));
  page.node.addAnnot(linkRef);
  const base = await doc.save({ useObjectStreams: false });
  const baseText = Buffer.from(base).toString('latin1');
  const previousXref = Number(baseText.match(/startxref\s+(\d+)\s+%%EOF\s*$/)[1]);
  const size = Number(baseText.match(/\/Size (\d+)/)[1]);
  const root = baseText.match(/\/Root (\d+ \d+ R)/)[1];
  const pageNumber = page.ref.objectNumber;
  // The page as it was, with an /Annots entry replaced.
  const pageDict = page.node.toString().replace(/\/Annots \[[^\]]*\]/, '');

  const highlightQuads = await quadFor(doc, 1, 4, 10);
  const underlineQuads = await quadFor(doc, 3, 0, 1);
  const n = size;
  const objects = [];
  const markup = (number, subtype, quads, color, uuid, contents, popupNumber, formNumber) => {
    objects.push([number, `<</Type/Annot/Subtype/${subtype}/P ${pageNumber} 0 R/F 4/M(D:20260925133139-07'00')/NM(${uuid})/Rect[ ${quads[0]} ${quads[5]} ${quads[2]} ${quads[1]}]/C[ ${color.join(' ')}]/Popup ${popupNumber} 0 R/CA ${subtype === 'Highlight' ? '.4' : '1'}/CreationDate(D:20260925133139-07'00')/QuadPoints[ ${quads.join(' ')}]${contents ? `/Contents(${contents})` : ''}/AP<</N ${formNumber} 0 R>>>>`]);
    objects.push([popupNumber, `<</Type/Annot/Subtype/Popup/Open false/F 28/Rect[ 400 600 580 700]/Parent ${number} 0 R>>`]);
    const inner = `${color.join(' ')} rg ${quads[0]} ${quads[1]} m ${quads[2]} ${quads[3]} l ${quads[6]} ${quads[7]} l ${quads[4]} ${quads[5]} l f`;
    objects.push([formNumber + 1, `<</Type/XObject/Subtype/Form/BBox[ ${quads[0]} ${quads[5]} ${quads[2]} ${quads[1]}]/Length ${inner.length}>>\nstream\n${inner}\nendstream`]);
    objects.push([formNumber + 2, `<</Type/ExtGState/BM/Multiply/CA .4/ca .4>>`]);
    const outer = '/R0 gs\n/MWFOForm Do\n';
    objects.push([formNumber, `<</Type/XObject/Subtype/Form/BBox[ ${quads[0]} ${quads[5]} ${quads[2]} ${quads[1]}]/Resources<</ProcSet[/PDF]/XObject<</MWFOForm ${formNumber + 1} 0 R>>/ExtGState<</R0 ${formNumber + 2} 0 R>>>>/Length ${outer.length}>>\nstream\n${outer}\nendstream`]);
  };
  markup(n, 'Highlight', highlightQuads, [1, 0.756863, 0], '0a6e7aa3-cd1e-4785-9d21-4b1fe1579901', 'sample comment', n + 1, n + 2);
  markup(n + 5, 'Underline', underlineQuads, [0.023529, 0.541176, 0.109804], '9b1c2d3e-0000-4000-8000-000000000002', '', n + 6, n + 7);
  objects.push([pageNumber, pageDict.replace(/>>\s*$/, `/Annots [ ${linkRef.objectNumber} 0 R ${n} 0 R ${n + 1} 0 R ${n + 5} 0 R ${n + 6} 0 R ] >>`)]);

  let update = '\n';
  const offsets = [];
  for (const [number, body] of objects) {
    offsets.push([number, base.length + Buffer.byteLength(update, 'latin1')]);
    update += `${number} 0 obj\n${body}\nendobj\n`;
  }
  const xrefOffset = base.length + Buffer.byteLength(update, 'latin1');
  update += 'xref\n';
  for (const [number, offset] of offsets.sort((a, b) => a[0] - b[0])) {
    update += `${number} 1\n${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  update += `trailer\n<</Size ${n + 10}/Root ${root}/Prev ${previousXref}>>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new Uint8Array([...base, ...Buffer.from(update, 'latin1')]);
}

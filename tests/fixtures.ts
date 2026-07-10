import { Buffer } from 'node:buffer'

export const MINIMAL_PDF_BASE64 = createMinimalPdfBase64()

function createMinimalPdfBase64(): string {
  const stream = 'BT\n/F1 24 Tf\n100 700 Td\n(Hello World) Tj\nET\n'
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    `5 0 obj\n<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}endstream\nendobj\n`,
  ]

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, 'ascii'))
    pdf += object
  }

  const xrefOffset = Buffer.byteLength(pdf, 'ascii')
  const xrefEntries = offsets
    .map(offset => `${offset.toString().padStart(10, '0')} 00000 n \n`)
    .join('')
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${xrefEntries}`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`

  return Buffer.from(pdf, 'ascii').toString('base64')
}

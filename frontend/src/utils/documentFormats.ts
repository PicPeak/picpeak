/**
 * Customer document formats on the client (#1444 slice 7).
 *
 * The server's list endpoints return `allowedFormats` (from the setting,
 * filtered to its fixed registry); these helpers turn that list into the
 * upload control's `accept`, the copy and a first check by extension. The
 * server decides by content — this only saves a round trip.
 */

export type DocumentFormat = 'pdf' | 'docx' | 'xlsx' | 'odt' | 'ods' | 'txt' | 'csv';

export const ALL_DOCUMENT_FORMATS: DocumentFormat[] = ['pdf', 'docx', 'xlsx', 'odt', 'ods', 'txt', 'csv'];

const ACCEPT: Record<DocumentFormat, string[]> = {
  pdf: ['.pdf', 'application/pdf'],
  docx: ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xlsx: ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  odt: ['.odt', 'application/vnd.oasis.opendocument.text'],
  ods: ['.ods', 'application/vnd.oasis.opendocument.spreadsheet'],
  txt: ['.txt', 'text/plain'],
  csv: ['.csv', 'text/csv'],
};

/** Known formats only, in registry order; PDF when the list is empty. */
export function normaliseFormats(formats: string[] | undefined | null): DocumentFormat[] {
  const known = ALL_DOCUMENT_FORMATS.filter((f) => (formats || []).includes(f));
  return known.length > 0 ? known : ['pdf'];
}

export function acceptFor(formats: DocumentFormat[]): string {
  return formats.flatMap((f) => ACCEPT[f]).join(',');
}

/** "PDF, DOCX, CSV" — the extensions people see on their files. */
export function formatList(formats: DocumentFormat[]): string {
  return formats.map((f) => f.toUpperCase()).join(', ');
}

/** The format a file name selects by its last extension, if it is allowed. */
export function allowedFormatOf(name: string, formats: DocumentFormat[]): DocumentFormat | null {
  const m = /\.([A-Za-z0-9]+)$/.exec(name || '');
  const ext = m ? (m[1].toLowerCase() as DocumentFormat) : null;
  return ext && formats.includes(ext) ? ext : null;
}

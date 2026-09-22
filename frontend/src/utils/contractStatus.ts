import type { TFunction } from 'i18next';

/** How far a contract's customer signers have got (#1446). */
export interface SignerProgress {
  signed: number;
  total: number;
}

/**
 * The status label a contract shows. `sent` with some but not all customer
 * signatures reads "Partly signed (1 of 2)" — a display state derived from
 * the signers, never a stored status.
 */
export function contractStatusLabel(
  t: TFunction,
  status: string,
  progress?: SignerProgress | null,
): string {
  if (status === 'sent' && progress && progress.total > 1 && progress.signed > 0 && progress.signed < progress.total) {
    return t('contracts.status.partlySigned', 'Partly signed ({{signed}} of {{total}})', {
      signed: progress.signed,
      total: progress.total,
    });
  }
  return t(`contracts.status.${status}`, status);
}

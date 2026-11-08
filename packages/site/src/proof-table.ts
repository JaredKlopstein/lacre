/**
 * What a self-hosted (local) chain does and does not prove, next to an anchored one.
 *
 * Shown on both the home page and the security page. Both import it from here, so
 * the two can't drift.
 *
 * An anchor protects only the history at or before the anchored position, so the
 * rebuild rows are split at the anchor: history rebuilt before it was
 * anchored is anchored as rebuilt. The defense is to anchor early and often.
 */
export const PROOF_TABLE = [
  { property: 'Detects casual tampering', local: 'yes', anchored: 'yes' },
  { property: 'Detects a full rebuild of anchored history by the operator', local: 'no', anchored: 'yes' },
  { property: 'Detects a rebuild made before that history was anchored', local: 'no', anchored: 'no' },
  { property: 'Detects backdating after the anchor', local: 'no', anchored: 'yes' },
  { property: 'Detects truncation of the un-anchored tail', local: 'no', anchored: 'no' },
] as const;

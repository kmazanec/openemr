<?php

/**
 * Boundary between {@see FamilyHistoryWriteService} and OpenEMR's
 * `lists` table for `type='family_history'` rows.
 *
 * Stock OpenEMR has no dedicated family-history table — every
 * family-history row lives in `lists` with `type='family_history'`,
 * `title` carrying the composite `"{relation} — {condition}"` label
 * (matching how the chart's family-history widget already renders
 * existing rows). The writer is single-table — one accepted fact, one
 * `lists` row — so no transaction is needed.
 *
 * Idempotency check is a single read against `lists` keyed on
 * `(source_document_uuid, type='family_history', normalized_title)`.
 * The caller composes + normalizes the title before calling; the
 * writer treats `$normalizedTitle` as opaque and matches it against
 * the stored `lists.title` after the same normalization at SQL time,
 * so a re-promote of "Mother — Type 2 diabetes" hits the existing
 * row regardless of whitespace + case differences in the agent's
 * extracted free text.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Service;

interface FamilyHistoryListsTableWriter
{
    /**
     * Look up an existing `lists` row that already represents this
     * family-history entry (by `(source_document_uuid,
     * lower(trim(title)))`). Returns the canonical UUID + row id if
     * found; null otherwise.
     */
    public function findExistingFamilyHistory(
        string $sourceDocumentUuid,
        string $normalizedTitle,
    ): ?PersistedListEntry;

    /**
     * Insert a `lists` row with `type='family_history'`, populating
     * the cross-list columns (`pid`, `title`, `comments`, `begdate`,
     * `source_document_uuid`, `user`, `date`, `activity`). Mints a
     * fresh `lists.uuid` (binary). Returns the canonical UUID + row
     * id.
     */
    public function insertFamilyHistory(
        FamilyHistoryPromotionRequest $request,
        \DateTimeImmutable $createdAt,
    ): PersistedListEntry;
}

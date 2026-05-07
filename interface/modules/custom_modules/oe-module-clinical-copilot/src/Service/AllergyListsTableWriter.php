<?php

/**
 * Boundary between {@see AllergyListWriteService} and OpenEMR's
 * `lists` table for `type='allergy'` rows.
 *
 * The allergy promotion writer is single-table — unlike the lab
 * promote chain (procedure_order → procedure_order_code →
 * procedure_report → procedure_result), every allergy is one `lists`
 * row. The writer still owns its own boundary so the service stays
 * trivially testable (in-memory implementation in tests; real
 * Doctrine connection in production) and free of SQL strings.
 *
 * Idempotency check is a single read against `lists` keyed on
 * `(source_document_uuid, type='allergy', normalized_substance)`. The
 * caller computes the normalized form (`lower(trim(substance))`)
 * before calling; the writer treats `$normalizedSubstance` as opaque
 * and matches it against the stored `lists.title` after the same
 * normalization at SQL time, so a re-promote of "Penicillin" hits the
 * existing "penicillin" row.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Service;

interface AllergyListsTableWriter
{
    /**
     * Look up an existing `lists` row that already represents this
     * allergy (by `(source_document_uuid, lower(trim(title)))`).
     * Returns the canonical UUID + row id if found; null otherwise.
     */
    public function findExistingAllergy(
        string $sourceDocumentUuid,
        string $normalizedSubstance,
    ): ?PersistedListEntry;

    /**
     * Insert a `lists` row with `type='allergy'`, populating the
     * type-specific columns (`reaction`, `verification`,
     * `severity_al`) along with the cross-list columns (`pid`,
     * `title`, `comments`, `begdate`, `source_document_uuid`,
     * `user`, `groupname`, `date`, `activity`). Mints a fresh
     * `lists.uuid` (binary). Returns the canonical UUID + row id.
     */
    public function insertAllergy(
        AllergyPromotionRequest $request,
        \DateTimeImmutable $createdAt,
    ): PersistedListEntry;
}

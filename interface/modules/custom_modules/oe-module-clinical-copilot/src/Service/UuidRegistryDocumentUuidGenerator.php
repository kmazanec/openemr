<?php

/**
 * Production wiring for {@see DocumentUuidGenerator} that goes through
 * OpenEMR's `UuidRegistry` so the binding shows up in the same audit
 * trail as a hand-uploaded document. The registry's COMB-codec ordering
 * is what makes new ids index well alongside the legacy hand-upload
 * path.
 *
 * Tracker registration is **disabled** here: the agent module owns the
 * insert into `documents` (with the binary uuid) and the registry's
 * own `insertUuidsIntoRegistry` would double-record the row. We keep
 * the COMB ordering from `getUnusedUuidBatch` while skipping the
 * registry side-table.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Service;

use OpenEMR\Common\Uuid\UuidRegistry;

final class UuidRegistryDocumentUuidGenerator implements DocumentUuidGenerator
{
    public function generate(): GeneratedDocumentUuid
    {
        $registry = new UuidRegistry([
            'table_name' => 'documents',
            'disable_tracker' => true,
        ]);
        $binary = $registry->createUuid();
        $canonical = UuidRegistry::uuidToString($binary);
        return new GeneratedDocumentUuid(canonical: $canonical, binary: $binary);
    }
}

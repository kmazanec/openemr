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
    private const UUID_PATTERN = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/';

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

    public function fromCanonical(string $canonical): GeneratedDocumentUuid
    {
        if (preg_match(self::UUID_PATTERN, $canonical) !== 1) {
            throw new \DomainException('canonical must be a lowercase 36-char UUID');
        }
        $hex = str_replace('-', '', $canonical);
        $binary = hex2bin($hex);
        if ($binary === false || strlen($binary) !== 16) {
            throw new \DomainException('canonical UUID could not be decoded to 16 bytes');
        }
        return new GeneratedDocumentUuid(canonical: $canonical, binary: $binary);
    }
}

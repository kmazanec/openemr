<?php

/**
 * Allergy or intolerance line.
 *
 * Adapter responsibility (Phase 2.2 AllergyAdapter): fail closed if the
 * data layer errors — Verify (Phase 3.3) treats missing allergies as a
 * hard stop on medication summaries.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Snapshot;

/**
 * @phpstan-import-type SourceReferenceArray from SourceReference
 *
 * @phpstan-type AllergyArray array{
 *     substance: string,
 *     reaction: ?string,
 *     severity: ?string,
 *     source: SourceReferenceArray,
 * }
 */
final readonly class Allergy
{
    public function __construct(
        public string $substance,
        public ?string $reaction,
        public ?string $severity,
        public SourceReference $source,
    ) {
    }

    /**
     * @return AllergyArray
     */
    public function toArray(): array
    {
        return [
            'substance' => $this->substance,
            'reaction' => $this->reaction,
            'severity' => $this->severity,
            'source' => $this->source->toArray(),
        ];
    }
}

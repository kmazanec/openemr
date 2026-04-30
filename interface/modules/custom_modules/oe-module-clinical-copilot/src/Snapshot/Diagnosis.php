<?php

/**
 * Active diagnosis line for a ChartSnapshot.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Snapshot;

use DateTimeImmutable;

/**
 * @phpstan-import-type SourceReferenceArray from SourceReference
 *
 * @phpstan-type DiagnosisArray array{
 *     code: string,
 *     codeSystem: string,
 *     label: string,
 *     onsetDate: ?string,
 *     source: SourceReferenceArray,
 * }
 */
final readonly class Diagnosis
{
    public function __construct(
        public string $code,
        public string $codeSystem,
        public string $label,
        public ?DateTimeImmutable $onsetDate,
        public SourceReference $source,
    ) {
    }

    /**
     * @return DiagnosisArray
     */
    public function toArray(): array
    {
        return [
            'code' => $this->code,
            'codeSystem' => $this->codeSystem,
            'label' => $this->label,
            'onsetDate' => $this->onsetDate?->format('Y-m-d'),
            'source' => $this->source->toArray(),
        ];
    }
}

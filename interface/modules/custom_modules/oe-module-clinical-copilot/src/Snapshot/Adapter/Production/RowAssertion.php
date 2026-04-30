<?php

/**
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\Production;

use RuntimeException;

/**
 * Narrows {@see \OpenEMR\Common\Database\QueryUtils} return shapes —
 * `array<mixed>` and `list<array<mixed>>` — into the
 * `array<string, mixed>` that adapter `*DataSource` interfaces declare.
 *
 * The narrowing is real: every SQL the production data sources run
 * uses named columns, so the result rows have string keys. PHPStan
 * cannot prove this through `QueryUtils`'s legacy signature, so we
 * assert it once in this helper rather than scattering inline casts
 * across every data source.
 */
final class RowAssertion
{
    /**
     * @param array<mixed> $row
     * @return array<string, mixed>
     */
    public static function withStringKeys(array $row): array
    {
        foreach (array_keys($row) as $key) {
            if (!is_string($key)) {
                throw new RuntimeException('expected named-column row, got integer-keyed result');
            }
        }
        /** @var array<string, mixed> $row */
        return $row;
    }

    /**
     * @param list<array<mixed>> $rows
     * @return list<array<string, mixed>>
     */
    public static function listWithStringKeys(array $rows): array
    {
        $out = [];
        foreach ($rows as $row) {
            $out[] = self::withStringKeys($row);
        }
        return $out;
    }
}

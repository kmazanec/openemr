<?php

/**
 * Set of DataCategory cases describing what a request asked for.
 *
 * Wraps the underlying enum-keyed map so callers can't pass duplicates,
 * order is irrelevant, and the JSON-fingerprint shape (used by the
 * disclosure audit in Phase 2.4) is stable.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Snapshot;

use DomainException;
use IteratorAggregate;
use Traversable;

/**
 * @implements IteratorAggregate<int, DataCategory>
 */
final readonly class DataCategorySet implements IteratorAggregate
{
    /**
     * @param array<string, DataCategory> $byValue
     */
    private function __construct(private array $byValue)
    {
    }

    public static function of(DataCategory ...$categories): self
    {
        $byValue = [];
        foreach ($categories as $c) {
            $byValue[$c->value] = $c;
        }
        return new self($byValue);
    }

    public static function empty(): self
    {
        return new self([]);
    }

    public static function all(): self
    {
        return self::of(...DataCategory::cases());
    }

    /**
     * @param list<string> $values
     */
    public static function fromStrings(array $values): self
    {
        $cats = [];
        foreach ($values as $value) {
            $case = DataCategory::tryFrom($value);
            if ($case === null) {
                throw new DomainException("unknown data category: {$value}");
            }
            $cats[] = $case;
        }
        return self::of(...$cats);
    }

    public function contains(DataCategory $category): bool
    {
        return isset($this->byValue[$category->value]);
    }

    /**
     * @return list<string> sorted alphabetically for stable fingerprints
     */
    public function toStrings(): array
    {
        $values = array_keys($this->byValue);
        sort($values);
        return $values;
    }

    public function getIterator(): Traversable
    {
        return new \ArrayIterator(array_values($this->byValue));
    }
}

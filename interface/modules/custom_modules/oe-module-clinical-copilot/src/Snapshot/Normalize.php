<?php

/**
 * OpenEMR-row normalization helpers shared by ChartSnapshot adapters.
 *
 * Centralizes three concerns from `ARCHITECTURE.md` §"Tool And Adapter
 * Layer":
 *
 *   - treat `0000-00-00` and empty strings as unknown dates;
 *   - return explicit missingness (`null`) instead of empty strings;
 *   - require non-empty source IDs so every fact carries a usable
 *     citation target.
 *
 * Pure static helpers — every adapter pulls in the same normalization
 * so a row that one adapter would treat as missing isn't silently
 * accepted by another.
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
use DomainException;

final class Normalize
{
    private function __construct()
    {
    }

    /**
     * OpenEMR encodes "no date" as the empty string, MySQL zero-date
     * (`0000-00-00`), or the epoch placeholder. Treat all three as null.
     */
    public static function toDateString(?string $value): ?string
    {
        if ($value === null) {
            return null;
        }
        $trimmed = trim($value);
        if ($trimmed === '' || str_starts_with($trimmed, '0000-00-00') || $trimmed === '1970-01-01 00:00:00') {
            return null;
        }
        // Drop time portion if present.
        $datePart = explode(' ', $trimmed, 2)[0];
        return $datePart;
    }

    public static function toDateImmutable(?string $value): ?DateTimeImmutable
    {
        $date = self::toDateString($value);
        if ($date === null) {
            return null;
        }
        $parsed = DateTimeImmutable::createFromFormat('!Y-m-d', $date);
        return $parsed === false ? null : $parsed;
    }

    /**
     * Whole years between `$dob` and `$asOf` (default: today). Returns
     * null when DOB is missing or in the future. Computed server-side so
     * the model never has to do birthday-vs-year arithmetic itself.
     */
    public static function ageYears(
        ?DateTimeImmutable $dob,
        ?DateTimeImmutable $asOf = null,
    ): ?int {
        if ($dob === null) {
            return null;
        }
        $reference = $asOf ?? new DateTimeImmutable('today');
        if ($dob > $reference) {
            return null;
        }
        return $reference->diff($dob)->y;
    }

    /**
     * Trim and treat empty/whitespace-only as missing.
     */
    public static function toOptionalString(?string $value): ?string
    {
        if ($value === null) {
            return null;
        }
        $trimmed = trim($value);
        return $trimmed === '' ? null : $trimmed;
    }

    /**
     * Source IDs that don't exist (null, empty string, integer 0) can't
     * power a citation; reject so the adapter strips the row before it
     * reaches the verifier.
     */
    public static function requireRecordId(int|string|null $value): string
    {
        if ($value === null) {
            throw new DomainException('record id is required');
        }
        if (is_int($value)) {
            if ($value === 0) {
                throw new DomainException('record id 0 is not a valid source id');
            }
            return (string) $value;
        }
        $trimmed = trim($value);
        if ($trimmed === '' || $trimmed === '0') {
            throw new DomainException('record id must be a non-empty string');
        }
        return $trimmed;
    }

    /**
     * Read a column from a database row as a string when it looks like a
     * scalar (string/int/float). Anything else (null, array, object) maps
     * to null — adapters then decide whether to treat that as missing or
     * fail.
     *
     * @param array<string, mixed> $row
     */
    public static function stringField(array $row, string $key): ?string
    {
        $value = $row[$key] ?? null;
        if (is_string($value)) {
            return $value;
        }
        if (is_int($value) || is_float($value)) {
            return (string) $value;
        }
        return null;
    }

    /**
     * Same shape as stringField but preserves the int|string distinction
     * so downstream callers (e.g. requireRecordId) can apply different
     * rules to integer 0 vs string "0".
     *
     * @param array<string, mixed> $row
     */
    public static function intOrStringField(array $row, string $key): int|string|null
    {
        $value = $row[$key] ?? null;
        if (is_int($value) || is_string($value)) {
            return $value;
        }
        return null;
    }
}

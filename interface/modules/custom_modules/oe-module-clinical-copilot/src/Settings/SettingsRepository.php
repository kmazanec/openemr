<?php

/**
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Settings;

use DateTimeImmutable;
use Doctrine\DBAL\Connection;
use Doctrine\DBAL\ParameterType;

/**
 * DBAL-backed CRUD for {@see PractitionerSettings}.
 *
 * Single source of SQL for the `agent_practitioner_settings` table. The
 * UPSERT path is `SELECT then INSERT-or-UPDATE` rather than a dialect-
 * specific `INSERT … ON DUPLICATE KEY UPDATE` (MariaDB) or `INSERT …
 * ON CONFLICT` (SQLite, Postgres) so the same code runs against the
 * production MariaDB and the in-memory SQLite the isolated tests use.
 * Two queries instead of one is acceptable here — the settings page is a
 * low-frequency clinician action, not a hot path.
 */
final readonly class SettingsRepository
{
    public const TABLE_NAME = 'agent_practitioner_settings';

    /**
     * @var list<string>
     */
    public const COLUMN_NAMES = [
        'practitioner_uuid',
        'morning_prep_enabled',
        'morning_prep_time_local',
        'timezone',
        'updated_at',
    ];

    public function __construct(private Connection $connection)
    {
    }

    public function find(string $practitionerUuid): ?PractitionerSettings
    {
        $row = $this->connection->fetchAssociative(
            'SELECT practitioner_uuid, morning_prep_enabled, morning_prep_time_local, timezone, updated_at '
            . 'FROM ' . self::TABLE_NAME . ' WHERE practitioner_uuid = ?',
            [$practitionerUuid],
        );
        if ($row === false) {
            return null;
        }

        return self::hydrate($row);
    }

    public function upsert(PractitionerSettings $row): void
    {
        $values = [
            'morning_prep_enabled' => $row->morningPrepEnabled ? 1 : 0,
            'morning_prep_time_local' => $row->morningPrepTimeLocal,
            'timezone' => $row->timezone,
            'updated_at' => $row->updatedAt->format('Y-m-d H:i:s'),
        ];
        $types = [
            'morning_prep_enabled' => ParameterType::INTEGER,
            'morning_prep_time_local' => ParameterType::STRING,
            'timezone' => ParameterType::STRING,
            'updated_at' => ParameterType::STRING,
        ];

        $existing = $this->connection->fetchOne(
            'SELECT 1 FROM ' . self::TABLE_NAME . ' WHERE practitioner_uuid = ?',
            [$row->practitionerUuid],
        );

        if ($existing === false) {
            $this->connection->insert(
                self::TABLE_NAME,
                array_merge(['practitioner_uuid' => $row->practitionerUuid], $values),
                array_merge(['practitioner_uuid' => ParameterType::STRING], $types),
            );
            return;
        }

        $this->connection->update(
            self::TABLE_NAME,
            $values,
            ['practitioner_uuid' => $row->practitionerUuid],
            $types,
        );
    }

    /**
     * @return list<PractitionerSettings>
     */
    public function findEnabledPractitioners(): array
    {
        $rows = $this->connection->fetchAllAssociative(
            'SELECT practitioner_uuid, morning_prep_enabled, morning_prep_time_local, timezone, updated_at '
            . 'FROM ' . self::TABLE_NAME . ' WHERE morning_prep_enabled = 1',
        );
        return array_map(self::hydrate(...), $rows);
    }

    /**
     * @param array<string, mixed> $row
     */
    private static function hydrate(array $row): PractitionerSettings
    {
        $uuid = $row['practitioner_uuid'] ?? null;
        $time = $row['morning_prep_time_local'] ?? null;
        $tz = $row['timezone'] ?? null;
        $updated = $row['updated_at'] ?? null;
        $enabledRaw = $row['morning_prep_enabled'] ?? null;
        if (
            !is_string($uuid) || !is_string($time) || !is_string($tz) || !is_string($updated)
        ) {
            throw new \RuntimeException('agent_practitioner_settings row has unexpected shape');
        }

        return new PractitionerSettings(
            practitionerUuid: $uuid,
            morningPrepEnabled: self::toBool($enabledRaw),
            morningPrepTimeLocal: $time,
            timezone: $tz,
            updatedAt: new DateTimeImmutable($updated),
        );
    }

    /**
     * SQLite returns INTEGER 0/1; MariaDB BOOLEAN comes back as TINYINT
     * 0/1 too. Either way DBAL hands us an `int` once it's gone through
     * the driver. Tolerate the string form ('0'/'1') in case a future
     * driver normalises differently.
     */
    private static function toBool(mixed $raw): bool
    {
        if (is_int($raw)) {
            return $raw === 1;
        }
        if (is_bool($raw)) {
            return $raw;
        }
        if (is_string($raw)) {
            return $raw === '1' || $raw === 'true';
        }
        return false;
    }
}

<?php

/**
 * Pins the DataCategory ↔ SMART-scope mapping.
 *
 * Adding a new DataCategory case forces an exhaustive-match update to
 * {@see DataCategory::smartScope()}. This test is the second pin: it
 * asserts every case returns a non-empty scope string and that the
 * mapping is unique (no two categories share a scope).
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot;

use OpenEMR\Modules\ClinicalCopilot\Snapshot\DataCategory;
use PHPUnit\Framework\TestCase;

final class DataCategoryTest extends TestCase
{
    private const MODULE_SNAPSHOT_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Snapshot';

    public static function setUpBeforeClass(): void
    {
        require_once self::MODULE_SNAPSHOT_DIR . '/DataCategory.php';
    }

    public function testEveryCaseDeclaresANonEmptyScope(): void
    {
        foreach (DataCategory::cases() as $case) {
            $scope = $case->smartScope();
            self::assertNotSame('', $scope, "DataCategory::{$case->name} must declare a scope");
            self::assertStringStartsWith('user/', $scope, "{$case->name} scope must be a SMART user/* scope");
        }
    }

    public function testScopeMappingIsUnique(): void
    {
        $scopes = array_map(
            static fn(DataCategory $c): string => $c->smartScope(),
            DataCategory::cases(),
        );
        self::assertCount(
            count(array_unique($scopes)),
            $scopes,
            'every DataCategory must map to a distinct SMART scope',
        );
    }
}

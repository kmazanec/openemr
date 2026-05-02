<?php

/**
 * Isolated tests for the production ObservationServiceDataSource —
 * specifically the LIKE-pattern escape used to build the `result_text`
 * needle. Reaches into the production class statically; the surrounding
 * SQL and `QueryUtils::fetchRecords` are exercised in the integration
 * tests.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot\Adapter\Production;

use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\Production\ObservationServiceDataSource;
use PHPUnit\Framework\TestCase;

final class ObservationServiceDataSourceTest extends TestCase
{
    private const MODULE_ADAPTER_DIR = __DIR__
        . '/../../../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Snapshot/Adapter';

    public static function setUpBeforeClass(): void
    {
        require_once self::MODULE_ADAPTER_DIR . '/ObservationDataSource.php';
        require_once self::MODULE_ADAPTER_DIR . '/Production/RowAssertion.php';
        require_once self::MODULE_ADAPTER_DIR . '/Production/ObservationServiceDataSource.php';
    }

    public function testEscapeLeavesPlainAnalyteUntouched(): void
    {
        $this->assertSame(
            'Hemoglobin A1c',
            ObservationServiceDataSource::escapeLikePattern('Hemoglobin A1c'),
        );
    }

    public function testEscapeNeutralizesPercentWildcard(): void
    {
        // Without escaping `%` the LIKE needle becomes `%%%` and matches every
        // row — the precise privilege escalation this regression test pins.
        $this->assertSame('\\%', ObservationServiceDataSource::escapeLikePattern('%'));
    }

    public function testEscapeNeutralizesUnderscoreWildcard(): void
    {
        $this->assertSame('a\\_c', ObservationServiceDataSource::escapeLikePattern('a_c'));
    }

    public function testEscapeDoublesBackslashesBeforeAddingWildcardEscapes(): void
    {
        // Backslashes must be doubled first; otherwise our `\%` escape would
        // itself be re-escaped on the next pass over a value containing both.
        $this->assertSame(
            '\\\\\\%',
            ObservationServiceDataSource::escapeLikePattern('\\%'),
        );
    }
}

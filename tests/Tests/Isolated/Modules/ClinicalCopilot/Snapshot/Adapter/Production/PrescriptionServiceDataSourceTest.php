<?php

/**
 * Isolated test pinning the production PrescriptionServiceDataSource's
 * recency predicate. The semantic correctness of the SQL is exercised
 * end-to-end by the API integration tests; this file's job is to keep a
 * reviewer from accidentally reverting to the bare
 * `p.date_modified >= ?` form, which silently drops every inactive row
 * whose `date_modified` column is NULL.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot\Adapter\Production;

use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\Production\PrescriptionServiceDataSource;
use PHPUnit\Framework\TestCase;

final class PrescriptionServiceDataSourceTest extends TestCase
{
    private const MODULE_ADAPTER_DIR = __DIR__
        . '/../../../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Snapshot/Adapter';

    public static function setUpBeforeClass(): void
    {
        require_once self::MODULE_ADAPTER_DIR . '/PrescriptionDataSource.php';
        require_once self::MODULE_ADAPTER_DIR . '/Production/RowAssertion.php';
        require_once self::MODULE_ADAPTER_DIR . '/Production/PrescriptionServiceDataSource.php';
    }

    public function testRecencyPredicateCoalescesDateModifiedToDateAdded(): void
    {
        // Inactive rows with `date_modified IS NULL` (the default for
        // legacy inserts and the seed pipeline's markStopped() output)
        // must still be evaluated against `date_added`. The bare
        // `p.date_modified >= ?` form treats NULL as not-true and drops
        // those rows — see the Linnie/Amoxicillin incident in May 2026.
        $this->assertStringContainsString(
            'COALESCE(p.date_modified, p.date_added) >= ?',
            PrescriptionServiceDataSource::RECENT_QUERY_SQL,
        );
    }

    public function testRecencyPredicateStillKeepsActiveRowsRegardlessOfDate(): void
    {
        // Active rows must continue to surface even when the recency
        // window is short — the `active = 1 OR ...` short-circuit is
        // the load-bearing piece for "what is this patient currently
        // taking" and a refactor that drops it would silently truncate
        // the briefing.
        $this->assertStringContainsString(
            'p.active = 1 OR ',
            PrescriptionServiceDataSource::RECENT_QUERY_SQL,
        );
    }
}

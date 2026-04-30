<?php

/**
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\RequestLog;

use Doctrine\DBAL\Connection;
use OpenEMR\BC\Database;

/**
 * Single source of OpenEMR's DBAL connection for the module's recorders.
 *
 * OpenEMR's `OpenEMR\BC\Database::instance()->getDbalConnection()` is
 * marked `@deprecated` because the project plans to migrate to a DI
 * container someday. There is no non-deprecated path today —
 * `EventAuditLogger` and `Gacl` go through `DatabaseConnectionFactory`,
 * which carries the *same* deprecation. We isolate the call here so the
 * day OpenEMR ships a non-deprecated path, this one file changes.
 */
final class AgentDbalConnection
{
    public static function get(): Connection
    {
        return Database::instance()->getDbalConnection();
    }
}

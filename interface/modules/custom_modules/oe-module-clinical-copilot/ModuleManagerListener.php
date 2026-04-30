<?php

/**
 * Module Manager listener — wires the install/enable/disable lifecycle for
 * the Clinical Co-Pilot module on the Modules → Manage Modules page.
 *
 * The Module Manager calls hook methods on this class for each module
 * lifecycle action (`install`, `enable`, `disable`, `unregister`,
 * `help_requested`, etc.). The dispatch is `self::$methodName(...)` from a
 * `moduleManagerAction` defined in this concrete class, so PHP's normal
 * private-method visibility rules apply — child-class private methods
 * shadow the abstract parent's defaults at the `self::` call site.
 *
 * Crucially, OpenEMR's `EnableModule` only updates `mod_active`, never
 * `mod_ui_active`. The standard pattern (matching oe-module-dashboard-context)
 * is for the module's own listener to flip both flags via `setModuleState`
 * in the post-action hook so the UI state stays consistent.
 *
 * The Help (?) icon on the Manage Modules row is non-functional in
 * OpenEMR's installer JS — the post-action callback unconditionally
 * reloads the modules iframe, wiping any inline content the response
 * appended. We surface the module's documentation via the Settings cog
 * instead (see moduleConfig.php in this directory). The `help_requested`
 * hook below just returns "Success" so users don't see a "Help doesn't
 * exist" alert when they click the icon.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

use OpenEMR\Common\Database\QueryUtils;
use OpenEMR\Core\AbstractModuleActionListener;

class ModuleManagerListener extends AbstractModuleActionListener
{
    public function __construct()
    {
        parent::__construct();
    }

    public function moduleManagerAction($methodName, $modId, string $currentActionStatus = 'Success'): string
    {
        if (method_exists(self::class, $methodName)) {
            $result = self::$methodName($modId, $currentActionStatus);
            return is_string($result) ? $result : $currentActionStatus;
        }
        return $currentActionStatus;
    }

    public static function getModuleNamespace(): string
    {
        // Already registered by openemr.bootstrap.php; returning empty here
        // tells the Module Manager not to re-register.
        return '';
    }

    public static function initListenerSelf(): ModuleManagerListener
    {
        return new self();
    }

    /**
     * Post-install hook. Flip the module into the "configurable, not yet
     * enabled" UI state — `mod_active=0, mod_ui_active=1` matches
     * dashboard-context and is what the Manage Modules row template renders
     * with an "Enable" button + a config cog.
     *
     * @param int|string $modId
     */
    private function install($modId, string $currentActionStatus): string
    {
        self::setModuleState($modId, '0', '1');
        return $currentActionStatus;
    }

    /**
     * Post-enable hook. `EnableModule` in InstallerController only sets
     * `mod_active=1`; we have to clear `mod_ui_active` here so the row
     * template renders the "Disable" button instead of falling through to
     * "Enable" again. Without this, clicking Enable looks like a no-op
     * because the row never updates.
     *
     * @param int|string $modId
     */
    private function enable($modId, string $currentActionStatus): string
    {
        self::setModuleState($modId, '1', '0');
        return $currentActionStatus;
    }

    /**
     * Post-disable hook. Mirror of {@see enable()} — drop `mod_active` and
     * raise `mod_ui_active` so the row reverts to the configurable-but-off
     * state.
     *
     * @param int|string $modId
     */
    private function disable($modId, string $currentActionStatus): string
    {
        self::setModuleState($modId, '0', '1');
        return $currentActionStatus;
    }

    /**
     * Help-icon hook. Returns 'Success' to suppress the "Help doesn't exist"
     * alert that would otherwise fire — the installer JS reloads the modules
     * iframe immediately after this response, which makes inline help
     * unworkable. Documentation lives in moduleConfig.php (the Settings cog).
     *
     * @param int|string $modId
     */
    private function help_requested($modId, string $currentActionStatus): string
    {
        return 'Success';
    }

    /**
     * Update both `mod_active` and `mod_ui_active` for a module. Mirrors the
     * helper in oe-module-dashboard-context; kept private so it can only be
     * called from this listener's hooks.
     *
     * @param int|string $modId
     * @param int|string $active
     * @param int|string $uiActive
     */
    private static function setModuleState($modId, $active, $uiActive): void
    {
        QueryUtils::sqlStatementThrowException(
            'UPDATE `modules` SET `mod_active` = ?, `mod_ui_active` = ? WHERE `mod_id` = ? OR `mod_directory` = ?',
            [$active, $uiActive, $modId, $modId],
        );
    }
}

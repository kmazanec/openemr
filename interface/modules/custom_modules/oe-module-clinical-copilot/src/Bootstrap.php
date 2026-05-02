<?php

/**
 * Clinical Co-Pilot module Bootstrap.
 *
 * Subscribes the module's event listeners. Today:
 *   - `TwigEnvironmentEvent::EVENT_CREATED` — prepends the module's
 *     templates path so card templates render through the standard
 *     `TwigContainer` without polluting the upstream `/templates` tree.
 *   - `SectionEvent::EVENT_HANDLE` (primary section) — adds the
 *     "Open Co-Pilot" card to the patient summary screen, fulfilling the
 *     §3.4 patient-chart button entry point (PRESEARCH decision #5).
 *   - `ScriptFilterEvent::EVENT_NAME` (calendar day-view only) —
 *     injects the §5.4 schedule-annotations shim so the day view
 *     decorates appointments with cached briefing flags. Scoped to
 *     `pnuserapi.php` so the add-edit dialog and admin views are
 *     untouched.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot;

use OpenEMR\Common\Session\SessionWrapperFactory;
use OpenEMR\Core\OEGlobalsBag;
use OpenEMR\Events\Core\ScriptFilterEvent;
use OpenEMR\Events\Core\TwigEnvironmentEvent;
use OpenEMR\Events\Patient\Summary\Card\CardModel;
use OpenEMR\Events\Patient\Summary\Card\SectionEvent;
use Symfony\Component\EventDispatcher\EventDispatcherInterface;
use Twig\Loader\FilesystemLoader;

final readonly class Bootstrap
{
    public const MODULE_NAME = 'oe-module-clinical-copilot';

    public const MODULE_INSTALLATION_PATH = '/interface/modules/custom_modules/' . self::MODULE_NAME;

    /**
     * §5.4 day-view shim. The path is webroot-relative because that's
     * what `ScriptFilterEvent::setScripts()` expects — it round-trips
     * the value through `ModulesApplication::filterSafeLocalModuleFiles`
     * which strips the webroot, resolves to a real file under the
     * modules tree, and rejects anything outside.
     */
    private const SCHEDULE_SHIM_RELATIVE_PATH =
        self::MODULE_INSTALLATION_PATH . '/public/js/schedule-annotations.js';

    /**
     * The calendar day/week views (`pnuserapi.php`) are the only place
     * the shim should run. The add-edit dialog (`add_edit_event.php`)
     * and the admin pages (`pnadmin.php`) dispatch the same event but
     * have no appointment list to decorate.
     */
    private const SCHEDULE_SHIM_SCOPED_PAGE = 'pnuserapi.php';

    public function __construct(
        private EventDispatcherInterface $dispatcher,
    ) {
    }

    public function subscribeToEvents(): void
    {
        $this->dispatcher->addListener(
            TwigEnvironmentEvent::EVENT_CREATED,
            $this->registerTemplatesPath(...),
        );
        $this->dispatcher->addListener(
            SectionEvent::EVENT_HANDLE,
            $this->maybeAddCopilotCard(...),
        );
        $this->dispatcher->addListener(
            ScriptFilterEvent::EVENT_NAME,
            $this->maybeAddScheduleShim(...),
        );
    }

    public function registerTemplatesPath(TwigEnvironmentEvent $event): void
    {
        $loader = $event->getTwigEnvironment()->getLoader();
        if ($loader instanceof FilesystemLoader) {
            $loader->prependPath(__DIR__ . '/../templates');
        }
    }

    public function maybeAddScheduleShim(ScriptFilterEvent $event): void
    {
        if ($event->getPageName() !== self::SCHEDULE_SHIM_SCOPED_PAGE) {
            return;
        }

        // The webroot prefix matters: `setScripts()` filters every entry
        // through `ModulesApplication::filterSafeLocalModuleFiles`,
        // which strips the configured webroot before resolving against
        // the on-disk modules tree. Passing only the `/interface/...`
        // suffix works for standard installs (webroot = `''`) but
        // fails the realpath check the moment the install is mounted
        // under a nontrivial webroot — append it explicitly so the
        // filter sees the same string the browser would request.
        $webroot = OEGlobalsBag::getInstance()->getWebRoot();
        $shimUrl = $webroot . self::SCHEDULE_SHIM_RELATIVE_PATH;

        $existing = $event->getScripts();
        if (in_array($shimUrl, $existing, strict: true)) {
            return;
        }
        $event->setScripts([...$existing, $shimUrl]);
    }

    public function maybeAddCopilotCard(SectionEvent $event): void
    {
        if ($event->getSection() !== 'primary') {
            return;
        }

        $sessionPid = $this->resolveSessionPid();
        if ($sessionPid === null) {
            // The card has no patient to open; render nothing rather than
            // a broken link. demographics.php only fires the section
            // dispatch when a patient is in scope, so this branch is
            // primarily a guard for unexpected callers.
            return;
        }

        // The title is run through the `|text` Twig filter at render time,
        // and the card-body copy through `|xlt`, so we pass plain English
        // here. Calling xl() at listener-build time both adds a runtime DB
        // hit per page render and breaks isolated tests that don't have
        // sqlStatementNoLog() available.
        $panelPath = self::MODULE_INSTALLATION_PATH . '/public/panel.php';
        $card = new CardModel([
            'dispatcher' => $this->dispatcher,
            'identifier' => 'clinical_copilot_open',
            'title' => 'Clinical Co-Pilot',
            'acl' => ['patients', 'med'],
            'add' => false,
            'edit' => false,
            'collapse' => true,
            'initiallyCollapsed' => false,
            'templateFile' => 'card/copilot.html.twig',
            'templateVariables' => [
                'panelUrl' => $panelPath . '?pid=' . $sessionPid,
            ],
        ]);
        $event->addCard($card);
    }

    /**
     * Read the active patient pid. The summary page sets pid on both the
     * `$_SESSION` superglobal (via `setpid()`) and on the Symfony session
     * wrapper. We check the superglobal first because under PHP's native
     * session handler that's the authoritative source — the Symfony
     * session bag mirrors but does not always reflect updates that
     * happened outside its `set()` API. Falling back to the wrapper
     * handles installs that move to a non-native session backend later.
     */
    private function resolveSessionPid(): ?int
    {
        $raw = $_SESSION['pid'] ?? null;
        if ($raw === null) {
            $factory = SessionWrapperFactory::getInstance();
            if ($factory->isSessionActive()) {
                $raw = $factory->getActiveSession()->get('pid');
            }
        }
        if (!is_scalar($raw)) {
            return null;
        }
        $pid = (int) $raw;
        return $pid > 0 ? $pid : null;
    }
}

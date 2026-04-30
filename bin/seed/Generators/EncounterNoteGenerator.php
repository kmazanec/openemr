<?php

/**
 * EncounterNoteGenerator builds form_soap payloads (subjective / objective /
 * assessment / plan) for a single encounter. Notes are templated per
 * encounter reason and use token substitution to reference the patient's
 * actual chart data — recent BP, recent A1c, current meds — so UC1's
 * "any documented context" and UC2's "what was the rationale" drill-downs
 * have something coherent to cite.
 *
 * The generator returns the four SOAP strings; the caller writes the row
 * via direct SQL (no service-layer write API exists for form_soap).
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec <keith@devforward.com>
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Seed\Generators;

use Faker\Generator as Faker;

final readonly class EncounterNoteGenerator
{
    /**
     * Templates keyed by encounter reason. Each value is a list of
     * variants (3-4 per reason) so a multi-encounter chart isn't
     * suspiciously copy-pasted. Tokens like {bp}, {a1c}, {meds} are
     * substituted from the LongitudinalNoteContext supplied by the caller.
     *
     * Reasons not listed fall through to the GENERIC template.
     *
     * @var array<string, list<array{s: string, o: string, a: string, p: string}>>
     */
    private const TEMPLATES = [
        'Follow-up: hypertension' => [
            [
                's' => 'Pt reports good adherence to current antihypertensives, no side effects. Denies headache, chest pain, or vision changes.',
                'o' => 'BP {bp}, HR regular. {weight_summary}',
                'a' => 'Hypertension — {bp_assessment} on current regimen.',
                'p' => 'Continue current meds. Recheck BP in 3 months. Encouraged dietary sodium reduction.',
            ],
            [
                's' => 'Pt feels well. Reports occasional missed doses. No new symptoms.',
                'o' => 'BP {bp}. Otherwise unremarkable.',
                'a' => 'Essential hypertension, {bp_assessment}.',
                'p' => 'Reinforce med adherence. RTC 3 months for BP recheck.',
            ],
            [
                's' => 'Patient compliant with home BP monitoring; logs reviewed.',
                'o' => 'BP {bp}. {weight_summary}',
                'a' => 'HTN follow-up — {bp_assessment}.',
                'p' => 'Continue lisinopril. Lipid panel ordered. RTC 6 months or sooner if BP rises.',
            ],
        ],
        'Follow-up: diabetes type 2' => [
            [
                's' => 'Reports adherence to metformin. {a1c_subjective} Denies polyuria, polydipsia, blurred vision.',
                'o' => 'BP {bp}. Weight {weight}. Most recent A1c: {a1c}.',
                'a' => 'Type 2 diabetes — {a1c_assessment}.',
                'p' => '{a1c_plan} Foot exam unremarkable. RTC 3 months.',
            ],
            [
                's' => 'Pt notes home glucose readings averaging 130s in the morning. {a1c_subjective}',
                'o' => 'BP {bp}. A1c {a1c} (last drawn {a1c_date_relative}).',
                'a' => 'T2DM, {a1c_assessment}.',
                'p' => '{a1c_plan} Continue current dose of metformin. Lipid panel reviewed.',
            ],
            [
                's' => 'Reviewed glucose log. {a1c_subjective}',
                'o' => 'A1c {a1c}. BP {bp}.',
                'a' => 'Diabetes mellitus type 2, {a1c_assessment}.',
                'p' => '{a1c_plan}',
            ],
        ],
        'Lab review — abnormal results' => [
            [
                's' => 'Pt here to discuss recent lab results. {abnormal_summary}',
                'o' => 'No acute distress. BP {bp}.',
                'a' => 'Abnormal labs — {abnormal_assessment}.',
                'p' => 'Repeat labs in 6-8 weeks. Counseled patient on lifestyle measures.',
            ],
            [
                's' => 'Patient called in to ask about recent labs; visit scheduled to review.',
                'o' => '{abnormal_summary}',
                'a' => '{abnormal_assessment}.',
                'p' => 'Follow-up labs in 6-8 weeks. RTC after results available.',
            ],
        ],
        'Medication review' => [
            [
                's' => 'Quarterly med review. Pt tolerating current regimen. No new complaints.',
                'o' => 'Reviewed med list: {meds}.',
                'a' => 'Stable on current medications.',
                'p' => 'Continue all current meds. Refills sent.',
            ],
            [
                's' => 'Pt requesting refills on chronic meds. Reports good adherence.',
                'o' => 'Medication list reviewed: {meds}.',
                'a' => 'Chronic medication management — stable.',
                'p' => 'Refills sent. RTC 6 months.',
            ],
        ],
        'Annual wellness exam' => [
            [
                's' => 'Annual physical. Pt reports overall good health, no acute concerns.',
                'o' => 'BP {bp}, Weight {weight}, BMI normal range. Exam unremarkable.',
                'a' => 'Healthy adult, annual exam.',
                'p' => 'Continue current preventive care. Age-appropriate screening up to date. RTC 1 year.',
            ],
            [
                's' => 'Here for annual exam. No new symptoms.',
                'o' => 'BP {bp}. Weight {weight}. Physical exam within normal limits.',
                'a' => 'Routine adult preventive visit.',
                'p' => 'Labs ordered. RTC 1 year for next annual.',
            ],
        ],
    ];

    /**
     * Used when no encounter-reason-specific template matches.
     *
     * @var array{s: string, o: string, a: string, p: string}
     */
    private const GENERIC = [
        's' => 'Pt presents for {reason}. No new acute symptoms.',
        'o' => 'BP {bp}. Exam unremarkable.',
        'a' => 'Per chief complaint.',
        'p' => 'Continue current management. RTC as needed.',
    ];

    public function __construct(private Faker $faker)
    {
    }

    /**
     * Build a SOAP note for a regular (non-prescribing) encounter.
     *
     * @return array{subjective: string, objective: string, assessment: string, plan: string}
     */
    public function generate(string $reason, NoteContext $ctx): array
    {
        $template = $this->pickTemplate($reason);
        return [
            'subjective' => $this->substitute($template['s'], $reason, $ctx),
            'objective'  => $this->substitute($template['o'], $reason, $ctx),
            'assessment' => $this->substitute($template['a'], $reason, $ctx),
            'plan'       => $this->substitute($template['p'], $reason, $ctx),
        ];
    }

    /**
     * Build a SOAP note for the dedicated "prescribing visit" of a chronic
     * med — explicit so UC3's "when/why was X started" drill-down has
     * cite-able provenance in the chart.
     *
     * @return array{subjective: string, objective: string, assessment: string, plan: string}
     */
    public function generatePrescribingNote(string $drugName, string $indication, NoteContext $ctx): array
    {
        $shortDrug = $this->shortDrugName($drugName);
        return [
            'subjective' => "Patient evaluated for {$indication}. Discussed treatment options and risks/benefits of starting medication.",
            'objective'  => $this->substitute('BP {bp}. {weight_summary}', 'prescribing', $ctx),
            'assessment' => "{$indication} — initiating pharmacotherapy.",
            'plan'       => "Started {$shortDrug}. Patient counseled on side effects and adherence. RTC in 4-6 weeks for follow-up and re-evaluation.",
        ];
    }

    /**
     * @return array{s: string, o: string, a: string, p: string}
     */
    private function pickTemplate(string $reason): array
    {
        $variants = self::TEMPLATES[$reason] ?? null;
        if ($variants === null || $variants === []) {
            return self::GENERIC;
        }
        return $variants[array_rand($variants)];
    }

    private function substitute(string $template, string $reason, NoteContext $ctx): string
    {
        $tokens = [
            '{reason}'             => $reason,
            '{bp}'                 => $ctx->bp ?? 'within normal limits',
            '{weight}'             => $ctx->weight !== null ? "{$ctx->weight} lbs" : 'stable',
            '{a1c}'                => $ctx->a1c ?? 'pending',
            '{a1c_date_relative}'  => $ctx->a1cAgeRelative ?? 'recently',
            '{meds}'               => $ctx->medsCsv ?? 'no chronic medications',
            '{weight_summary}'     => $this->weightSummary($ctx),
            '{bp_assessment}'      => $this->bpAssessment($ctx),
            '{a1c_subjective}'     => $this->a1cSubjective($ctx),
            '{a1c_assessment}'     => $this->a1cAssessment($ctx),
            '{a1c_plan}'           => $this->a1cPlan($ctx),
            // (Other context-derived tokens above.)
            '{abnormal_summary}'   => $ctx->abnormalSummary ?? 'Reviewed recent results.',
            '{abnormal_assessment}' => $ctx->abnormalSummary !== null ? 'Discussed with patient' : 'Stable',
        ];
        return strtr($template, $tokens);
    }

    private function weightSummary(NoteContext $ctx): string
    {
        if ($ctx->weight === null) {
            return 'Weight stable.';
        }
        return "Weight {$ctx->weight} lbs, stable.";
    }

    private function bpAssessment(NoteContext $ctx): string
    {
        if ($ctx->bpSystolic === null) {
            return 'controlled';
        }
        if ($ctx->bpSystolic < 130) {
            return 'well controlled';
        }
        if ($ctx->bpSystolic < 140) {
            return 'at goal';
        }
        return 'above goal';
    }

    private function a1cSubjective(NoteContext $ctx): string
    {
        if ($ctx->a1cValue === null) {
            return '';
        }
        return $ctx->a1cValue >= 8.0
            ? 'Acknowledges recent A1c worsening.'
            : 'Reports stable energy and no hypoglycemic episodes.';
    }

    private function a1cAssessment(NoteContext $ctx): string
    {
        if ($ctx->a1cValue === null) {
            return 'controlled on current regimen';
        }
        if ($ctx->a1cValue >= 8.0) {
            return 'uncontrolled, A1c trending up';
        }
        if ($ctx->a1cValue >= 7.0) {
            return 'borderline control';
        }
        return 'well controlled';
    }

    private function a1cPlan(NoteContext $ctx): string
    {
        if ($ctx->a1cValue === null) {
            return 'Continue current regimen.';
        }
        if ($ctx->a1cValue >= 8.0) {
            return 'Discussed adding second-line agent. Will draw repeat A1c in 3 months.';
        }
        if ($ctx->a1cValue >= 7.5) {
            return 'Continue metformin at current dose; reinforce diet/exercise. Repeat A1c in 3 months.';
        }
        return 'Continue current regimen. Repeat A1c in 6 months.';
    }

    private function shortDrugName(string $fullName): string
    {
        // "Lisinopril 10 MG Oral Tablet" → "lisinopril 10 mg"
        $parts = preg_split('/\s+/', $fullName) ?: [];
        $kept = [];
        foreach ($parts as $p) {
            if (in_array(strtolower($p), ['oral', 'tablet', 'capsule', 'injector', 'pen'], true)) {
                break;
            }
            $kept[] = strtolower($p);
        }
        return implode(' ', $kept);
    }
}
